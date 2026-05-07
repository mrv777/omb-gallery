import 'server-only';

import type { Statement } from 'better-sqlite3';
import { getDb } from './db';
import { bitcoindConfigured, getRawTransaction } from './bitcoind';
import {
  appendEvidence,
  bumpEdge,
  canonicalPair,
  collectInputAddresses,
  confidenceFromCounts,
  edgeKey,
  hasAcpInput,
  isCrossTraderEdge,
  IDENTITY_FOLD_THRESHOLD,
  MAX_INPUTS_FOR_CIH,
  MINT_WALLET_ADDRS,
  MULTI_SOURCE_RECEIVER_THRESHOLD,
  COCONS_MIN_DEGREE,
  MONOG_FANIN_MAX,
  MONOG_FANOUT_MAX,
  PARENT_FANOUT_MIN,
  PERSONAL_MSR_BIDIR_MIN,
  PERSONAL_MSR_RETENTION_MIN,
  UnionFind,
  type EdgeAcc,
  type EvidenceItem,
} from './cluster';
import { log } from './log';

const STREAM = 'cluster';
const COLLECTION = 'omb';

// Per-tick budget: events to walk for CIH (we fetch a raw tx per event).
// Sized to keep wallclock under 30s at prod RPC latency. The cluster mode
// is the LAST step in `auto`, so the global tick budget bounds us.
const PER_TICK_LIMIT = 200;
const RPC_CONCURRENCY = 8;

// Lag the cursor behind by this many seconds so satflow + loans + the
// fingerprint taggers have a chance to reclassify an event before we
// take it as CIH-eligible. A 'transferred' row that becomes 'sold' an
// hour later would otherwise leave a stale edge derived from a marketplace
// PSBT — which is exactly the kind of false-positive this delay prevents.
const SETTLEMENT_DELAY_SEC = 30 * 60;

type TickResult = {
  mode: 'cluster';
  scanned: number;
  edges_touched: number;
  cursor_advanced: boolean;
  duration_ms: number;
  skipped?: 'not-configured' | 'not-bootstrapped';
  error?: string;
};

let cached: {
  selectState: Statement;
  selectMaxId: Statement;
  selectCandidates: Statement;
  selectBlacklist: Statement;
  upsertBlacklist: Statement;
  selectMultiSourceReceivers: Statement;
  selectEdge: Statement;
  upsertEdge: Statement;
  updateState: Statement;
} | null = null;

