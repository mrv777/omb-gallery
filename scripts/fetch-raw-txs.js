#!/usr/bin/env node
/* eslint-disable */
// Bulk raw-tx fetcher for the on-chain wallet clustering pipeline.
//
// Walks every distinct txid in `events` and caches getrawtransaction
// verbose=2 to disk. Idempotent (skips cached files), resumable, and
// safe to interrupt — partial files are written via tmp + rename.
//
// Intended to run on the prod host (where bitcoind is colocated). Tar
// the cache when done and scp the archive down for local clustering
// iteration:
//
//   ssh ubuntu@omb-prod 'cd $HOME && OMB_DB_PATH=/var/lib/coolify-omb-data/app.db \
//       BITCOIN_RPC_URL=http://user:pass@127.0.0.1:8332 \
//       node /path/to/fetch-raw-txs.js --cache-dir=$HOME/raw-txs-cache'
//   ssh ubuntu@omb-prod 'tar -czf raw-txs-cache.tgz -C $HOME raw-txs-cache'
//   scp ubuntu@omb-prod:raw-txs-cache.tgz .
//
// CLI flags:
//   --cache-dir=PATH   Where to write tx files. Default ~/.cache/omb-cluster/raw-txs.
//   --concurrency=N    Parallel RPC requests. Default 8.
//   --max-fetch=N      Stop after fetching N new txs (excluding cache hits).
//   --include-sold     Also fetch txids of `sold` and `loan-*` events. Default
//                      we only fetch CIH-eligible txs (everything except sold
//                      and loan-*, which the cluster pipeline excludes anyway).
//   --verbose          Per-tx log lines.
//   --progress=N       Log every N processed txids. Default 500.

const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

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

const DB_PATH = process.env.OMB_DB_PATH ?? path.resolve(__dirname, '..', 'tmp', 'dev.db');
const REQUEST_TIMEOUT_MS = 30_000;
const HOME =
  process.env.HOME || process.env.USERPROFILE || path.resolve(__dirname, '..', 'tmp');
const DEFAULT_CACHE_DIR = path.join(HOME, '.cache', 'omb-cluster', 'raw-txs');

const ARGS = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = {
    cacheDir: DEFAULT_CACHE_DIR,
    concurrency: 8,
    maxFetch: null,
    includeSold: false,
    verbose: false,
    progress: 500,
  };
  for (const a of argv) {
    if (a === '--include-sold') out.includeSold = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a.startsWith('--cache-dir=')) {
      out.cacheDir = a.slice('--cache-dir='.length);
    } else if (a.startsWith('--concurrency=')) {
      out.concurrency = parseInt(a.slice('--concurrency='.length), 10);
    } else if (a.startsWith('--max-fetch=')) {
      out.maxFetch = parseInt(a.slice('--max-fetch='.length), 10);
    } else if (a.startsWith('--progress=')) {
      out.progress = parseInt(a.slice('--progress='.length), 10);
    } else {
      console.error(`[fetch-raw-txs] unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

if (!RPC_URL) {
  console.error('[fetch-raw-txs] BITCOIN_RPC_URL is required');
  process.exit(1);
}
if (!fs.existsSync(DB_PATH)) {
  console.error(`[fetch-raw-txs] OMB_DB_PATH not found: ${DB_PATH}`);
  process.exit(1);
}

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
      const body = await res.text().catch(() => '');
      throw new Error(`rpc ${method} HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const j = await res.json();
    if (j.error) throw new Error(`rpc ${method} error: ${JSON.stringify(j.error)}`);
    return j.result;
  } finally {
    clearTimeout(t);
  }
}

function cachePathFor(txid) {
  return path.join(ARGS.cacheDir, txid.slice(0, 2), `${txid}.json`);
}

function ensureDirSync(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  ensureDirSync(dir);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function existsCached(txid) {
  try {
    return fs.statSync(cachePathFor(txid)).size > 0;
  } catch {
    return false;
  }
}

async function runWithLimit(tasks, limit, onProgress) {
  let cursor = 0;
  let active = 0;
  let done = 0;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cursor === tasks.length && active === 0) return resolve();
      while (active < limit && cursor < tasks.length) {
        const idx = cursor++;
        active++;
        Promise.resolve(tasks[idx]())
          .then(() => {
            done++;
            active--;
            if (onProgress) onProgress(done);
            tick();
          })
          .catch((err) => {
            reject(err);
          });
      }
    };
    tick();
  });
}

