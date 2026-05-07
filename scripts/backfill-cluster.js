#!/usr/bin/env node
/* eslint-disable */
// On-chain wallet clustering — backfill + validation.
//
// Reads cached raw txs (from scripts/fetch-raw-txs.js) plus the events
// table, computes wallet_cluster_edges, and optionally cross-checks
// against Matrica ground truth.
//
// Pipeline:
//
//   1. Seed CIH-input-address blacklist with the known mint wallets
//      (mirrored from src/lib/cluster.ts MINT_WALLET_ADDRS — those
//      addresses sign multi-input mint distribution txs and would
//      falsely link every minter together).
//
//   2. PASS 1 (degree count): walk every CIH-eligible cached tx,
//      bumping a per-address counter of distinct co-input
//      counterparties. Skip txs that already contain a seed-blacklist
//      input (those are excluded wholesale).
//
//   3. AUTO-BLACKLIST: any address with degree >= AUTO_DEGREE_THRESHOLD
//      is treated as a multiplexer (exchange hot wallet, future
//      marketplace, mixer) and added to the blacklist for pass 2.
//      Persisted to cluster_blacklist with reason='auto-high-degree'.
//
//   4. PASS 2 (edge build): walk again with the full blacklist. Emit
//      CIH pairs into an in-memory accumulator. Then walk
//      `transferred` events with marketplace IS NULL to add
//      self-transfer-chain pairs.
//
//   5. Compute confidence per edge (src/lib/cluster.ts confidenceFromCounts)
//      and bulk INSERT/REPLACE into wallet_cluster_edges. Stamp
//      poll_state.cluster.last_cursor = MAX(events.id) so the
//      incremental tick resumes from there.
//
//   6. (--validate) Cross-check resulting clusters against Matrica
//      wallet_links ground truth. Reports precision (heuristic-linked
//      pairs that Matrica also links to one user), false positives
//      (heuristic links pairs Matrica disagrees on), and recall.
//
// CLI flags:
//   --cache-dir=PATH    Raw-tx cache. Default ~/.cache/omb-cluster/raw-txs.
//   --dry-run           Compute everything, write nothing.
//   --threshold=N       Confidence threshold (0-10000) for the report.
//                       Default 9500. The DB stores raw counts so this
//                       only changes which edges we summarize, not what
//                       we write.
//   --validate          Run Matrica cross-check at the end.
//   --verbose           Per-tx log lines.
//   --reset             DELETE wallet_cluster_edges + cluster_blacklist
//                       (auto rows only) before computing. Useful when
//                       iterating thresholds locally.

const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

// Constants mirrored from src/lib/cluster.ts. Keep in sync — the live
// poll tick imports them from cluster.ts directly; this script can't
// (Node CommonJS, no TS resolver), so duplicates with a comment ref.

// Maximum distinct input addresses for a tx to be CIH-eligible. Above
// this count the tx is presumed multi-party (CoinJoin, batch
// aggregation service, marketplace bulk sweep) and CIH is suppressed
// wholesale. Picked empirically from the OMB corpus: 30,545 of 37,341
// txs have exactly 2 distinct inputs (typical PSBT settlement + a
// minority of true self-consolidations); the >20 tail (32 txs) is
// dominated by mass-aggregation patterns including a single 493-input
// tx that ground the original auto-blacklist into uselessness.
const MAX_INPUTS_FOR_CIH = 20;

// Auto-detected "deposit / custodial / multi-source receiver" threshold:
// any address that's the new_owner of `transferred` events from this
// many or more distinct old_owners (across the whole corpus) is
// treated as an exchange / market-aggregator endpoint and excluded
// from BOTH CIH and self-transfer signals. The `transferred` table has
// 230 addresses meeting this bar (≥10 distinct senders); legitimate
// collectors top out around 1-2 distinct senders per receiver.
const MULTI_SOURCE_RECEIVER_THRESHOLD = 5;

const EVIDENCE_CAP = 10;
const MINT_WALLET_ADDRS = [
  'bc1pyl6g53k220rggaukyx929qnnxqw8vzt8xrfw88muw22pnwfvqjkqreeqpw',
  'bc1p53jarhva6eg4wggv7apndndger4y4gy9s6mf3gp0rttdzensu2nq3598ur',
  'bc1pg8jywvphzeyf9fg8tsac6jq7ft2dzz7pez720r6uanumn6lyayeshg46es',
  'bc1p4a29gzwlear4csc9sz6ll97j9yl7877tasy75evq8wm6r3admtqq3m72k0',
  'bc1q86ssqhk04chjah6kkuqw3fv5wjy7v2nflyg50t',
];

const DB_PATH = process.env.OMB_DB_PATH ?? path.resolve(__dirname, '..', 'tmp', 'dev.db');
const HOME =
  process.env.HOME || process.env.USERPROFILE || path.resolve(__dirname, '..', 'tmp');
const DEFAULT_CACHE_DIR = path.join(HOME, '.cache', 'omb-cluster', 'raw-txs');

