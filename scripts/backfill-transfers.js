#!/usr/bin/env node
/* eslint-disable */
// One-shot historical-transfer backfill.
// For each inscription with current_output set, walk the spend chain backwards
// via bitcoind JSON-RPC (getrawtransaction verbosity=2, which inlines prevouts)
// emitting a `transferred` event per hop until the genesis tx.
//
// Required env:
//   BITCOIN_RPC_URL    e.g. http://user:<password>@127.0.0.1:8332
//   ORD_BASE_URL       e.g. http://your-ord-host:port
// Optional:
//   OMB_DB_PATH        default ./tmp/dev.db
//   BACKFILL_CONCURRENCY  default 8 (be polite to your ord node)
//   BACKFILL_LIMIT     debug: only process N inscriptions
//   BACKFILL_ONLY      debug: only process this inscription_number
//   BACKFILL_MAX_HOPS  safety cap per inscription (default 250)
//
// CLI flags (override env where they overlap):
//   --smoke                 Phase 2a smoke test: walk one inscription, pretty-print
//                           the chain, do NOT write to the DB. Validates that the
//                           home node's bitcoind/ord agree on satpoints + addresses
//                           before we trust the full run.
//   --inscription-id=<id>   Inscription ID to walk (smoke mode). Mutually
//                           exclusive with --inscription-number.
//   --inscription-number=N  Inscription number to walk (smoke mode). Resolved
//                           via ord /inscription/<N>.

const path = require('node:path');
// better-sqlite3 is only needed in full-backfill mode (main()). Smoke mode
// (Phase 2a) walks one inscription against ord+bitcoind and prints the chain
// without ever opening the DB, so we lazy-load this require to let the smoke
// path run on a host that doesn't have the native module compiled.
let Database = null;
function loadDatabase() {
  if (!Database) Database = require('better-sqlite3');
  return Database;
}

// Node's fetch (undici) refuses URLs containing inline credentials, so split
// the user:pass off into a Basic Authorization header.
const { url: RPC_URL, authHeader: RPC_AUTH } = (() => {
  const raw = process.env.BITCOIN_RPC_URL;
  if (!raw) return { url: null, authHeader: null };
  try {
    const u = new URL(raw);
    const user = decodeURIComponent(u.username);
    const pass = decodeURIComponent(u.password);
    u.username = '';
    u.password = '';
    const authHeader =
      user || pass ? 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') : null;
    return { url: u.toString(), authHeader };
  } catch {
    return { url: raw, authHeader: null };
  }
})();
const ORD_BASE = (process.env.ORD_BASE_URL ?? '').replace(/\/+$/, '');
const DB_PATH = process.env.OMB_DB_PATH ?? path.resolve(__dirname, '..', 'tmp', 'dev.db');
const CONCURRENCY = parseInt(process.env.BACKFILL_CONCURRENCY ?? '8', 10);
const LIMIT = process.env.BACKFILL_LIMIT ? parseInt(process.env.BACKFILL_LIMIT, 10) : null;
const ONLY = process.env.BACKFILL_ONLY ? parseInt(process.env.BACKFILL_ONLY, 10) : null;
const MAX_HOPS = parseInt(process.env.BACKFILL_MAX_HOPS ?? '250', 10);
const REQUEST_TIMEOUT_MS = 30_000;

const ARGS = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = { smoke: false, inscriptionId: null, inscriptionNumber: null };
  for (const a of argv) {
    if (a === '--smoke') out.smoke = true;
    else if (a.startsWith('--inscription-id=')) out.inscriptionId = a.slice('--inscription-id='.length);
    else if (a.startsWith('--inscription-number=')) {
      const n = parseInt(a.slice('--inscription-number='.length), 10);
      if (Number.isFinite(n)) out.inscriptionNumber = n;
    }
  }
  return out;
}

if (!RPC_URL) {
  console.error('[backfill] BITCOIN_RPC_URL is required');
  process.exit(1);
}
if (!ORD_BASE) {
  console.error('[backfill] ORD_BASE_URL is required (we need ord for satpoints incl. offset)');
  process.exit(1);
}

// ---------------- bitcoind RPC ----------------