async function main() {
  ensureDirSync(ARGS.cacheDir);
  // readonly: skip the journal_mode pragma — it would attempt a write.
  const db = new Database(DB_PATH, { readonly: true });

  // CIH-eligible txids: everything except marketplace settlements (sold) and
  // Liquidium loan moves (loan-*) — those PSBTs splice unrelated parties so
  // CIH wouldn't apply. Include them only with --include-sold for forensic
  // re-analysis (e.g. tuning the auto-high-degree threshold against
  // marketplace-aware corpus).
  const eligibleTypes = ARGS.includeSold
    ? ['transferred', 'inscribed', 'mint', 'sold', 'listed',
       'loan-originated', 'loan-defaulted', 'loan-repaid', 'loan-unlocked']
    : ['transferred', 'inscribed', 'mint'];
  const placeholders = eligibleTypes.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT DISTINCT txid FROM events WHERE event_type IN (${placeholders}) AND txid IS NOT NULL`
    )
    .all(...eligibleTypes);

  const allTxids = rows.map((r) => r.txid);
  console.log(`[fetch-raw-txs] candidate txids: ${allTxids.length}`);

  // Filter to those not already cached.
  const todo = [];
  let cached = 0;
  for (const txid of allTxids) {
    if (existsCached(txid)) cached++;
    else todo.push(txid);
  }
  console.log(`[fetch-raw-txs] already cached: ${cached}, to fetch: ${todo.length}`);

  if (ARGS.maxFetch && todo.length > ARGS.maxFetch) {
    console.log(`[fetch-raw-txs] capping fetch to ${ARGS.maxFetch} (--max-fetch)`);
    todo.length = ARGS.maxFetch;
  }

  let fetched = 0;
  let failed = 0;
  const start = Date.now();
  const tasks = todo.map((txid) => async () => {
    try {
      const tx = await rpc('getrawtransaction', [txid, 2]);
      // Slim payload — keep what the cluster pipeline needs:
      //   - vin[].prevout.scriptPubKey.address  → CIH input party identity
      //   - vin[].txinwitness[0]                → SIGHASH flag detection
      //                                            (last byte 0x83 = ACP, see
      //                                            marketplaceFingerprint.ts).
      //                                            Only the first witness
      //                                            element holds the schnorr
      //                                            sig — additional elements
      //                                            (control block, leaf
      //                                            script) are not needed
      //                                            here.
      //   - blocktime                           → evidence ordering.
      // Strip vout entirely; the cluster heuristics don't read it.
      const slim = {
        txid: tx.txid,
        blocktime: tx.blocktime ?? null,
        vin: (tx.vin || []).map((v) => ({
          prevout: v.prevout
            ? {
                scriptPubKey: v.prevout.scriptPubKey
                  ? { address: v.prevout.scriptPubKey.address ?? null }
                  : undefined,
              }
            : undefined,
          txinwitness:
            Array.isArray(v.txinwitness) && v.txinwitness.length > 0
              ? [v.txinwitness[0]]
              : undefined,
        })),
      };
      writeAtomic(cachePathFor(txid), JSON.stringify(slim));
      fetched++;
      if (ARGS.verbose) console.log(`[fetch-raw-txs] ${txid} ok`);
    } catch (err) {
      failed++;
      console.error(`[fetch-raw-txs] ${txid} failed: ${err && err.message ? err.message : err}`);
    }
  });

  await runWithLimit(tasks, ARGS.concurrency, (done) => {
    if (done % ARGS.progress === 0) {
      const dur = (Date.now() - start) / 1000;
      const rate = done / Math.max(dur, 1);
      const remain = todo.length - done;
      const eta = remain / Math.max(rate, 1);
      console.log(
        `[fetch-raw-txs] progress ${done}/${todo.length} ` +
          `(${rate.toFixed(1)}/s, eta ${(eta / 60).toFixed(1)}min, failed=${failed})`
      );
    }
  });

  const dur = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `[fetch-raw-txs] done. fetched=${fetched} failed=${failed} cached_already=${cached} dur=${dur}s`
  );
  db.close();
  if (failed > 0) process.exit(2);
}

main().catch((err) => {
  console.error('[fetch-raw-txs] fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
});