const ARGS = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = {
    cacheDir: DEFAULT_CACHE_DIR,
    dryRun: false,
    threshold: 9500,
    validate: false,
    verbose: false,
    reset: false,
  };
  for (const a of argv) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--validate') out.validate = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--reset') out.reset = true;
    else if (a.startsWith('--cache-dir=')) {
      out.cacheDir = a.slice('--cache-dir='.length);
    } else if (a.startsWith('--threshold=')) {
      out.threshold = parseInt(a.slice('--threshold='.length), 10);
    } else {
      console.error(`[cluster-backfill] unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

function canonicalPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

// Confidence ladder — mirror of src/lib/cluster.ts confidenceFromCounts.
// Keep these two implementations in sync. Five signal types (cih, sx,
// cc, cp, pmx with round-trip subset) plus a cross-mechanism bonus
// when two or more distinct mechanisms fire on the same pair. B1 rule:
// pmx_bidir≥2 alone (no anchoring signal from another mechanism) caps
// at 0.95 — keeps the cross-trader pattern (active P2P traders) out of
// the identity-fold band. Tuning history in CLUSTERING.md §4.
function confidenceFromCounts(c) {
  let p = 0;
  if (c.cih_count >= 1) p = Math.max(p, 0.8);
  if (c.cih_count >= 2) p = Math.max(p, 0.95);
  if (c.cih_count >= 3) p = Math.max(p, 0.98);
  if (c.cih_count >= 5) p = Math.max(p, 0.99);

  const sxAb = c.self_xfer_ab || 0;
  const sxBa = c.self_xfer_ba || 0;
  const sxBidir = Math.min(sxAb, sxBa);
  const sxTotal = c.self_xfer_count || sxAb + sxBa;
  if (sxBidir >= 1) p = Math.max(p, 0.92);
  if (sxBidir >= 2) p = Math.max(p, 0.99);
  if (sxTotal >= 1) p = Math.max(p, 0.5);
  if (sxTotal >= 3) p = Math.max(p, 0.8);
  if (c.cih_count >= 1 && sxBidir >= 1) p = Math.max(p, 0.99);
  if (c.cih_count >= 1 && sxTotal >= 1) p = Math.max(p, 0.95);
  if (c.cih_count >= 2 && sxTotal >= 2) p = Math.max(p, 0.99);

  const cc = c.co_cons_count || 0;
  if (cc >= 1) p = Math.max(p, 0.80);
  if (cc >= 2) p = Math.max(p, 0.95);
  if (cc >= 3) p = Math.max(p, 0.98);
  if (cc >= 5) p = Math.max(p, 0.99);

  const cp = c.co_parent_count || 0;
  if (cp >= 1) p = Math.max(p, 0.80);
  if (cp >= 2) p = Math.max(p, 0.95);
  if (cp >= 3) p = Math.max(p, 0.98);

  const pmxAb = c.pmx_ab || 0;
  const pmxBa = c.pmx_ba || 0;
  const pmxBidir = Math.min(pmxAb, pmxBa);
  const pmxTotal = c.pmx_count || pmxAb + pmxBa;
  const pmxRt = c.pmx_rt_count || 0;
  if (pmxTotal >= 1) p = Math.max(p, 0.75);
  if (pmxTotal >= 3) p = Math.max(p, 0.90);
  if (pmxBidir >= 1) p = Math.max(p, 0.95);
  if (pmxBidir >= 2 && pmxRt >= 2) p = Math.max(p, 0.99);

  let indep = 0;
  if (c.cih_count >= 1) indep++;
  if (sxAb + sxBa >= 1) indep++;
  if (cc >= 1) indep++;
  if (cp >= 1) indep++;
  if (pmxTotal >= 1) indep++;
  if (indep >= 2) p = Math.max(p, 0.97);
  if (indep >= 3) p = Math.max(p, 0.99);

  // B1: pmx_bidir≥2 alone reaches 0.99 only when round-trip confirms
  // consolidation. Otherwise cap at 0.95.
  const onlyPmx = c.cih_count === 0 && (sxAb + sxBa) === 0 && cc === 0 && cp === 0;
  if (onlyPmx && pmxBidir >= 2 && pmxRt < 2 && p >= 0.99) p = 0.95;

  return Math.round(p * 10000);
}

function loadCachedTx(txid) {
  const p = path.join(ARGS.cacheDir, txid.slice(0, 2), `${txid}.json`);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function inputAddrsOf(tx) {
  const seen = new Set();
  for (const v of tx.vin || []) {
    const a = v && v.prevout && v.prevout.scriptPubKey && v.prevout.scriptPubKey.address;
    if (typeof a === 'string' && a.length > 0) seen.add(a);
  }
  return Array.from(seen);
}

// True if ANY input is signed with SIGHASH_SINGLE | SIGHASH_ANYONECANPAY
// (sighash byte 0x83). Schnorr sig with explicit sighash = 65 bytes
// (130 hex chars). This is the same shape used by Magisat / Magic Eden
// ACP PSBTs (marketplaceFingerprint.ts) — a strong "this tx is a multi-
// party settlement" signal that's true regardless of which marketplace
// (or none) brokered it.
function hasAcpInput(tx) {
  for (const v of tx.vin || []) {
    const w = (v && v.txinwitness) || [];
    if (!w.length) continue;
    const first = w[0];
    if (typeof first === 'string' && first.length === 130 && first.endsWith('83')) {
      return true;
    }
  }
  return false;
}

function appendEvidence(existing, next) {
  const out = existing.filter((e) => !(e.type === next.type && e.txid === next.txid));
  out.push(next);
  if (out.length > EVIDENCE_CAP) return out.slice(out.length - EVIDENCE_CAP);
  return out;
}

function bumpEdge(acc, from, to, evidence) {
  if (from === to) return;
  const [x, y] = canonicalPair(from, to);
  const key = `${x}|${y}`;
  const ts = evidence.ts || 0;
  let row = acc.get(key);
  if (!row) {
    row = {
      addr_a: x,
      addr_b: y,
      cih_count: 0,
      self_xfer_count: 0,
      self_xfer_ab: 0,
      self_xfer_ba: 0,
      evidence: [],
      first_seen_at: ts,
      last_seen_at: ts,
    };
    acc.set(key, row);
  }
  let stamped = evidence;
  if (evidence.type === 'self_xfer' && !evidence.direction) {
    stamped = { ...evidence, direction: from === x ? 'ab' : 'ba' };
  }
  const dup = row.evidence.some((e) => e.type === stamped.type && e.txid === stamped.txid);
  if (!dup) {
    if (stamped.type === 'cih') {
      row.cih_count += 1;
    } else {
      row.self_xfer_count += 1;
      if (stamped.direction === 'ab') row.self_xfer_ab += 1;
      else if (stamped.direction === 'ba') row.self_xfer_ba += 1;
    }
  }
  row.evidence = appendEvidence(row.evidence, stamped);
  if (ts) {
    if (!row.first_seen_at || ts < row.first_seen_at) row.first_seen_at = ts;
    if (ts > row.last_seen_at) row.last_seen_at = ts;
  }
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[cluster-backfill] OMB_DB_PATH not found: ${DB_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(ARGS.cacheDir)) {
    console.error(`[cluster-backfill] cache dir not found: ${ARGS.cacheDir}`);
    console.error('  run scripts/fetch-raw-txs.js first');
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // The live app uses busy_timeout=5000 — match it so our writes queue
  // instead of throwing SQLITE_BUSY when run against a live prod DB.
  db.pragma('busy_timeout = 10000');

  // Probe schema — refuse to run against a pre-v32 DB (v32 added the
  // co_cons_count / co_parent_count / pmx_* columns).
  const userVersion = db.pragma('user_version', { simple: true });
  if (userVersion < 32) {
    console.error(
      `[cluster-backfill] db user_version=${userVersion}, need ≥32. Run the app once to migrate.`
    );
    process.exit(1);
  }

  if (ARGS.reset && !ARGS.dryRun) {
    console.log('[cluster-backfill] --reset: dropping existing edges + auto blacklist');
    db.exec(`DELETE FROM wallet_cluster_edges`);
    db.prepare(`DELETE FROM cluster_blacklist WHERE reason = 'auto-high-degree'`).run();
  }

  // CIH-eligible txids: not sold, not loan-* (those PSBTs splice unrelated
  // parties). Also skip 'listed' which doesn't move ownership and 'inscribed'
  // which is single-party but cheap to include.
  const eligibleTypes = ['transferred', 'inscribed', 'mint'];
  const placeholders = eligibleTypes.map(() => '?').join(',');
  const txidRows = db
    .prepare(
      `SELECT DISTINCT txid FROM events WHERE event_type IN (${placeholders}) AND txid IS NOT NULL`
    )
    .all(...eligibleTypes);
  console.log(`[cluster-backfill] CIH-eligible distinct txids: ${txidRows.length}`);

  const seedBlacklist = new Set(MINT_WALLET_ADDRS);
  for (const r of db.prepare(`SELECT address FROM cluster_blacklist`).all()) {
    seedBlacklist.add(r.address);
  }

  // Pre-pass: cache distinct input addresses + ACP signature presence per
  // txid. Both feed the settlement gate.
  const inputsByTxid = new Map();
  let cacheMisses = 0;
  let acpTxs = 0;
  for (const { txid } of txidRows) {
    const tx = loadCachedTx(txid);
    if (!tx) {
      cacheMisses++;
      continue;
    }
    const acp = hasAcpInput(tx);
    if (acp) acpTxs++;
    inputsByTxid.set(txid, {
      addrs: inputAddrsOf(tx),
      acp,
      ts: tx.blocktime || 0,
    });
  }
  console.log(
    `[cluster-backfill] tx cache loaded: ${inputsByTxid.size} (misses=${cacheMisses}, ` +
      `acp_signed=${acpTxs})`
  );

  // PSBT-settlement detection. A tx is a multi-party settlement if EITHER:
  //   (a) Any input is SIGHASH_SINGLE | ANYONECANPAY signed. This is the
  //       universal ACP-PSBT shape — Magisat, Magic Eden ACP, and any
  //       off-fingerprint marketplace or OTC tool that uses ACP all qualify.
  //   (b) For a transferred event, new_owner literally appears in the
  //       inputs. Catches the rarer "buyer used the same address to fund
  //       and receive" pattern (mostly older or hand-rolled PSBTs).
  // CIH and self-transfer-chain are both suppressed when either rule fires
  // — both signals are unreliable across these settlement shapes.
  const psbtSettlementTxids = new Set();
  for (const [txid, entry] of inputsByTxid) {
    if (entry.acp) psbtSettlementTxids.add(txid);
  }
  const xferEvents = db
    .prepare(
      `SELECT txid, old_owner, new_owner, block_timestamp
         FROM events
        WHERE event_type = 'transferred'
          AND old_owner IS NOT NULL
          AND new_owner IS NOT NULL
          AND old_owner != new_owner`
    )
    .all();
  let newOwnerInInputs = 0;
  for (const e of xferEvents) {
    const entry = inputsByTxid.get(e.txid);
    if (!entry) continue;
    if (!psbtSettlementTxids.has(e.txid) && entry.addrs.includes(e.new_owner)) {
      psbtSettlementTxids.add(e.txid);
      newOwnerInInputs++;
    }
  }
  console.log(
    `[cluster-backfill] settlement txs: total=${psbtSettlementTxids.size} ` +
      `(acp=${acpTxs}, new_owner_in_inputs_only=${newOwnerInInputs})`
  );

  // Multi-source receiver detection. Addresses that receive `transferred`
  // events from many distinct senders are exchange / custodial / aggregator
  // endpoints — not peers in any human cluster. Skip CIH AND self-xfer
  // signals where either endpoint hits this threshold. Persisted to
  // cluster_blacklist with reason='auto-high-degree' so the live tick can
  // load + apply the same gate.
  const multiSourceReceivers = new Set();
  const recvRows = db
    .prepare(
      `SELECT new_owner, COUNT(DISTINCT old_owner) AS incoming_n
         FROM events
        WHERE event_type = 'transferred' AND marketplace IS NULL
          AND old_owner IS NOT NULL AND new_owner IS NOT NULL
          AND old_owner != new_owner
        GROUP BY new_owner
        HAVING incoming_n >= @t`
    )
    .all({ t: MULTI_SOURCE_RECEIVER_THRESHOLD });
  for (const r of recvRows) multiSourceReceivers.add(r.new_owner);
  console.log(
    `[cluster-backfill] multi-source receivers (≥${MULTI_SOURCE_RECEIVER_THRESHOLD} distinct senders): ${multiSourceReceivers.size}`
  );

  if (!ARGS.dryRun && multiSourceReceivers.size > 0) {
    const ins = db.prepare(
      `INSERT OR REPLACE INTO cluster_blacklist (address, reason, degree, added_at, notes)
       VALUES (?, 'auto-high-degree', ?, ?, ?)`
    );
    const now = Math.floor(Date.now() / 1000);
    db.transaction(() => {
      for (const r of recvRows) {
        ins.run(
          r.new_owner,
          r.incoming_n,
          now,
          `received transferred-events from ${r.incoming_n} distinct senders`
        );
      }
    })();
  }

  // Persist mint seed for the live tick.
  if (!ARGS.dryRun) {
    const ins = db.prepare(
      `INSERT OR IGNORE INTO cluster_blacklist (address, reason, degree, added_at, notes)
       VALUES (?, 'mint', NULL, ?, ?)`
    );
    const now = Math.floor(Date.now() / 1000);
    db.transaction(() => {
      for (const a of MINT_WALLET_ADDRS) ins.run(a, now, 'mint distribution wallet');
    })();
  }

  // Stage: build CIH edges. Per-tx gates:
  //   1. Skip if any input address is on the seed blacklist (mint wallets).
  //   2. Skip if txid is a PSBT-settlement.
  //   3. Skip if input-address count > MAX_INPUTS_FOR_CIH (CoinJoin / batch).
  const acc = new Map();
  let cihTxsKept = 0;
  let cihTxsSeedBlacklisted = 0;
  let cihTxsSettlementBlacklisted = 0;
  let cihTxsHighFanin = 0;
  let cihTxsSinglePartyOrEmpty = 0;

  let cihPairsSkippedReceiver = 0;
  for (const { txid } of txidRows) {
    const entry = inputsByTxid.get(txid);
    if (!entry) continue;
    const addrs = entry.addrs;
    if (addrs.some((a) => seedBlacklist.has(a))) {
      cihTxsSeedBlacklisted++;
      continue;
    }
    if (psbtSettlementTxids.has(txid)) {
      cihTxsSettlementBlacklisted++;
      continue;
    }
    if (addrs.length > MAX_INPUTS_FOR_CIH) {
      cihTxsHighFanin++;
      continue;
    }
    if (addrs.length < 2) {
      cihTxsSinglePartyOrEmpty++;
      continue;
    }
    cihTxsKept++;
    for (let i = 0; i < addrs.length; i++) {
      for (let j = i + 1; j < addrs.length; j++) {
        if (multiSourceReceivers.has(addrs[i]) || multiSourceReceivers.has(addrs[j])) {
          cihPairsSkippedReceiver++;
          continue;
        }
        bumpEdge(acc, addrs[i], addrs[j], { type: 'cih', txid, ts: entry.ts });
      }
    }
  }
  console.log(
    `[cluster-backfill] CIH pass: kept=${cihTxsKept} ` +
      `seed_blacklisted=${cihTxsSeedBlacklisted} settlement=${cihTxsSettlementBlacklisted} ` +
      `high_fanin=${cihTxsHighFanin} single_party=${cihTxsSinglePartyOrEmpty} ` +
      `pairs_skipped_receiver=${cihPairsSkippedReceiver}`
  );

  // Stage: self-transfer chain. Only emit for transferred events that are
  // (a) not marketplace-tagged, (b) not PSBT-settlements, (c) not involving
  // blacklisted addresses, (d) not involving multi-source receivers (which
  // are exchange / custodial endpoints, not peers in a cluster). The
  // settlement gate is the critical one — a cooperative-shape settlement
  // looks identical to a self-xfer at the events level but isn't.
  let selfXferKept = 0;
  let selfXferSettlement = 0;
  let selfXferBlacklisted = 0;
  let selfXferReceiver = 0;
  for (const e of xferEvents) {
    if (psbtSettlementTxids.has(e.txid)) {
      selfXferSettlement++;
      continue;
    }
    if (seedBlacklist.has(e.old_owner) || seedBlacklist.has(e.new_owner)) {
      selfXferBlacklisted++;
      continue;
    }
    if (
      multiSourceReceivers.has(e.old_owner) ||
      multiSourceReceivers.has(e.new_owner)
    ) {
      selfXferReceiver++;
      continue;
    }
    selfXferKept++;
    bumpEdge(acc, e.old_owner, e.new_owner, {
      type: 'self_xfer',
      txid: e.txid,
      ts: e.block_timestamp || 0,
    });
  }
  console.log(
    `[cluster-backfill] self-xfer pass: kept=${selfXferKept} ` +
      `settlement=${selfXferSettlement} blacklisted=${selfXferBlacklisted} ` +
      `multi_source_receiver=${selfXferReceiver}`
  );
  console.log(`[cluster-backfill] total edges: ${acc.size}`);

  // Stage 5: write edges.
  if (!ARGS.dryRun) {
    // CIH+sx-only upsert. cc/cp/pmx columns are populated by the v2
    // recompute pass at the end of this script; we leave them at their
    // defaults / preserved values here.
    const upsert = db.prepare(
      `INSERT INTO wallet_cluster_edges
         (addr_a, addr_b, confidence, cih_count, self_xfer_count, self_xfer_ab, self_xfer_ba, evidence_json, first_seen_at, last_seen_at)
       VALUES (@addr_a, @addr_b, @confidence, @cih_count, @self_xfer_count, @self_xfer_ab, @self_xfer_ba, @evidence_json, @first_seen_at, @last_seen_at)
       ON CONFLICT(addr_a, addr_b) DO UPDATE SET
         confidence      = excluded.confidence,
         cih_count       = excluded.cih_count,
         self_xfer_count = excluded.self_xfer_count,
         self_xfer_ab    = excluded.self_xfer_ab,
         self_xfer_ba    = excluded.self_xfer_ba,
         evidence_json   = excluded.evidence_json,
         first_seen_at   = MIN(wallet_cluster_edges.first_seen_at, excluded.first_seen_at),
         last_seen_at    = MAX(wallet_cluster_edges.last_seen_at, excluded.last_seen_at)`
    );
    db.transaction(() => {
      for (const row of acc.values()) {
        upsert.run({
          addr_a: row.addr_a,
          addr_b: row.addr_b,
          confidence: confidenceFromCounts({
            cih_count: row.cih_count,
            self_xfer_count: row.self_xfer_count,
            self_xfer_ab: row.self_xfer_ab,
            self_xfer_ba: row.self_xfer_ba,
          }),
          cih_count: row.cih_count,
          self_xfer_count: row.self_xfer_count,
          self_xfer_ab: row.self_xfer_ab,
          self_xfer_ba: row.self_xfer_ba,
          evidence_json: JSON.stringify(row.evidence),
          first_seen_at: row.first_seen_at || 0,
          last_seen_at: row.last_seen_at || 0,
        });
      }
    })();

    // Advance the live cursor to the current tip so the incremental tick
    // doesn't re-walk events we just covered.
    const maxIdRow = db.prepare(`SELECT MAX(id) AS id FROM events`).get();
    const maxId = maxIdRow && maxIdRow.id ? maxIdRow.id : 0;
    db.prepare(
      `UPDATE poll_state SET last_cursor = ?, last_run_at = ?, last_status = ?, last_event_count = ?
       WHERE stream = 'cluster' AND collection_slug = 'omb'`
    ).run(String(maxId), Math.floor(Date.now() / 1000), 'backfill-ok', acc.size);
    console.log(`[cluster-backfill] cursor set to events.id=${maxId}`);

    // Materialize cluster_anchors so leaderboards + holder aggregation
    // reflect the new edges immediately, without waiting for the next
    // live tick. Same logic as src/lib/clusterStore.ts:recomputeClusterAnchors.
    const anchorTableExists = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='cluster_anchors'`
      )
      .get();
    if (anchorTableExists) {
      const anchorStats = recomputeAnchorsForBackfill(db);
      console.log(
        `[cluster-backfill] cluster_anchors: ${anchorStats.components} components, ` +
          `${anchorStats.members} members, ${anchorStats.skipped_split_clusters} split clusters skipped`
      );
    } else {
      console.log(
        `[cluster-backfill] cluster_anchors table missing — run app once to apply v31 migration, then re-run backfill`
      );
    }
  }

  // Threshold report.
  let above = 0;
  let cihOnly = 0;
  let selfOnly = 0;
  let both = 0;
  for (const row of acc.values()) {
    const conf = confidenceFromCounts({
      cih_count: row.cih_count,
      self_xfer_count: row.self_xfer_count,
      self_xfer_ab: row.self_xfer_ab,
      self_xfer_ba: row.self_xfer_ba,
    });
    if (conf >= ARGS.threshold) {
      above++;
      if (row.cih_count > 0 && row.self_xfer_count > 0) both++;
      else if (row.cih_count > 0) cihOnly++;
      else selfOnly++;
    }
  }
  console.log(
    `[cluster-backfill] edges ≥ threshold ${ARGS.threshold}: ${above} ` +
      `(cih_only=${cihOnly}, self_only=${selfOnly}, both=${both})`
  );

  if (!ARGS.dryRun) {
    runV2Recompute(db);
  }

  if (ARGS.validate) runValidation(db, acc);

  db.close();
}