let rpcId = 0;
async function rpc(method, params = []) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = { 'content-type': 'application/json' };
    if (RPC_AUTH) headers['authorization'] = RPC_AUTH;
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '1.0', id: ++rpcId, method, params }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const body = await safeText(res);
      throw new Error(`rpc ${method} HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const j = await res.json();
    if (j.error) throw new Error(`rpc ${method} error: ${JSON.stringify(j.error)}`);
    return j.result;
  } finally {
    clearTimeout(t);
  }
}

async function safeText(r) {
  try {
    return await r.text();
  } catch {
    return '';
  }
}

const headerCache = new Map(); // blockhash -> {height, time}
async function getHeader(blockhash) {
  let v = headerCache.get(blockhash);
  if (v) return v;
  const h = await rpc('getblockheader', [blockhash, true]);
  v = { height: h.height, time: h.time };
  headerCache.set(blockhash, v);
  return v;
}

// ---------------- ord (satpoints) ----------------

async function fetchOrdInscription(numOrId) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(`${ORD_BASE}/inscription/${numOrId}`, {
      headers: { Accept: 'application/json' },
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// satpoint format: <txid>:<vout>:<offset>
function parseSatpoint(s) {
  if (!s || typeof s !== 'string') return null;
  const parts = s.split(':');
  if (parts.length < 3) return null;
  const txid = parts[0];
  const vout = parseInt(parts[1], 10);
  const offset = BigInt(parts[2]);
  if (!/^[0-9a-f]{64}$/i.test(txid)) return null;
  if (!Number.isFinite(vout) || vout < 0) return null;
  return { txid: txid.toLowerCase(), vout, offset };
}

// inscription_id format: <txid>i<index>
function genesisTxidFromId(inscriptionId) {
  if (typeof inscriptionId !== 'string') return null;
  const idx = inscriptionId.indexOf('i');
  if (idx !== 64) return null;
  const tx = inscriptionId.slice(0, 64);
  return /^[0-9a-f]{64}$/i.test(tx) ? tx.toLowerCase() : null;
}

// ord serves values in BTC (json) — we use sats here. 1 BTC = 1e8 sat.
// Rounding via Math.round(value * 1e8) loses precision for very large values;
// stay in BigInt and parse the decimal string directly.
function btcToSats(v) {
  if (typeof v === 'number') return BigInt(Math.round(v * 1e8));
  if (typeof v === 'string') {
    const [whole, frac = ''] = v.split('.');
    const padded = (frac + '00000000').slice(0, 8);
    return BigInt(whole || '0') * 100_000_000n + BigInt(padded || '0');
  }
  return 0n;
}

function addressFromScriptPubKey(spk) {
  if (!spk || typeof spk !== 'object') return null;
  if (typeof spk.address === 'string' && spk.address.length > 0) return spk.address;
  if (Array.isArray(spk.addresses) && typeof spk.addresses[0] === 'string') return spk.addresses[0];
  return null;
}

// ---------------- chain walk ----------------

async function walkInscription({ inscription_id, inscription_number, satpoint, hops }) {
  const events = [];
  const genesis = genesisTxidFromId(inscription_id);
  if (!genesis) return { events, reason: 'no-genesis' };

  let cur = parseSatpoint(satpoint);
  if (!cur) return { events, reason: 'bad-satpoint' };

  let hopsLeft = MAX_HOPS;
  while (hopsLeft-- > 0) {
    if (cur.txid === genesis) return { events, reason: 'reached-genesis' };

    const tx = await rpc('getrawtransaction', [cur.txid, 2]);
    if (!tx || !Array.isArray(tx.vin) || !Array.isArray(tx.vout)) {
      return { events, reason: 'bad-tx' };
    }
    if (tx.vin.some((i) => i && i.coinbase)) {
      return { events, reason: 'coinbase' };
    }

    // absolute_offset within the *inputs* combined sat stream:
    //   sum(vout[0..cur.vout-1].value) + cur.offset
    let absOffset = cur.offset;
    for (let i = 0; i < cur.vout; i++) {
      absOffset += btcToSats(tx.vout[i].value);
    }

    // Walk inputs in order, find which carries our sat.
    let acc = 0n;
    let carryIdx = -1;
    let newOffset = 0n;
    for (let i = 0; i < tx.vin.length; i++) {
      const vin = tx.vin[i];
      const prev = vin.prevout;
      if (!prev) return { events, reason: 'no-prevout' }; // verbosity=2 missing on this Core?
      const v = btcToSats(prev.value);
      if (absOffset < acc + v) {
        carryIdx = i;
        newOffset = absOffset - acc;
        break;
      }
      acc += v;
    }
    if (carryIdx === -1) return { events, reason: 'sat-not-in-inputs' };

    const carryVin = tx.vin[carryIdx];
    const newOwner = addressFromScriptPubKey(tx.vout[cur.vout]?.scriptPubKey);
    const oldOwner = addressFromScriptPubKey(carryVin.prevout?.scriptPubKey);

    let height = null;
    let timestamp = tx.blocktime ?? tx.time ?? null;
    if (tx.blockhash) {
      try {
        const h = await getHeader(tx.blockhash);
        height = h.height;
        if (timestamp == null) timestamp = h.time;
      } catch {
        /* unconfirmed or pruned-header: leave null */
      }
    }

    events.push({
      inscription_id,
      inscription_number,
      txid: cur.txid,
      block_height: height,
      block_timestamp: timestamp ?? 0,
      new_owner: newOwner,
      old_owner: oldOwner,
      new_satpoint: `${cur.txid}:${cur.vout}:${cur.offset.toString()}`,
    });
    hops.value++;

    cur = {
      txid: carryVin.txid.toLowerCase(),
      vout: carryVin.vout,
      offset: newOffset,
    };
  }
  return { events, reason: 'max-hops' };
}

// ---------------- main ----------------

async function main() {
  const db = new (loadDatabase())(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO events (
      inscription_id, inscription_number, event_type, block_height, block_timestamp,
      new_satpoint, old_owner, new_owner, marketplace, sale_price_sats, txid, raw_json
    ) VALUES (
      @inscription_id, @inscription_number, 'transferred', @block_height, @block_timestamp,
      @new_satpoint, @old_owner, @new_owner, NULL, NULL, @txid, NULL
    )
  `);
  const bumpAggregates = db.prepare(`
    UPDATE inscriptions SET
      transfer_count   = transfer_count + 1,
      last_movement_at = MAX(COALESCE(last_movement_at, 0), @block_timestamp)
    WHERE inscription_number = @inscription_number
  `);
  const upsertFirstLast = db.prepare(`
    UPDATE inscriptions SET
      first_event_at = MIN(COALESCE(first_event_at, @block_timestamp), @block_timestamp),
      last_event_at  = MAX(COALESCE(last_event_at,  0), @block_timestamp)
    WHERE inscription_number = @inscription_number
  `);

  const flush = db.transaction((rows) => {
    let inserted = 0;
    for (const r of rows) {
      const res = insertEvent.run(r);
      if (res.changes > 0) {
        inserted++;
        bumpAggregates.run({
          inscription_number: r.inscription_number,
          block_timestamp: r.block_timestamp,
        });
        upsertFirstLast.run({
          inscription_number: r.inscription_number,
          block_timestamp: r.block_timestamp,
        });
      }
    }
    return inserted;
  });

  // Test RPC + ord up front so we fail fast.
  try {
    const info = await rpc('getblockchaininfo', []);
    console.log(`[backfill] bitcoind ok: blocks=${info.blocks} chain=${info.chain}`);
  } catch (e) {
    console.error('[backfill] bitcoind RPC failed:', e.message);
    process.exit(1);
  }
  if (!ORD_BASE) {
    console.error('[backfill] ord base URL missing'); process.exit(1);
  }

  const where = ['inscription_id IS NOT NULL', 'current_output IS NOT NULL'];
  const params = {};
  if (ONLY != null) {
    where.push('inscription_number = @only');
    params.only = ONLY;
  }
  let sql =
    `SELECT inscription_number, inscription_id FROM inscriptions ` +
    `WHERE ${where.join(' AND ')} ORDER BY inscription_number`;
  if (LIMIT) sql += ` LIMIT ${LIMIT}`;
  const targets = db.prepare(sql).all(params);

  console.log(
    `[backfill] db=${DB_PATH} targets=${targets.length} concurrency=${CONCURRENCY} max_hops=${MAX_HOPS}`
  );
  if (targets.length === 0) {
    console.log('[backfill] nothing to do'); db.close(); return;
  }

  let next = 0;
  let processed = 0;
  let totalHops = 0;
  let totalInserted = 0;
  let errors = 0;
  const reasons = Object.create(null);
  const startedAt = Date.now();

  async function worker() {
    while (next < targets.length) {
      const i = next++;
      const t = targets[i];
      try {
        const insc = await fetchOrdInscription(t.inscription_id);
        if (!insc || !insc.satpoint) {
          reasons['no-ord-satpoint'] = (reasons['no-ord-satpoint'] ?? 0) + 1;
          continue;
        }
        const hopsCounter = { value: 0 };
        const { events, reason } = await walkInscription({
          inscription_id: t.inscription_id,
          inscription_number: t.inscription_number,
          satpoint: insc.satpoint,
          hops: hopsCounter,
        });
        reasons[reason] = (reasons[reason] ?? 0) + 1;
        if (events.length > 0) {
          const inserted = flush(events);
          totalInserted += inserted;
        }
        totalHops += hopsCounter.value;
      } catch (e) {
        errors++;
        if (errors <= 5) {
          console.error(`[backfill] #${t.inscription_number} (${t.inscription_id}):`, e.message);
        }
      }
      processed++;
      if (processed % 50 === 0) {
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = processed / elapsed;
        const eta = Math.round((targets.length - processed) / rate);
        console.log(
          `[backfill] ${processed}/${targets.length} ` +
            `inserted=${totalInserted} hops=${totalHops} err=${errors} ` +
            `${rate.toFixed(1)}/s eta=${eta}s`
        );
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[backfill] DONE in ${elapsed}s — inserted=${totalInserted} hops=${totalHops} err=${errors}`);
  console.log('[backfill] reasons:', reasons);

  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM events WHERE event_type='transferred') AS transferred,
         (SELECT COUNT(*) FROM events) AS total_events,
         (SELECT COUNT(DISTINCT inscription_number) FROM events WHERE event_type='transferred') AS inscriptions_with_transfers`
    )
    .get();
  console.log('[backfill] counts:', counts);
  db.close();
}

// ---------------- smoke mode (Phase 2a) ----------------
//
// Walks a single inscription end-to-end without touching the DB. Used to
// validate that the home node's bitcoind/ord agree on satpoints + addresses
// before we trust the full run. Compare the printed chain against an external
// source-of-truth (BiS screenshots, mempool.space) for an inscription with
// rich transfer history.
async function smoke() {
  if (!ARGS.inscriptionId && ARGS.inscriptionNumber == null) {
    console.error(
      '[smoke] --inscription-id=<id> or --inscription-number=<n> is required in smoke mode'
    );
    process.exit(1);
  }

  // Fail-fast probes so a bad RPC URL or unreachable ord shows up at the
  // top of the output instead of buried inside the walk.
  try {
    const info = await rpc('getblockchaininfo', []);
    console.log(`[smoke] bitcoind ok: blocks=${info.blocks} chain=${info.chain}`);
  } catch (e) {
    console.error('[smoke] bitcoind RPC failed:', e.message);
    process.exit(1);
  }

  const lookup = ARGS.inscriptionId ?? ARGS.inscriptionNumber;
  const insc = await fetchOrdInscription(lookup);
  if (!insc) {
    console.error(`[smoke] ord returned no inscription for ${lookup}`);
    process.exit(1);
  }
  const inscription_id = insc.id ?? insc.inscription_id ?? ARGS.inscriptionId;
  const inscription_number = insc.number ?? insc.inscription_number ?? ARGS.inscriptionNumber;
  if (!insc.satpoint) {
    console.error(`[smoke] ord response missing satpoint for ${inscription_id}`);
    console.error('[smoke] response:', JSON.stringify(insc).slice(0, 400));
    process.exit(1);
  }
  console.log(
    `[smoke] inscription #${inscription_number} (${inscription_id})\n` +
      `        current_satpoint = ${insc.satpoint}\n` +
      `        current_address  = ${insc.address ?? '<none>'}\n` +
      `        genesis_height   = ${insc.height ?? insc.genesis_height ?? '?'}\n`
  );

  const hops = { value: 0 };
  const startedAt = Date.now();
  const { events, reason } = await walkInscription({
    inscription_id,
    inscription_number,
    satpoint: insc.satpoint,
    hops,
  });
  const elapsedMs = Date.now() - startedAt;

  if (events.length === 0) {
    console.log(`[smoke] no transfer events walked. reason=${reason}`);
    console.log(
      `[smoke] (an inscription that has never moved post-genesis will land here — try a richer one.)`
    );
    return;
  }

  // Walker produces hops in newest→oldest order. Print in chronological order
  // (oldest→newest) so it matches how a user reads transfer history elsewhere.
  console.log(`[smoke] walked ${events.length} hop(s) in ${elapsedMs}ms — reason=${reason}\n`);
  const chrono = [...events].reverse();
  for (let i = 0; i < chrono.length; i++) {
    const e = chrono[i];
    const ts = e.block_timestamp
      ? new Date(e.block_timestamp * 1000).toISOString()
      : '<unconfirmed>';
    const height = e.block_height ?? '?';
    console.log(
      `  #${i + 1}  block ${height}  ${ts}\n` +
        `      txid:   ${e.txid}\n` +
        `      from:   ${e.old_owner ?? '<unknown>'}\n` +
        `      to:     ${e.new_owner ?? '<unknown>'}\n` +
        `      satpoint: ${e.new_satpoint}`
    );
  }
  console.log(
    `\n[smoke] DONE — cross-check the chain above against mempool.space or BiS screenshots.\n` +
      `        if heights/addresses match, ord's spent-output mapping is good and we can\n` +
      `        proceed with Phase 2b (full walker against the prod DB).`
  );
}

if (ARGS.smoke) {
  smoke().catch((e) => {
    console.error('[smoke] FATAL:', e);
    process.exit(1);
  });
} else {
  main().catch((e) => { console.error('[backfill] FATAL:', e); process.exit(1); });
}
