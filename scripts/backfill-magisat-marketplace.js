#!/usr/bin/env node
/* eslint-disable */
// Backfill marketplace='magisat' on `sold` events that arrived via the
// ord.net aggregator (which leaves marketplace=NULL because it doesn't
// disclose the originating venue).
//
// Magisat sales follow a recurring on-chain shape: a 4-output tx where
// vout[1] sends a small fee to MAGISAT_FEE_ADDR. Probing the funding tx
// for this signal is unambiguous — that address is a fee collector,
// not a buyer/seller wallet.
//
// Required env:
//   BITCOIN_RPC_URL              e.g. http://user:pass@127.0.0.1:8332
// Optional env:
//   OMB_DB_PATH                  default /data/app.db
//   MAGISAT_BACKFILL_CONCURRENCY default 8
//
// CLI flags:
//   --dry-run                    Don't write. Logs candidates only.
//   --since=<unix>               Restrict to events with block_timestamp >= unix.
//   --max-events=N               Safety cap on the work set.
//
// Idempotent. Re-running is a no-op once rows are tagged.
// Backfill paths NEVER enqueue notify_pending — historical re-classifications
// must not alert subscribers.

const Database = require('better-sqlite3');

const MAGISAT_FEE_ADDR =
  'bc1papmpmu0xzfvw4x9qe4jstgxfnfy5q8zhh6xredjxd86ca74uph3s59se9u';

// ---------------- env + args ----------------

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
    return { url: null, authHeader: null };
  }
})();

if (!RPC_URL) {
  console.error('error: BITCOIN_RPC_URL is required');
  process.exit(1);
}

const DB_PATH = process.env.OMB_DB_PATH || '/data/app.db';
const CONCURRENCY = Number(process.env.MAGISAT_BACKFILL_CONCURRENCY || 8);

const args = new Map();
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args.set(m[1], m[2] ?? true);
}
const DRY_RUN = !!args.get('dry-run');
const SINCE = args.get('since') ? Number(args.get('since')) : 0;
const MAX_EVENTS = args.get('max-events') ? Number(args.get('max-events')) : Infinity;

// ---------------- bitcoind ----------------

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(RPC_AUTH ? { authorization: RPC_AUTH } : {}) },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'magisat-backfill', method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method} failed: ${JSON.stringify(json.error)}`);
  return json.result;
}

const txCache = new Map();
async function getTx(txid) {
  if (txCache.has(txid)) return txCache.get(txid);
  const tx = await rpc('getrawtransaction', [txid, 2]);
  txCache.set(txid, tx);
  return tx;
}

// ---------------- main ----------------

(async () => {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  const candidates = db
    .prepare(
      `SELECT id, inscription_number, txid
       FROM events
       WHERE event_type = 'sold' AND marketplace IS NULL
         AND block_timestamp >= ?
       ORDER BY id ASC
       LIMIT ?`
    )
    .all(SINCE, Number.isFinite(MAX_EVENTS) ? MAX_EVENTS : -1);

  console.log(
    `[magisat-backfill] candidates=${candidates.length} dry_run=${DRY_RUN} since=${SINCE} db=${DB_PATH}`
  );
  if (candidates.length === 0) return db.close();

  const update = db.prepare(`UPDATE events SET marketplace = 'magisat' WHERE id = ?`);

  let matched = 0;
  let probed = 0;
  let errors = 0;

  // Run with bounded concurrency.
  let cursor = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < candidates.length) {
      const c = candidates[cursor++];
      probed++;
      try {
        const tx = await getTx(c.txid);
        const vout1 = tx.vout?.[1]?.scriptPubKey?.address;
        if (vout1 === MAGISAT_FEE_ADDR) {
          if (!DRY_RUN) update.run(c.id);
          matched++;
          if (matched % 50 === 0 || matched < 20) {
            console.log(
              `[magisat-backfill] match ins=${c.inscription_number} tx=${c.txid.slice(0, 12)}.. (${matched} so far)`
            );
          }
        }
      } catch (err) {
        errors++;
        console.error(`[magisat-backfill] error ins=${c.inscription_number} tx=${c.txid}: ${err.message}`);
      }
    }
  });
  await Promise.all(workers);

  console.log(
    `[magisat-backfill] done. probed=${probed} matched=${matched} errors=${errors} dry_run=${DRY_RUN}`
  );
  db.close();
})().catch((err) => {
  console.error('[magisat-backfill] fatal:', err);
  process.exit(1);
});