function stmts() {
  if (cached) return cached;
  const db = getDb();
  cached = {
    selectState: db.prepare(
      `SELECT last_cursor FROM poll_state WHERE stream = ? AND collection_slug = ?`
    ),
    selectMaxId: db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM events`),
    // CIH-eligible types only — sold + loan-* are PSBT-multiplexed and
    // excluded by design. created_at gate gives reclassifiers a window.
    selectCandidates: db.prepare(
      `SELECT id, txid, event_type, old_owner, new_owner, marketplace, block_timestamp
         FROM events
        WHERE id > @cursor
          AND id <= @upper
          AND event_type IN ('transferred','inscribed','mint')
          AND created_at < unixepoch() - @delay
        ORDER BY id ASC
        LIMIT @lim`
    ),
    selectBlacklist: db.prepare(`SELECT address FROM cluster_blacklist`),
    upsertBlacklist: db.prepare(
      `INSERT OR IGNORE INTO cluster_blacklist (address, reason, degree, added_at, notes)
       VALUES (?, 'mint', NULL, unixepoch(), ?)`
    ),
    // Recompute multi-source receivers each tick — cheap (groups by
    // new_owner over `transferred` rows, indexed) and lets new exchange
    // / custodian endpoints get caught without a separate backfill.
    selectMultiSourceReceivers: db.prepare(
      `SELECT new_owner
         FROM events
        WHERE event_type = 'transferred' AND marketplace IS NULL
          AND old_owner IS NOT NULL AND new_owner IS NOT NULL
          AND old_owner != new_owner
        GROUP BY new_owner
       HAVING COUNT(DISTINCT old_owner) >= @t`
    ),
    selectEdge: db.prepare(
      `SELECT cih_count, self_xfer_count, self_xfer_ab, self_xfer_ba,
              co_cons_count, co_parent_count,
              pmx_count, pmx_ab, pmx_ba,
              pmx_rt_count, pmx_rt_ab, pmx_rt_ba,
              evidence_json, first_seen_at, last_seen_at
         FROM wallet_cluster_edges WHERE addr_a = ? AND addr_b = ?`
    ),
    // Live tick UPSERT — touches v1 fields only. cc/cp/pmx columns are
    // managed by runClusterRecompute and intentionally NOT clobbered
    // here (they preserve their last-recompute values on UPDATE).
    upsertEdge: db.prepare(
      `INSERT INTO wallet_cluster_edges
         (addr_a, addr_b, confidence, cih_count, self_xfer_count,
          self_xfer_ab, self_xfer_ba, evidence_json, first_seen_at, last_seen_at)
       VALUES (@addr_a, @addr_b, @confidence, @cih_count, @self_xfer_count,
               @self_xfer_ab, @self_xfer_ba, @evidence_json, @first_seen_at, @last_seen_at)
       ON CONFLICT(addr_a, addr_b) DO UPDATE SET
         confidence      = excluded.confidence,
         cih_count       = excluded.cih_count,
         self_xfer_count = excluded.self_xfer_count,
         self_xfer_ab    = excluded.self_xfer_ab,
         self_xfer_ba    = excluded.self_xfer_ba,
         evidence_json   = excluded.evidence_json,
         first_seen_at   = MIN(wallet_cluster_edges.first_seen_at, excluded.first_seen_at),
         last_seen_at    = MAX(wallet_cluster_edges.last_seen_at, excluded.last_seen_at)`
    ),
    updateState: db.prepare(
      `UPDATE poll_state
          SET last_cursor = @c, last_run_at = unixepoch(),
              last_status = @status, last_event_count = @count
        WHERE stream = @s AND collection_slug = @col`
    ),
  };
  return cached;
}

function loadBlacklist(): Set<string> {
  const s = stmts();
  const out = new Set<string>(MINT_WALLET_ADDRS);
  for (const r of s.selectBlacklist.all() as Array<{ address: string }>) {
    out.add(r.address);
  }
  return out;
}

/**
 * Hard blacklist for the v2 recompute: mint wallets + non-auto reasons
 * only. We deliberately exclude `auto-high-degree` rows because those
 * ARE the multi-source receivers we want to classify as personal vs
 * not — using the soft blacklist would zero out the MSR set every
 * recompute (since it self-references the previous run's output).
 */
function loadHardBlacklist(): Set<string> {
  const out = new Set<string>(MINT_WALLET_ADDRS);
  const rows = getDb()
    .prepare(`SELECT address FROM cluster_blacklist WHERE reason != 'auto-high-degree'`)
    .all() as Array<{ address: string }>;
  for (const r of rows) out.add(r.address);
  return out;
}

function loadMultiSourceReceivers(): Set<string> {
  const s = stmts();
  const out = new Set<string>();
  for (const r of s.selectMultiSourceReceivers.all({
    t: MULTI_SOURCE_RECEIVER_THRESHOLD,
  }) as Array<{ new_owner: string }>) {
    out.add(r.new_owner);
  }
  return out;
}

function seedMintBlacklist(): void {
  const s = stmts();
  const db = getDb();
  db.transaction(() => {
    for (const a of MINT_WALLET_ADDRS) {
      s.upsertBlacklist.run(a, 'mint distribution wallet');
    }
  })();
}

/**
 * Live wallet-clustering tick. Walks recent CIH-eligible events past the
 * cursor, fetches raw txs, and bumps `wallet_cluster_edges` with new CIH
 * + self-transfer-chain evidence. Idempotent on re-run within a tick
 * (evidence is deduped by (type, txid) so the upsert is a no-op).
 *
 * Cursor bootstrap: if `last_cursor` is NULL we set it to MAX(events.id)
 * and exit — operators must run scripts/backfill-cluster.js for
 * historical coverage. The warn log is the operator-facing nudge.
 */
export async function runClusterTick(): Promise<TickResult> {
  const startedAt = Date.now();
  const result: TickResult = {
    mode: 'cluster',
    scanned: 0,
    edges_touched: 0,
    cursor_advanced: false,
    duration_ms: 0,
  };

  if (!bitcoindConfigured()) {
    return { ...result, skipped: 'not-configured', duration_ms: Date.now() - startedAt };
  }

  const s = stmts();
  const db = getDb();

  seedMintBlacklist();

  const stateRow = s.selectState.get(STREAM, COLLECTION) as
    | { last_cursor: string | null }
    | undefined;
  if (!stateRow) {
    return {
      ...result,
      error: 'poll-state-row-missing',
      duration_ms: Date.now() - startedAt,
    };
  }

  let cursor: number;
  if (stateRow.last_cursor == null) {
    const max = s.selectMaxId.get() as { m: number };
    cursor = Math.max(0, max.m);
    s.updateState.run({
      c: String(cursor),
      status: 'bootstrapped',
      count: 0,
      s: STREAM,
      col: COLLECTION,
    });
    log.warn('poll/cluster', 'cursor bootstrapped — historical sweep REQUIRED', {
      cursor,
      action: 'run scripts/backfill-cluster.js once on this DB',
    });
    return {
      ...result,
      skipped: 'not-bootstrapped',
      cursor_advanced: true,
      duration_ms: Date.now() - startedAt,
    };
  }
  cursor = parseInt(stateRow.last_cursor, 10);
  if (!Number.isFinite(cursor)) cursor = 0;

  // Upper bound: tip minus a safety margin (we DON'T process events newer
  // than NOW - SETTLEMENT_DELAY because reclassifiers might still touch
  // them). The created_at gate inside the SELECT already enforces this for
  // each row; the upper id bound is for cursor advancement so we don't
  // skip past unsettled rows.
  const max = s.selectMaxId.get() as { m: number };
  const upper = max.m;

  const candidates = s.selectCandidates.all({
    cursor,
    upper,
    delay: SETTLEMENT_DELAY_SEC,
    lim: PER_TICK_LIMIT,
  }) as Array<{
    id: number;
    txid: string;
    event_type: string;
    old_owner: string | null;
    new_owner: string | null;
    marketplace: string | null;
    block_timestamp: number;
  }>;

  if (candidates.length === 0) {
    // Advance cursor up to upper (settled tip) so we don't re-scan the
    // same range, but only past rows that have actually settled. We use
    // a separate query that finds the highest id meeting the
    // created_at gate to avoid jumping past unsettled rows.
    const advanced = db
      .prepare(
        `SELECT COALESCE(MAX(id), @cursor) AS m
           FROM events
          WHERE id > @cursor AND created_at < unixepoch() - @delay`
      )
      .get({ cursor, delay: SETTLEMENT_DELAY_SEC }) as { m: number };
    if (advanced.m > cursor) {
      s.updateState.run({
        c: String(advanced.m),
        status: 'idle',
        count: 0,
        s: STREAM,
        col: COLLECTION,
      });
      result.cursor_advanced = true;
    }
    // Bootstrap-friendly recompute: even if no new candidates landed this
    // tick, the cluster_anchors table may be empty (first tick after a
    // deploy with the v31 schema, or after a backfill). Cheap to redo.
    maybeRefreshAnchors();
    result.duration_ms = Date.now() - startedAt;
    return result;
  }

  result.scanned = candidates.length;
  const blacklist = loadBlacklist();
  const multiSource = loadMultiSourceReceivers();

  // Fetch raw txs in parallel; bounded concurrency. We need vin prevout
  // addresses + first witness element (for SIGHASH detection). The cache
  // entries record the gating decision per txid so the edge-build loop
  // doesn't re-scan inputs.
  type TxGated = {
    addrs: string[];
    /** Reason this tx is suppressed for CIH+self_xfer; null = eligible. */
    suppress:
      | null
      | 'rpc-fail'
      | 'blacklisted-input'
      | 'acp-settlement'
      | 'high-fanin';
  };
  const inputsByTxid = new Map<string, TxGated>();
  let rpcFailures = 0;
  let next = 0;
  async function worker(): Promise<void> {
    while (next < candidates.length) {
      const idx = next++;
      const c = candidates[idx];
      if (inputsByTxid.has(c.txid)) continue;
      try {
        const tx = await getRawTransaction(c.txid);
        const txLike = {
          txid: tx.txid,
          vin: tx.vin.map(v => ({
            prevout: v.prevout
              ? { scriptPubKey: { address: v.prevout.scriptPubKey?.address } }
              : undefined,
            txinwitness:
              Array.isArray(v.txinwitness) && v.txinwitness.length > 0
                ? [v.txinwitness[0]]
                : undefined,
          })),
        };
        const addrs = collectInputAddresses(txLike);
        let suppress: TxGated['suppress'] = null;
        if (hasAcpInput(txLike)) suppress = 'acp-settlement';
        else if (addrs.some(a => blacklist.has(a))) suppress = 'blacklisted-input';
        else if (addrs.length > MAX_INPUTS_FOR_CIH) suppress = 'high-fanin';
        inputsByTxid.set(c.txid, { addrs, suppress });
      } catch (err) {
        rpcFailures++;
        log.warn('poll/cluster', 'rpc fail', {
          txid: c.txid,
          error: err instanceof Error ? err.message : String(err),
        });
        inputsByTxid.set(c.txid, { addrs: [], suppress: 'rpc-fail' });
      }
    }
  }
  await Promise.all(
    Array.from({ length: RPC_CONCURRENCY }, () => worker())
  );

  // Build per-tick edge accumulator from CIH + self-xfer signals.
  const acc: EdgeAcc = new Map();
  for (const c of candidates) {
    const ts = c.block_timestamp || 0;
    const entry = inputsByTxid.get(c.txid);
    if (!entry) continue;

    // PSBT-settlement gate: a transferred event whose new_owner literally
    // appears in the spending inputs is a buyer+seller cooperative
    // settlement (rarer than ACP, but happens — older or hand-rolled
    // PSBTs). Suppress both CIH and self-xfer signals on those.
    const newOwnerInInputs =
      c.event_type === 'transferred' &&
      c.new_owner != null &&
      entry.addrs.includes(c.new_owner);
    const suppressed = entry.suppress != null || newOwnerInInputs;

    if (!suppressed && entry.addrs.length >= 2) {
      for (let i = 0; i < entry.addrs.length; i++) {
        for (let j = i + 1; j < entry.addrs.length; j++) {
          const a = entry.addrs[i];
          const b = entry.addrs[j];
          if (multiSource.has(a) || multiSource.has(b)) continue;
          bumpEdge(acc, a, b, { type: 'cih', txid: c.txid, ts });
        }
      }
    }

    if (
      !suppressed &&
      c.event_type === 'transferred' &&
      c.marketplace == null &&
      c.old_owner &&
      c.new_owner &&
      c.old_owner !== c.new_owner &&
      !blacklist.has(c.old_owner) &&
      !blacklist.has(c.new_owner) &&
      !multiSource.has(c.old_owner) &&
      !multiSource.has(c.new_owner)
    ) {
      bumpEdge(acc, c.old_owner, c.new_owner, {
        type: 'self_xfer',
        txid: c.txid,
        ts,
      });
    }
  }

  // Persist: for each edge in the accumulator, merge into the existing DB
  // row (if any) and upsert. One transaction for the whole batch.
  let touched = 0;
  const tx = db.transaction(() => {
    Array.from(acc.values()).forEach(row => {
      const existing = s.selectEdge.get(row.addr_a, row.addr_b) as
        | {
            cih_count: number;
            self_xfer_count: number;
            self_xfer_ab: number;
            self_xfer_ba: number;
            co_cons_count: number;
            co_parent_count: number;
            pmx_count: number;
            pmx_ab: number;
            pmx_ba: number;
            pmx_rt_count: number;
            pmx_rt_ab: number;
            pmx_rt_ba: number;
            evidence_json: string;
            first_seen_at: number;
            last_seen_at: number;
          }
        | undefined;
      let cih = row.cih_count;
      let self = row.self_xfer_count;
      let selfAb = row.self_xfer_ab;
      let selfBa = row.self_xfer_ba;
      // cc/cp/pmx are recompute-owned. Read from existing if present
      // (preserved through the UPSERT) so the confidence formula sees
      // the full picture; the live tick never increments them.
      let cc = 0, cp = 0;
      let pmx = 0, pmxAb = 0, pmxBa = 0;
      let pmxRt = 0, pmxRtAb = 0, pmxRtBa = 0;
      let evidence: EvidenceItem[] = [];
      let firstSeen = row.first_seen_at;
      let lastSeen = row.last_seen_at;
      if (existing) {
        cih = existing.cih_count;
        self = existing.self_xfer_count;
        selfAb = existing.self_xfer_ab;
        selfBa = existing.self_xfer_ba;
        cc = existing.co_cons_count;
        cp = existing.co_parent_count;
        pmx = existing.pmx_count;
        pmxAb = existing.pmx_ab;
        pmxBa = existing.pmx_ba;
        pmxRt = existing.pmx_rt_count;
        pmxRtAb = existing.pmx_rt_ab;
        pmxRtBa = existing.pmx_rt_ba;
        firstSeen = Math.min(existing.first_seen_at || firstSeen, firstSeen);
        lastSeen = Math.max(existing.last_seen_at || 0, lastSeen);
        try {
          const parsed = JSON.parse(existing.evidence_json);
          if (Array.isArray(parsed)) evidence = parsed as EvidenceItem[];
        } catch {
          /* corrupt JSON — start fresh */
        }
        // Apply each new evidence item with dedup-aware bumping.
        for (const e of row.evidence) {
          const dup = evidence.some(x => x.type === e.type && x.txid === e.txid);
          if (!dup) {
            if (e.type === 'cih') {
              cih += 1;
            } else if (e.type === 'self_xfer') {
              self += 1;
              if (e.direction === 'ab') selfAb += 1;
              else if (e.direction === 'ba') selfBa += 1;
            }
            // pmx evidence is never produced by the live tick — only by
            // runClusterRecompute, which writes columns directly.
          }
          evidence = appendEvidence(evidence, e);
        }
      } else {
        evidence = row.evidence;
      }
      s.upsertEdge.run({
        addr_a: row.addr_a,
        addr_b: row.addr_b,
        confidence: confidenceFromCounts({
          cih_count: cih,
          self_xfer_count: self,
          self_xfer_ab: selfAb,
          self_xfer_ba: selfBa,
          co_cons_count: cc,
          co_parent_count: cp,
          pmx_count: pmx,
          pmx_ab: pmxAb,
          pmx_ba: pmxBa,
          pmx_rt_count: pmxRt,
          pmx_rt_ab: pmxRtAb,
          pmx_rt_ba: pmxRtBa,
        }),
        cih_count: cih,
        self_xfer_count: self,
        self_xfer_ab: selfAb,
        self_xfer_ba: selfBa,
        evidence_json: JSON.stringify(evidence),
        first_seen_at: firstSeen || 0,
        last_seen_at: lastSeen || 0,
      });
      touched += 1;
    });
  });
  tx();
  result.edges_touched = touched;

  // Refresh the materialized cluster_anchors so leaderboards, holder
  // aggregation, and counts pick up new identity-folds without waiting
  // for a separate pass. Cheap: walks ~hundreds of edges at threshold.
  maybeRefreshAnchors();

  // Advance cursor to the highest candidate id processed.
  const newCursor = candidates[candidates.length - 1].id;
  s.updateState.run({
    c: String(newCursor),
    status: rpcFailures > 0 ? `partial-rpc-failures=${rpcFailures}` : 'ok',
    count: touched,
    s: STREAM,
    col: COLLECTION,
  });
  result.cursor_advanced = true;
  result.duration_ms = Date.now() - startedAt;
  return result;
}

/** Wrapper that swallows errors so cluster_anchors freshness never
 *  breaks the live tick. The recompute is best-effort: anchors lag a
 *  tick on RPC partial failure, which is acceptable. */
function maybeRefreshAnchors(): void {
  try {
    recomputeClusterAnchors();
  } catch (err) {
    log.warn('poll/cluster', 'recomputeClusterAnchors failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// =============================================================
// runClusterRecompute — global pass for v2 signals (cc, cp, pmx, pmx_rt)
// =============================================================
//
// These three signals depend on whole-corpus fan-out maps; they can't
// be computed from a single new transferred event the way CIH and sx
// can. Recompute is meant to run hourly via `?mode=cluster-recompute`,
// not in the live `cluster` tick.
//
// Strategy: load every marketplace=NULL transferred event into memory,
// build sender→recipients and receiver→senders adjacency, classify
// MSRs and the personal-MSR subset, then emit pairwise cc/cp/pmx bumps
// into an in-memory accumulator. Round-trip flag for pmx is computed
// against an inscription→ownership-history index built once. Flush
// updates the dedicated columns on each existing edge (rows the live
// tick has already written) and inserts new rows for cc/cp/pmx-only
// pairs that the live tick has never seen.
//
// Cost on the May 2026 snapshot: ~1.5 GB peak RAM (set-of-bridges per
// edge), ~5s wallclock. Comfortable within a hourly cron.

type RecomputeResult = {
  mode: 'cluster-recompute';
  events_scanned: number;
  msrs: number;
  personal_msrs: number;
  cc_bumps: number;
  cp_bumps: number;
  pmx_events: number;
  pmx_rt_events: number;
  edges_written: number;
  duration_ms: number;
  error?: string;
};

export function runClusterRecompute(): RecomputeResult {
  const startedAt = Date.now();
  const db = getDb();
  const result: RecomputeResult = {
    mode: 'cluster-recompute',
    events_scanned: 0,
    msrs: 0,
    personal_msrs: 0,
    cc_bumps: 0,
    cp_bumps: 0,
    pmx_events: 0,
    pmx_rt_events: 0,
    edges_written: 0,
    duration_ms: 0,
  };
  // Use the HARD blacklist (mints + manual + marketplace/liquidium) so
  // auto-high-degree MSRs from the prior recompute aren't filtered out
  // before we get a chance to re-classify them this round.
  const blacklist = loadHardBlacklist();

  // Pull every marketplace=NULL transferred event in id order so the
  // round-trip lookup (was the receiver an earlier owner?) is a
  // straight prefix scan over inscEvents[insc].
  const xferRows = db.prepare(
    `SELECT id, inscription_number, old_owner, new_owner, txid, block_timestamp
       FROM events
      WHERE event_type='transferred' AND marketplace IS NULL
        AND old_owner IS NOT NULL AND new_owner IS NOT NULL AND old_owner != new_owner
      ORDER BY id ASC`
  ).all() as Array<{
    id: number;
    inscription_number: number;
    old_owner: string;
    new_owner: string;
    txid: string;
    block_timestamp: number;
  }>;
  result.events_scanned = xferRows.length;

  // Per-inscription event timeline (for round-trip detection). We only
  // need (id, new_owner) tuples for ALL events touching the inscription
  // so a "did B previously own this" check is O(timeline-length) but
  // each chain is short (median ~3, max ~30).
  const inscTimeline = new Map<number, Array<{ id: number; new_owner: string }>>();
  for (const r of db.prepare(
    `SELECT id, inscription_number, new_owner FROM events
      WHERE new_owner IS NOT NULL ORDER BY id ASC`
  ).all() as Array<{ id: number; inscription_number: number; new_owner: string }>) {
    let arr = inscTimeline.get(r.inscription_number);
    if (!arr) { arr = []; inscTimeline.set(r.inscription_number, arr); }
    arr.push({ id: r.id, new_owner: r.new_owner });
  }

  function isRoundTrip(insc: number, beforeId: number, who: string): boolean {
    const arr = inscTimeline.get(insc);
    if (!arr) return false;
    for (const ev of arr) {
      if (ev.id >= beforeId) return false;
      if (ev.new_owner === who) return true;
    }
    return false;
  }

  // Fan-out / fan-in maps over non-blacklist endpoints.
  const senderRecv = new Map<string, Set<string>>();
  const recvSender = new Map<string, Set<string>>();
  for (const r of xferRows) {
    if (blacklist.has(r.old_owner) || blacklist.has(r.new_owner)) continue;
    let s = senderRecv.get(r.old_owner);
    if (!s) { s = new Set(); senderRecv.set(r.old_owner, s); }
    s.add(r.new_owner);
    let t = recvSender.get(r.new_owner);
    if (!t) { t = new Set(); recvSender.set(r.new_owner, t); }
    t.add(r.old_owner);
  }
  const msrSet = new Set<string>();
  Array.from(recvSender.entries()).forEach(([a, set]) => {
    if (set.size >= MULTI_SOURCE_RECEIVER_THRESHOLD) msrSet.add(a);
  });
  result.msrs = msrSet.size;

  // Personal-MSR classification.
  const personalMsr = new Set<string>();
  const retentionStmt = db.prepare(
    `WITH recv AS (
       SELECT DISTINCT inscription_number FROM events
        WHERE event_type='transferred' AND marketplace IS NULL
          AND old_owner != new_owner AND new_owner = ?
     )
     SELECT COUNT(*) AS recv_n,
            SUM(CASE WHEN i.effective_owner = ? THEN 1 ELSE 0 END) AS held_n
       FROM recv r JOIN inscriptions i USING(inscription_number)`
  );
  Array.from(msrSet).forEach(c => {
    const senders = recvSender.get(c) ?? new Set<string>();
    let bidir = 0;
    const myRecips = senderRecv.get(c) ?? new Set<string>();
    Array.from(senders).forEach(s => { if (myRecips.has(s)) bidir++; });
    if (bidir >= PERSONAL_MSR_BIDIR_MIN) { personalMsr.add(c); return; }
    const ret = retentionStmt.get(c, c) as { recv_n: number; held_n: number };
    if (ret.recv_n >= 5 && ret.held_n / ret.recv_n >= PERSONAL_MSR_RETENTION_MIN) {
      personalMsr.add(c);
    }
  });
  result.personal_msrs = personalMsr.size;

  // Per-edge accumulator for cc/cp/pmx counts. We don't reuse EdgeAcc
  // because we're only computing the v2 columns; the v1 columns come
  // straight from the existing rows.
  type V2Row = {
    addr_a: string;
    addr_b: string;
    cc: Set<string>;
    cp: Set<string>;
    pmx: number;
    pmx_ab: number;
    pmx_ba: number;
    pmx_rt: number;
    pmx_rt_ab: number;
    pmx_rt_ba: number;
  };
  const v2: Map<string, V2Row> = new Map();
  function getRow(a: string, b: string): V2Row | null {
    if (a === b) return null;
    const [x, y] = a < b ? [a, b] : [b, a];
    const key = `${x}|${y}`;
    let r = v2.get(key);
    if (!r) {
      r = {
        addr_a: x, addr_b: y,
        cc: new Set(), cp: new Set(),
        pmx: 0, pmx_ab: 0, pmx_ba: 0,
        pmx_rt: 0, pmx_rt_ab: 0, pmx_rt_ba: 0,
      };
      v2.set(key, r);
    }
    return r;
  }

  // co_consolidator: monog senders sharing a destination ⇒ pair them.
  Array.from(recvSender.entries()).forEach(([c, senders]) => {
    if (senders.size < COCONS_MIN_DEGREE) return;
    if (blacklist.has(c)) return;
    const monog: string[] = [];
    Array.from(senders).forEach(s => {
      if (s === c || blacklist.has(s)) return;
      const fan = senderRecv.get(s)?.size ?? 0;
      if (fan >= 1 && fan <= MONOG_FANOUT_MAX) monog.push(s);
    });
    if (monog.length < COCONS_MIN_DEGREE) return;
    for (let i = 0; i < monog.length; i++) {
      for (let j = i + 1; j < monog.length; j++) {
        const r = getRow(monog[i], monog[j]);
        if (!r) continue;
        r.cc.add(c);
        result.cc_bumps += 1;
      }
      // Also link each monog sender directly to C (the consolidator
      // is presumed same-owner at the same confidence as the cohort).
      const r = getRow(monog[i], c);
      if (r) r.cc.add(c);
    }
  });

  // co_parent: monog receivers sharing a non-MSR parent ⇒ pair them.
  Array.from(senderRecv.entries()).forEach(([p, recips]) => {
    if (recips.size < PARENT_FANOUT_MIN) return;
    // Skip exchange-like distributors (MSR but not personal).
    if (msrSet.has(p) && !personalMsr.has(p)) return;
    if (blacklist.has(p)) return;
    const monog: string[] = [];
    Array.from(recips).forEach(r => {
      if (r === p || blacklist.has(r)) return;
      const fan = recvSender.get(r)?.size ?? 0;
      if (fan >= 1 && fan <= MONOG_FANIN_MAX) monog.push(r);
    });
    if (monog.length < PARENT_FANOUT_MIN) return;
    for (let i = 0; i < monog.length; i++) {
      for (let j = i + 1; j < monog.length; j++) {
        const r = getRow(monog[i], monog[j]);
        if (!r) continue;
        r.cp.add(p);
        result.cp_bumps += 1;
      }
    }
  });

  // pmx: direct transfers where one endpoint is a personal-MSR.
  for (const e of xferRows) {
    if (blacklist.has(e.old_owner) || blacklist.has(e.new_owner)) continue;
    if (!personalMsr.has(e.old_owner) && !personalMsr.has(e.new_owner)) continue;
    const r = getRow(e.old_owner, e.new_owner);
    if (!r) continue;
    r.pmx += 1;
    const isAb = e.old_owner === r.addr_a;
    if (isAb) r.pmx_ab += 1; else r.pmx_ba += 1;
    if (isRoundTrip(e.inscription_number, e.id, e.new_owner)) {
      r.pmx_rt += 1;
      if (isAb) r.pmx_rt_ab += 1; else r.pmx_rt_ba += 1;
      result.pmx_rt_events += 1;
    }
    result.pmx_events += 1;
  }

  // Flush v2 columns + recompute confidence for every edge that has
  // any signal. We need to:
  //   (a) preserve cih_count / self_xfer_* on existing rows,
  //   (b) write cc/cp/pmx values into existing rows or insert new ones,
  //   (c) recompute confidence with the merged counts.
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

  // Also need to zero-out v2 columns on existing edges that no longer
  // have any v2 evidence (e.g. a sender's monog status flipped, so its
  // cc bridges shouldn't survive). One bulk UPDATE before applying the
  // accumulator does it.
  db.exec(
    `UPDATE wallet_cluster_edges
        SET co_cons_count = 0, co_parent_count = 0,
            pmx_count = 0, pmx_ab = 0, pmx_ba = 0,
            pmx_rt_count = 0, pmx_rt_ab = 0, pmx_rt_ba = 0`
  );
  // After zeroing, also need to recompute confidence using the existing
  // v1 fields only — otherwise rows whose only signal was a v2 one
  // would still carry stale high confidence until their (a,b) pair
  // appears in v2. Iterate existing rows once and update.
  const allExisting = db.prepare(
    `SELECT addr_a, addr_b, cih_count, self_xfer_count, self_xfer_ab, self_xfer_ba
       FROM wallet_cluster_edges`
  ).all() as Array<{
    addr_a: string; addr_b: string;
    cih_count: number; self_xfer_count: number;
    self_xfer_ab: number; self_xfer_ba: number;
  }>;
  const updateConfOnly = db.prepare(
    `UPDATE wallet_cluster_edges SET confidence = ? WHERE addr_a = ? AND addr_b = ?`
  );

  const writeTx = db.transaction(() => {
    for (const row of allExisting) {
      const conf = confidenceFromCounts({
        cih_count: row.cih_count,
        self_xfer_count: row.self_xfer_count,
        self_xfer_ab: row.self_xfer_ab,
        self_xfer_ba: row.self_xfer_ba,
      });
      updateConfOnly.run(conf, row.addr_a, row.addr_b);
    }
  });
  writeTx();

  // Now apply v2 — needs to read existing v1 to compute the right
  // confidence. selectEdge returns all fields after our earlier change.
  const v1Stmt = db.prepare(
    `SELECT cih_count, self_xfer_count, self_xfer_ab, self_xfer_ba
       FROM wallet_cluster_edges WHERE addr_a = ? AND addr_b = ?`
  );
  const writeV2 = db.transaction(() => {
    Array.from(v2.values()).forEach(r => {
      const v1 = v1Stmt.get(r.addr_a, r.addr_b) as
        | { cih_count: number; self_xfer_count: number; self_xfer_ab: number; self_xfer_ba: number }
        | undefined;
      const conf = confidenceFromCounts({
        cih_count: v1?.cih_count ?? 0,
        self_xfer_count: v1?.self_xfer_count ?? 0,
        self_xfer_ab: v1?.self_xfer_ab ?? 0,
        self_xfer_ba: v1?.self_xfer_ba ?? 0,
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
        addr_a: r.addr_a,
        addr_b: r.addr_b,
        confidence: conf,
        cc: r.cc.size,
        cp: r.cp.size,
        pmx: r.pmx,
        pmx_ab: r.pmx_ab,
        pmx_ba: r.pmx_ba,
        pmx_rt: r.pmx_rt,
        pmx_rt_ab: r.pmx_rt_ab,
        pmx_rt_ba: r.pmx_rt_ba,
      });
      result.edges_written += 1;
    });
  });
  writeV2();

  // Refresh the cluster_anchors materialized view so leaderboards /
  // holder pages reflect the new identity-fold composition.
  try {
    recomputeClusterAnchors();
  } catch (err) {
    log.warn('poll/cluster-recompute', 'recomputeClusterAnchors failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Record the auto-high-degree blacklist update too (mirrors what the
  // backfill script does so the live tick's in-memory MSR set stays
  // current).
  const insertBL = db.prepare(
    `INSERT OR REPLACE INTO cluster_blacklist (address, reason, degree, added_at, notes)
     VALUES (?, 'auto-high-degree', ?, unixepoch(), ?)`
  );
  db.transaction(() => {
    Array.from(msrSet).forEach(a => {
      const degree = recvSender.get(a)?.size ?? 0;
      insertBL.run(a, degree, `received transferred-events from ${degree} distinct senders`);
    });
  })();

  result.duration_ms = Date.now() - startedAt;
  log.info('poll/cluster-recompute', 'done', result);
  return result;
}

/**
 * Loads the MSR set (auto-high-degree blacklist entries) for use by
 * display-time filters. Cached briefly per-process to avoid a query
 * per "likely linked" lookup; readers refresh implicitly between
 * cluster-recompute runs (hourly).
 */
let _msrCache: { set: Set<string>; loadedAt: number } | null = null;
const MSR_CACHE_TTL_MS = 60_000;
function loadMsrSet(): Set<string> {
  const now = Date.now();
  if (_msrCache && (now - _msrCache.loadedAt) < MSR_CACHE_TTL_MS) return _msrCache.set;
  const rows = getDb().prepare(
    `SELECT address FROM cluster_blacklist WHERE reason = 'auto-high-degree'`
  ).all() as Array<{ address: string }>;
  const set = new Set(rows.map(r => r.address));
  _msrCache = { set, loadedAt: now };
  return set;
}

/**
 * Rebuild the `cluster_anchors` materialized view from
 * `wallet_cluster_edges` at IDENTITY_FOLD_THRESHOLD.
 *
 * Picks an anchor per connected component:
 *   - If the component contains exactly one Matrica user, anchor =
 *     that user_id (so unlinked members fold onto the linked user).
 *   - If it contains multiple distinct Matrica users, the component is
 *     SKIPPED — heuristic merges must never silently re-key authoritative
 *     Matrica linkage. Each member falls through to its own Matrica user
 *     or address downstream.
 *   - If unlinked-only, anchor = lex-min wallet address.
 *
 * Runs inside a single transaction; truncate-and-reinsert is fine at
 * our scale (~hundreds of components total).
 */
export function recomputeClusterAnchors(): {
  components: number;
  members: number;
  skipped_split_clusters: number;
} {
  const db = getDb();
  const edges = db
    .prepare(
      `SELECT addr_a, addr_b
         FROM wallet_cluster_edges
        WHERE confidence >= ?`
    )
    .all(IDENTITY_FOLD_THRESHOLD) as Array<{ addr_a: string; addr_b: string }>;

  const uf = new UnionFind();
  for (const e of edges) uf.union(e.addr_a, e.addr_b);
  const components = uf.groups();

  // Bulk-look up Matrica linkage for every node in any component, so we
  // don't N+1 the DB inside the per-component loop.
  const allNodes: string[] = [];
  Array.from(components.values()).forEach(members => {
    allNodes.push(...members);
  });
  const matricaByAddr = new Map<string, string>();
  if (allNodes.length > 0) {
    const placeholders = allNodes.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT wallet_addr, matrica_user_id
           FROM wallet_links
          WHERE matrica_user_id IS NOT NULL
            AND wallet_addr IN (${placeholders})`
      )
      .all(...allNodes) as Array<{ wallet_addr: string; matrica_user_id: string }>;
    for (const r of rows) matricaByAddr.set(r.wallet_addr, r.matrica_user_id);
  }

  let componentCount = 0;
  let memberCount = 0;
  let skipped = 0;
  const insertAnchor = db.prepare(
    `INSERT INTO cluster_anchors
       (wallet_addr, anchor_id, matrica_user_id, cluster_size, computed_at)
     VALUES (@wallet_addr, @anchor_id, @matrica_user_id, @cluster_size, unixepoch())`
  );

  const apply = db.transaction(() => {
    db.exec(`DELETE FROM cluster_anchors`);
    Array.from(components.values()).forEach(members => {
      if (members.length < 2) return;
      const matricaIds = new Set<string>();
      for (const m of members) {
        const mid = matricaByAddr.get(m);
        if (mid) matricaIds.add(mid);
      }
      if (matricaIds.size > 1) {
        skipped += 1;
        return;
      }
      const matricaId = matricaIds.size === 1 ? Array.from(matricaIds)[0] : null;
      const anchorId = matricaId ?? members.slice().sort()[0];
      componentCount += 1;
      for (const wallet of members) {
        insertAnchor.run({
          wallet_addr: wallet,
          anchor_id: anchorId,
          matrica_user_id: matricaId,
          cluster_size: members.length,
        });
        memberCount += 1;
      }
    });
  });
  apply();

  return {
    components: componentCount,
    members: memberCount,
    skipped_split_clusters: skipped,
  };
}