// Mirror of clusterStore.ts runClusterRecompute. Computes cc/cp/pmx/
// pmx_rt against the events table and writes to wallet_cluster_edges.
// Same algorithm, same tunables; keep in sync if you change one.
function runV2Recompute(db) {
  const t0 = Date.now();
  console.log(`[cluster-backfill] v2 recompute starting…`);
  const MONOG_FANOUT = 2;
  const MONOG_FANIN = 2;
  const MSR_TH = 5;
  const COCONS_MIN = 2;
  const PARENT_MIN = 2;
  const PERSONAL_BIDIR = 3;
  const PERSONAL_RETENTION = 0.4;

  // HARD blacklist only — exclude auto-high-degree (those ARE the MSRs
  // we want to evaluate this run). Mirror of loadHardBlacklist in
  // src/lib/clusterStore.ts.
  const blacklist = new Set(MINT_WALLET_ADDRS);
  for (const r of db.prepare(
    `SELECT address FROM cluster_blacklist WHERE reason != 'auto-high-degree'`
  ).all()) {
    blacklist.add(r.address);
  }

  const xfer = db.prepare(
    `SELECT id, inscription_number, old_owner, new_owner FROM events
      WHERE event_type='transferred' AND marketplace IS NULL
        AND old_owner IS NOT NULL AND new_owner IS NOT NULL AND old_owner != new_owner
      ORDER BY id ASC`
  ).all();

  // Per-inscription timeline for round-trip detection.
  const inscTimeline = new Map();
  for (const r of db.prepare(
    `SELECT id, inscription_number, new_owner FROM events
      WHERE new_owner IS NOT NULL ORDER BY id ASC`
  ).all()) {
    let arr = inscTimeline.get(r.inscription_number);
    if (!arr) { arr = []; inscTimeline.set(r.inscription_number, arr); }
    arr.push({ id: r.id, new_owner: r.new_owner });
  }
  function isRoundTrip(insc, beforeId, who) {
    const arr = inscTimeline.get(insc);
    if (!arr) return false;
    for (const ev of arr) {
      if (ev.id >= beforeId) return false;
      if (ev.new_owner === who) return true;
    }
    return false;
  }

  const senderRecv = new Map();
  const recvSender = new Map();
  for (const r of xfer) {
    if (blacklist.has(r.old_owner) || blacklist.has(r.new_owner)) continue;
    let s = senderRecv.get(r.old_owner);
    if (!s) { s = new Set(); senderRecv.set(r.old_owner, s); } s.add(r.new_owner);
    let t = recvSender.get(r.new_owner);
    if (!t) { t = new Set(); recvSender.set(r.new_owner, t); } t.add(r.old_owner);
  }
  const msrSet = new Set();
  for (const [a, set] of recvSender) if (set.size >= MSR_TH) msrSet.add(a);

  const personalMsr = new Set();
  const retStmt = db.prepare(
    `WITH recv AS (
       SELECT DISTINCT inscription_number FROM events
        WHERE event_type='transferred' AND marketplace IS NULL
          AND old_owner != new_owner AND new_owner = ?
     )
     SELECT COUNT(*) AS recv_n,
       SUM(CASE WHEN i.effective_owner=? THEN 1 ELSE 0 END) AS held_n
       FROM recv r JOIN inscriptions i USING(inscription_number)`
  );
  for (const c of msrSet) {
    const senders = recvSender.get(c) || new Set();
    let bidir = 0;
    const out = senderRecv.get(c) || new Set();
    for (const s of senders) if (out.has(s)) bidir++;
    if (bidir >= PERSONAL_BIDIR) { personalMsr.add(c); continue; }
    const ret = retStmt.get(c, c);
    if (ret.recv_n >= 5 && ret.held_n / ret.recv_n >= PERSONAL_RETENTION) {
      personalMsr.add(c);
    }
  }
  console.log(`[cluster-backfill] v2 recompute: msrs=${msrSet.size} personal_msrs=${personalMsr.size}`);

  function canon(a, b) { return a < b ? [a, b] : [b, a]; }
  const v2 = new Map();
  function getRow(a, b) {
    if (a === b) return null;
    const [x, y] = canon(a, b);
    const key = `${x}|${y}`;
    let r = v2.get(key);
    if (!r) {
      r = { addr_a: x, addr_b: y, cc: new Set(), cp: new Set(),
            pmx: 0, pmx_ab: 0, pmx_ba: 0, pmx_rt: 0, pmx_rt_ab: 0, pmx_rt_ba: 0 };
      v2.set(key, r);
    }
    return r;
  }

  let ccBumps = 0, cpBumps = 0;
  for (const [c, senders] of recvSender) {
    if (senders.size < COCONS_MIN || blacklist.has(c)) continue;
    const monog = [];
    for (const s of senders) {
      if (s === c || blacklist.has(s)) continue;
      const fan = (senderRecv.get(s) || new Set()).size;
      if (fan >= 1 && fan <= MONOG_FANOUT) monog.push(s);
    }
    if (monog.length < COCONS_MIN) continue;
    for (let i = 0; i < monog.length; i++) {
      for (let j = i + 1; j < monog.length; j++) {
        const r = getRow(monog[i], monog[j]); if (!r) continue;
        r.cc.add(c); ccBumps++;
      }
      const r2 = getRow(monog[i], c); if (r2) r2.cc.add(c);
    }
  }
  for (const [p, recips] of senderRecv) {
    if (recips.size < PARENT_MIN || blacklist.has(p)) continue;
    if (msrSet.has(p) && !personalMsr.has(p)) continue;
    const monog = [];
    for (const r of recips) {
      if (r === p || blacklist.has(r)) continue;
      const fan = (recvSender.get(r) || new Set()).size;
      if (fan >= 1 && fan <= MONOG_FANIN) monog.push(r);
    }
    if (monog.length < PARENT_MIN) continue;
    for (let i = 0; i < monog.length; i++) {
      for (let j = i + 1; j < monog.length; j++) {
        const r = getRow(monog[i], monog[j]); if (!r) continue;
        r.cp.add(p); cpBumps++;
      }
    }
  }

  let pmxN = 0, pmxRtN = 0;
  for (const e of xfer) {
    if (blacklist.has(e.old_owner) || blacklist.has(e.new_owner)) continue;
    if (!personalMsr.has(e.old_owner) && !personalMsr.has(e.new_owner)) continue;
    const r = getRow(e.old_owner, e.new_owner); if (!r) continue;
    r.pmx += 1; pmxN++;
    const isAb = e.old_owner === r.addr_a;
    if (isAb) r.pmx_ab += 1; else r.pmx_ba += 1;
    if (isRoundTrip(e.inscription_number, e.id, e.new_owner)) {
      r.pmx_rt += 1; pmxRtN++;
      if (isAb) r.pmx_rt_ab += 1; else r.pmx_rt_ba += 1;
    }
  }
  console.log(`[cluster-backfill] v2 recompute: cc=${ccBumps} cp=${cpBumps} pmx=${pmxN} pmx_rt=${pmxRtN}`);

  // Reset v2 columns + recompute confidence for ALL existing rows
  // (zeroes any stale v2 evidence so this is fully idempotent).
  db.exec(
    `UPDATE wallet_cluster_edges
        SET co_cons_count=0, co_parent_count=0,
            pmx_count=0, pmx_ab=0, pmx_ba=0,
            pmx_rt_count=0, pmx_rt_ab=0, pmx_rt_ba=0`
  );
  const recompConf = db.prepare(
    `UPDATE wallet_cluster_edges SET confidence=? WHERE addr_a=? AND addr_b=?`
  );
  db.transaction(() => {
    for (const row of db.prepare(
      `SELECT addr_a, addr_b, cih_count, self_xfer_count, self_xfer_ab, self_xfer_ba
         FROM wallet_cluster_edges`
    ).all()) {
      recompConf.run(confidenceFromCounts(row), row.addr_a, row.addr_b);
    }
  })();

  // Apply v2 — UPSERT cc/cp/pmx, recompute confidence.
  const upsertV2 = db.prepare(
    `INSERT INTO wallet_cluster_edges
       (addr_a, addr_b, confidence, cih_count, self_xfer_count,
        self_xfer_ab, self_xfer_ba, evidence_json, first_seen_at, last_seen_at,
        co_cons_count, co_parent_count,
        pmx_count, pmx_ab, pmx_ba,
        pmx_rt_count, pmx_rt_ab, pmx_rt_ba)
     VALUES (@addr_a, @addr_b, @confidence, 0, 0, 0, 0, '[]', unixepoch(), unixepoch(),
             @cc, @cp, @pmx, @pmx_ab, @pmx_ba, @pmx_rt, @pmx_rt_ab, @pmx_rt_ba)
     ON CONFLICT(addr_a, addr_b) DO UPDATE SET
       confidence      = excluded.confidence,
       co_cons_count   = excluded.co_cons_count,
       co_parent_count = excluded.co_parent_count,
       pmx_count       = excluded.pmx_count,
       pmx_ab          = excluded.pmx_ab,
       pmx_ba          = excluded.pmx_ba,
       pmx_rt_count    = excluded.pmx_rt_count,
       pmx_rt_ab       = excluded.pmx_rt_ab,
       pmx_rt_ba       = excluded.pmx_rt_ba`
  );
  const v1Stmt = db.prepare(
    `SELECT cih_count, self_xfer_count, self_xfer_ab, self_xfer_ba
       FROM wallet_cluster_edges WHERE addr_a=? AND addr_b=?`
  );
  let written = 0;
  db.transaction(() => {
    for (const r of v2.values()) {
      const v1 = v1Stmt.get(r.addr_a, r.addr_b) || {};
      const conf = confidenceFromCounts({
        cih_count: v1.cih_count || 0,
        self_xfer_count: v1.self_xfer_count || 0,
        self_xfer_ab: v1.self_xfer_ab || 0,
        self_xfer_ba: v1.self_xfer_ba || 0,
        co_cons_count: r.cc.size,
        co_parent_count: r.cp.size,
        pmx_count: r.pmx,
        pmx_ab: r.pmx_ab,
        pmx_ba: r.pmx_ba,
        pmx_rt_count: r.pmx_rt,
        pmx_rt_ab: r.pmx_rt_ab,
        pmx_rt_ba: r.pmx_rt_ba,
      });
      upsertV2.run({
        addr_a: r.addr_a, addr_b: r.addr_b, confidence: conf,
        cc: r.cc.size, cp: r.cp.size,
        pmx: r.pmx, pmx_ab: r.pmx_ab, pmx_ba: r.pmx_ba,
        pmx_rt: r.pmx_rt, pmx_rt_ab: r.pmx_rt_ab, pmx_rt_ba: r.pmx_rt_ba,
      });
      written++;
    }
  })();
  console.log(`[cluster-backfill] v2 recompute: edges_written=${written} ms=${Date.now() - t0}`);

  // Re-run cluster_anchors so the fold reflects the new confidence.
  if (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='cluster_anchors'`).get()) {
    const stats = recomputeAnchorsForBackfill(db);
    console.log(`[cluster-backfill] cluster_anchors after v2: ${stats.components} components, ${stats.members} members, ${stats.skipped_split_clusters} split skipped`);
  }
}

function confOf(row) {
  return confidenceFromCounts({
    cih_count: row.cih_count,
    self_xfer_count: row.self_xfer_count,
    self_xfer_ab: row.self_xfer_ab,
    self_xfer_ba: row.self_xfer_ba,
  });
}

// Auto-shell detection. Per CLAUDE.md / src/lib/matrica.ts:
// when a wallet is queried but the user has not claimed it on Matrica,
// the API returns a synthetic user with username = `<wallet_addr>` +
// suffix and the default pfp. These rows aren't real human-claimed
// identities, so for validation purposes they're closer to "no profile"
// than "a different user." Detection: username starts with bc1/0x or is
// long enough to look like an address.
function isAutoShellUsername(username) {
  if (!username) return true;
  if (/^bc1[a-z0-9]{20,}/i.test(username)) return true;
  if (/^0x[a-fA-F0-9]{40}/.test(username)) return true;
  return false;
}

function runValidation(db, acc) {
  console.log(`\n[cluster-backfill] === VALIDATION (Matrica cross-check) ===`);
  const links = db
    .prepare(
      `SELECT wl.wallet_addr, wl.matrica_user_id, mu.username
         FROM wallet_links wl
         LEFT JOIN matrica_users mu ON mu.user_id = wl.matrica_user_id
        WHERE wl.matrica_user_id IS NOT NULL`
    )
    .all();
  const walletToUser = new Map();
  const userToWallets = new Map();
  const autoShellUsers = new Set();
  let autoShellWallets = 0;
  for (const r of links) {
    walletToUser.set(r.wallet_addr, r.matrica_user_id);
    let s = userToWallets.get(r.matrica_user_id);
    if (!s) {
      s = [];
      userToWallets.set(r.matrica_user_id, s);
    }
    s.push(r.wallet_addr);
    if (isAutoShellUsername(r.username)) {
      autoShellUsers.add(r.matrica_user_id);
      autoShellWallets++;
    }
  }
  console.log(
    `[validate] Matrica linked wallets: ${links.length} ` +
      `(${autoShellWallets} auto-shells / ${links.length - autoShellWallets} claimed), ` +
      `distinct users: ${userToWallets.size}`
  );

  // Reclassification: auto-shell-vs-claimed pairs are NOT real Matrica
  // disagreements (the auto-shell is just "wallet not claimed yet" —
  // Matrica has no opinion on whether it's the same human as the
  // claimed account). We treat them as `unknown` rather than `fp`.
  // Pairs where BOTH endpoints have claimed (real-username) profiles
  // and Matrica says different users — that's a real disagreement.
  const thresholds = [7000, 8000, 8500, 9000, 9500, 9700, 9800, 9900];
  for (const th of thresholds) {
    let tp = 0;
    let fp = 0;
    let autoshell = 0;
    let unk = 0;
    let pairs = 0;
    for (const row of acc.values()) {
      if (confOf(row) < th) continue;
      pairs++;
      const ua = walletToUser.get(row.addr_a);
      const ub = walletToUser.get(row.addr_b);
      if (ua && ub) {
        if (ua === ub) {
          tp++;
        } else if (autoShellUsers.has(ua) || autoShellUsers.has(ub)) {
          autoshell++;
        } else {
          fp++;
        }
      } else {
        unk++;
      }
    }
    const known = tp + fp;
    const precision = known === 0 ? null : tp / known;
    console.log(
      `[validate] threshold=${th}: pairs=${pairs} tp=${tp} fp=${fp} ` +
        `autoshell=${autoshell} unk=${unk}` +
        (precision !== null ? ` precision=${(precision * 100).toFixed(2)}%` : '')
    );
  }

  // Recall against Matrica multi-wallet users.
  const TH = ARGS.threshold;
  const parent = new Map();
  function find(x) {
    let p = parent.get(x);
    if (p === undefined) {
      parent.set(x, x);
      return x;
    }
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (const row of acc.values()) {
    if (confOf(row) >= TH) union(row.addr_a, row.addr_b);
  }
  let multiWalletUsers = 0;
  let recovered = 0;
  let totalPairs = 0;
  let recoveredPairs = 0;
  for (const [, wallets] of userToWallets) {
    if (wallets.length < 2) continue;
    multiWalletUsers++;
    let userPairs = 0;
    let userRecovered = 0;
    for (let i = 0; i < wallets.length; i++) {
      for (let j = i + 1; j < wallets.length; j++) {
        userPairs++;
        if (find(wallets[i]) === find(wallets[j])) userRecovered++;
      }
    }
    if (userRecovered > 0) recovered++;
    totalPairs += userPairs;
    recoveredPairs += userRecovered;
  }
  console.log(
    `[validate] recall @ threshold=${TH}: multi-wallet users=${multiWalletUsers} ` +
      `users w/ ≥1 pair recovered=${recovered} ` +
      `pairwise recall=${totalPairs ? ((recoveredPairs / totalPairs) * 100).toFixed(2) + '%' : 'n/a'} ` +
      `(${recoveredPairs}/${totalPairs})`
  );

  // Audit ALL false-positive pairs at thresholds 9700, 9800, 9900 — fetch
  // Matrica display info for both endpoints so the operator can eyeball
  // whether the "two distinct users" might actually be one human with
  // multiple Matrica accounts. Common giveaways: same/similar usernames,
  // same avatar URL, same display name.
  const muRows = db
    .prepare(`SELECT user_id, username, avatar_url FROM matrica_users`)
    .all();
  const userInfo = new Map();
  for (const r of muRows) userInfo.set(r.user_id, r);

  for (const auditTh of [9700, 9800, 9900]) {
    const real = [];
    const shell = [];
    for (const row of acc.values()) {
      const conf = confOf(row);
      if (conf < auditTh) continue;
      const ua = walletToUser.get(row.addr_a);
      const ub = walletToUser.get(row.addr_b);
      if (!ua || !ub || ua === ub) continue;
      const isShell = autoShellUsers.has(ua) || autoShellUsers.has(ub);
      const entry = { row, ua, ub, conf };
      if (isShell) shell.push(entry);
      else real.push(entry);
    }
    console.log(
      `\n[audit] threshold=${auditTh}: ` +
        `${real.length} REAL Matrica-different-user pairs, ` +
        `${shell.length} auto-shell pairs (excluded from FP count).`
    );
    if (real.length === 0 && shell.length === 0) continue;
    const dump = (label, list) => {
      if (list.length === 0) return;
      console.log(`  ── ${label} (${list.length}):`);
      list.sort((a, b) => b.conf - a.conf);
      for (const fp of list) {
        const uA = userInfo.get(fp.ua) || {};
        const uB = userInfo.get(fp.ub) || {};
        const nameA = uA.username || '(no username)';
        const nameB = uB.username || '(no username)';
        const sameAvatar =
          uA.avatar_url && uB.avatar_url && uA.avatar_url === uB.avatar_url
            ? ' AVATAR=SAME'
            : '';
        const shellMark =
          autoShellUsers.has(fp.ua)
            ? ' [A=shell]'
            : autoShellUsers.has(fp.ub)
              ? ' [B=shell]'
              : '';
        console.log(
          `    conf=${fp.conf} cih=${fp.row.cih_count} sx=${fp.row.self_xfer_ab}/${fp.row.self_xfer_ba}` +
            `   A: "${nameA.slice(0, 24)}" (${fp.row.addr_a.slice(0, 18)}…)` +
            `   B: "${nameB.slice(0, 24)}" (${fp.row.addr_b.slice(0, 18)}…)${shellMark}${sameAvatar}`
        );
      }
    };
    dump('REAL disagreements', real);
    dump('auto-shell pairings (heuristic likely correct, Matrica unclaimed)', shell);
  }
}

/**
 * Rebuild cluster_anchors from wallet_cluster_edges at IDENTITY_FOLD_THRESHOLD
 * (9900 — keep in sync with src/lib/cluster.ts). Mirror of
 * src/lib/clusterStore.ts:recomputeClusterAnchors so the script is
 * self-contained (CLI runs against prod without needing the Next.js
 * build artifacts).
 */
function recomputeAnchorsForBackfill(db) {
  const IDENTITY_FOLD = 9900;
  const edges = db
    .prepare(
      `SELECT addr_a, addr_b FROM wallet_cluster_edges WHERE confidence >= ?`
    )
    .all(IDENTITY_FOLD);

  const parent = new Map();
  const findRoot = (x) => {
    let p = parent.get(x);
    if (p === undefined) {
      parent.set(x, x);
      return x;
    }
    if (p === x) return x;
    const r = findRoot(p);
    parent.set(x, r);
    return r;
  };
  const unionAB = (a, b) => {
    const ra = findRoot(a);
    const rb = findRoot(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const e of edges) unionAB(e.addr_a, e.addr_b);

  const components = new Map();
  for (const node of parent.keys()) {
    const r = findRoot(node);
    let arr = components.get(r);
    if (!arr) {
      arr = [];
      components.set(r, arr);
    }
    arr.push(node);
  }

  const allNodes = [];
  for (const m of components.values()) allNodes.push(...m);
  const matricaByAddr = new Map();
  if (allNodes.length > 0) {
    const placeholders = allNodes.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT wallet_addr, matrica_user_id FROM wallet_links
          WHERE matrica_user_id IS NOT NULL AND wallet_addr IN (${placeholders})`
      )
      .all(...allNodes);
    for (const r of rows) matricaByAddr.set(r.wallet_addr, r.matrica_user_id);
  }

  const insertAnchor = db.prepare(
    `INSERT INTO cluster_anchors
       (wallet_addr, anchor_id, matrica_user_id, cluster_size, computed_at)
     VALUES (?, ?, ?, ?, unixepoch())`
  );
  let componentCount = 0;
  let memberCount = 0;
  let skipped = 0;
  const apply = db.transaction(() => {
    db.exec(`DELETE FROM cluster_anchors`);
    for (const members of components.values()) {
      if (members.length < 2) continue;
      const matricaIds = new Set();
      for (const m of members) {
        const mid = matricaByAddr.get(m);
        if (mid) matricaIds.add(mid);
      }
      if (matricaIds.size > 1) {
        skipped++;
        continue;
      }
      const matricaId = matricaIds.size === 1 ? Array.from(matricaIds)[0] : null;
      const anchorId = matricaId !== null ? matricaId : members.slice().sort()[0];
      componentCount++;
      for (const wallet of members) {
        insertAnchor.run(wallet, anchorId, matricaId, members.length);
        memberCount++;
      }
    }
  });
  apply();
  return {
    components: componentCount,
    members: memberCount,
    skipped_split_clusters: skipped,
  };
}

main().catch((err) => {
  console.error('[cluster-backfill] fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
});