/**
 * Returns the cluster anchor row for `address` at IDENTITY_FOLD_THRESHOLD,
 * or null if the address is in a singleton component (no fold). Used by
 * holder-page aggregation to extend the wallet set beyond Matrica
 * siblings.
 */
export function getClusterAnchorForAddress(address: string): {
  anchor_id: string;
  matrica_user_id: string | null;
  cluster_size: number;
} | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT anchor_id, matrica_user_id, cluster_size
         FROM cluster_anchors WHERE wallet_addr = ?`
    )
    .get(address) as
    | { anchor_id: string; matrica_user_id: string | null; cluster_size: number }
    | undefined;
  return row ?? null;
}

/**
 * Returns every wallet folded onto the given Matrica user via
 * cluster_anchors at IDENTITY_FOLD_THRESHOLD. Includes both Matrica-
 * confirmed siblings that participate in on-chain edges AND inferred
 * peers; Matrica wallets without on-chain links are NOT in this set
 * (they sit in wallet_links only) — callers should union with the
 * Matrica-sibling list to get the full identity wallet set.
 */
export function getClusterMembersForMatricaUser(userId: string): string[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT wallet_addr FROM cluster_anchors
        WHERE matrica_user_id = ? ORDER BY wallet_addr ASC`
    )
    .all(userId) as Array<{ wallet_addr: string }>;
  return rows.map(r => r.wallet_addr);
}

/**
 * Returns every wallet that shares a cluster anchor with `address`, or
 * just `[address]` if it's in a singleton. The address itself is always
 * the first element.
 */
export function getClusterMembersForAddress(address: string): string[] {
  const anchor = getClusterAnchorForAddress(address);
  if (!anchor) return [address];
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT wallet_addr FROM cluster_anchors
        WHERE anchor_id = ? ORDER BY wallet_addr ASC`
    )
    .all(anchor.anchor_id) as Array<{ wallet_addr: string }>;
  const members = rows.map(r => r.wallet_addr);
  // Hoist `address` to the front for caller convenience (page deep-links).
  if (!members.includes(address)) return [address, ...members];
  return [address, ...members.filter(m => m !== address)];
}

// ---------------- Readers (UI surface) ----------------

export type ClusterEdgeRow = {
  addr_a: string;
  addr_b: string;
  confidence: number;
  cih_count: number;
  self_xfer_count: number;
  evidence: EvidenceItem[];
  first_seen_at: number;
  last_seen_at: number;
};

/**
 * Returns inferred-link rows where `addr` is one of the two endpoints,
 * with confidence ≥ minConfidence (default = CLUSTER_THRESHOLD). The
 * caller's wallet appears as either addr_a or addr_b — we normalize so
 * `peer` is always the OTHER wallet.
 *
 * Display filter: edges that match the cross-trader pattern
 * (isCrossTraderEdge — both endpoints MSRs, only signal is non-round-
 * trip pmx) are dropped before returning. Underlying confidence and
 * cluster_anchors are unaffected.
 */
export function getInferredLinksForAddress(
  addr: string,
  minConfidence: number,
  limit = 50
): Array<{
  peer: string;
  confidence: number;
  cih_count: number;
  self_xfer_count: number;
  evidence: EvidenceItem[];
  last_seen_at: number;
}> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT addr_a, addr_b, confidence, cih_count, self_xfer_count,
              co_cons_count, co_parent_count,
              pmx_count, pmx_rt_count,
              evidence_json, last_seen_at
         FROM wallet_cluster_edges
        WHERE (addr_a = @addr OR addr_b = @addr)
          AND confidence >= @min
        ORDER BY confidence DESC, last_seen_at DESC
        LIMIT @lim`
    )
    .all({ addr, min: minConfidence, lim: limit * 2 }) as Array<{
    addr_a: string;
    addr_b: string;
    confidence: number;
    cih_count: number;
    self_xfer_count: number;
    co_cons_count: number;
    co_parent_count: number;
    pmx_count: number;
    pmx_rt_count: number;
    evidence_json: string;
    last_seen_at: number;
  }>;
  const msrSet = loadMsrSet();
  const out: ReturnType<typeof getInferredLinksForAddress> = [];
  for (const r of rows) {
    if (isCrossTraderEdge(r, msrSet)) continue;
    let evidence: EvidenceItem[] = [];
    try {
      const parsed = JSON.parse(r.evidence_json);
      if (Array.isArray(parsed)) evidence = parsed as EvidenceItem[];
    } catch {
      /* ignore */
    }
    out.push({
      peer: r.addr_a === addr ? r.addr_b : r.addr_a,
      confidence: r.confidence,
      cih_count: r.cih_count,
      self_xfer_count: r.self_xfer_count,
      evidence,
      last_seen_at: r.last_seen_at,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Materialize the cluster (transitive closure) containing `addr` at the
 * given threshold. BFS over edges; bounded `maxNodes` to prevent
 * runaway when a misbehaving heuristic produces a giant blob.
 */
export function getClusterForAddress(
  addr: string,
  minConfidence: number,
  maxNodes = 200
): { members: string[]; edges: number } {
  const db = getDb();
  const selectNeighbors = db.prepare(
    `SELECT addr_a, addr_b
       FROM wallet_cluster_edges
      WHERE confidence >= @min
        AND (addr_a = @addr OR addr_b = @addr)`
  );
  const visited = new Set<string>([addr]);
  const queue: string[] = [addr];
  let edges = 0;
  while (queue.length > 0 && visited.size < maxNodes) {
    const current = queue.shift() as string;
    const rows = selectNeighbors.all({ addr: current, min: minConfidence }) as Array<{
      addr_a: string;
      addr_b: string;
    }>;
    edges += rows.length;
    for (const r of rows) {
      const peer = r.addr_a === current ? r.addr_b : r.addr_a;
      if (!visited.has(peer)) {
        visited.add(peer);
        queue.push(peer);
      }
    }
  }
  return { members: Array.from(visited), edges };
}

/** Used by the canonical-pair helper from outside. */
export { canonicalPair, edgeKey };

export type LikelyLinkedRow = {
  /** The peer wallet (always different from any of the input wallets). */
  peer: string;
  confidence: number;
  cih_count: number;
  self_xfer_count: number;
  evidence: EvidenceItem[];
  last_seen_at: number;
  /** OMBs the peer currently holds (live count from inscriptions). */
  omb_count: number;
  /** Matrica display info for this peer wallet, if linked. */
  matrica: { user_id: string; username: string | null; avatar_url: string | null } | null;
};

/**
 * Holder-profile helper: aggregate inferred links across a set of
 * Matrica-grouped wallets, exclude peers already in that set, fold each
 * peer's max confidence + summed counts, and join Matrica display info.
 *
 * The exclusion is the important bit — Matrica-confirmed siblings are
 * displayed elsewhere in the profile; this section is for ON-CHAIN-ONLY
 * candidates, never duplicating wallets the user already trusts.
 */
export function getLikelyLinkedForWallets(
  wallets: readonly string[],
  minConfidence: number = 9900,
  limit = 50
): LikelyLinkedRow[] {
  if (wallets.length === 0) return [];
  const db = getDb();
  const owned = new Set(wallets);

  // Per-peer aggregate. Walk each input wallet's edges, fold by peer.
  const byPeer = new Map<
    string,
    {
      confidence: number;
      cih_count: number;
      self_xfer_count: number;
      evidence: EvidenceItem[];
      last_seen_at: number;
    }
  >();

  const select = db.prepare(
    `SELECT addr_a, addr_b, confidence, cih_count, self_xfer_count,
            co_cons_count, co_parent_count,
            pmx_count, pmx_rt_count,
            evidence_json, last_seen_at
       FROM wallet_cluster_edges
      WHERE (addr_a = @addr OR addr_b = @addr)
        AND confidence >= @min
      ORDER BY confidence DESC, last_seen_at DESC
      LIMIT 200`
  );

  const msrSet = loadMsrSet();
  for (const w of wallets) {
    const rows = select.all({ addr: w, min: minConfidence }) as Array<{
      addr_a: string;
      addr_b: string;
      confidence: number;
      cih_count: number;
      self_xfer_count: number;
      co_cons_count: number;
      co_parent_count: number;
      pmx_count: number;
      pmx_rt_count: number;
      evidence_json: string;
      last_seen_at: number;
    }>;
    for (const r of rows) {
      if (isCrossTraderEdge(r, msrSet)) continue;
      const peer = r.addr_a === w ? r.addr_b : r.addr_a;
      if (owned.has(peer)) continue;
      let evidence: EvidenceItem[] = [];
      try {
        const parsed = JSON.parse(r.evidence_json);
        if (Array.isArray(parsed)) evidence = parsed as EvidenceItem[];
      } catch {
        /* ignore */
      }
      const existing = byPeer.get(peer);
      if (!existing) {
        byPeer.set(peer, {
          confidence: r.confidence,
          cih_count: r.cih_count,
          self_xfer_count: r.self_xfer_count,
          evidence,
          last_seen_at: r.last_seen_at,
        });
      } else {
        existing.confidence = Math.max(existing.confidence, r.confidence);
        existing.cih_count += r.cih_count;
        existing.self_xfer_count += r.self_xfer_count;
        existing.last_seen_at = Math.max(existing.last_seen_at, r.last_seen_at);
        // Append evidence items, capped — preserve most recent across folds.
        for (const e of evidence) {
          const dup = existing.evidence.some(
            x => x.type === e.type && x.txid === e.txid
          );
          if (!dup) existing.evidence.push(e);
        }
        if (existing.evidence.length > 10) {
          existing.evidence.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
          existing.evidence = existing.evidence.slice(0, 10);
        }
      }
    }
  }

  if (byPeer.size === 0) return [];

  // Filter peers whose /holder/<addr> page would 404, and compute the live
  // OMB-holding count for the remainder. The 404 condition matches
  // src/app/holder/[address]/page.tsx exactly: no inscriptions held AND no
  // events touching the address. Pure funding-only co-spenders (typical
  // P2SH change wallets that contribute fee inputs but never own an OMB)
  // are real signal but produce dead links — drop them at the reader.
  const peerMeta = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM inscriptions
         WHERE effective_owner = @peer AND collection_slug = 'omb') AS omb_count,
       EXISTS(SELECT 1 FROM events
               WHERE old_owner = @peer OR new_owner = @peer) AS has_event,
       EXISTS(SELECT 1 FROM inscriptions
               WHERE effective_owner = @peer) AS has_insc`
  );
  const peerCounts = new Map<string, number>();
  Array.from(byPeer.keys()).forEach(peer => {
    const m = peerMeta.get({ peer }) as {
      omb_count: number;
      has_event: number;
      has_insc: number;
    };
    if (!m.has_event && !m.has_insc) {
      byPeer.delete(peer);
      return;
    }
    peerCounts.set(peer, m.omb_count);
  });

  if (byPeer.size === 0) return [];

  // Join Matrica info for each peer in one statement.
  const peers = Array.from(byPeer.keys());
  const placeholders = peers.map(() => '?').join(',');
  const matricaByAddr = new Map<
    string,
    { user_id: string; username: string | null; avatar_url: string | null }
  >();
  if (peers.length > 0) {
    const rows = db
      .prepare(
        `SELECT wl.wallet_addr AS addr, mu.user_id AS user_id, mu.username AS username, mu.avatar_url AS avatar_url
           FROM wallet_links wl
           LEFT JOIN matrica_users mu ON mu.user_id = wl.matrica_user_id
          WHERE wl.matrica_user_id IS NOT NULL
            AND wl.wallet_addr IN (${placeholders})`
      )
      .all(...peers) as Array<{
      addr: string;
      user_id: string;
      username: string | null;
      avatar_url: string | null;
    }>;
    for (const r of rows) {
      matricaByAddr.set(r.addr, {
        user_id: r.user_id,
        username: r.username,
        avatar_url: r.avatar_url,
      });
    }
  }

  const out: LikelyLinkedRow[] = [];
  Array.from(byPeer.entries()).forEach(([peer, agg]) => {
    out.push({
      peer,
      confidence: agg.confidence,
      cih_count: agg.cih_count,
      self_xfer_count: agg.self_xfer_count,
      evidence: agg.evidence,
      last_seen_at: agg.last_seen_at,
      omb_count: peerCounts.get(peer) ?? 0,
      matrica: matricaByAddr.get(peer) ?? null,
    });
  });
  out.sort((a, b) => b.confidence - a.confidence || b.last_seen_at - a.last_seen_at);
  return out.slice(0, limit);
}
