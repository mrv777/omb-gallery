#!/usr/bin/env node
/* eslint-disable */
// On-chain Magic Eden marketplace tagger.
//
// Walks every `transferred` and `marketplace IS NULL` `sold` event in the DB,
// fetches the underlying tx via bitcoind RPC, and applies the §2.10 fingerprint
// from ONCHAIN_TAGGING.md:
//   - any vout's address ∈ MAGIC_EDEN_FEE_ADDRS
//   - any sighash flag (ACP shape: ≥1 vin signed 0x83; cooperative shape:
//     SIGHASH_ALL/DEFAULT — no ACP required)
//
// On match:
//   - if event_type='transferred' → upgrade to 'sold', set marketplace=
//     'magic-eden', extract sale_price_sats per the shape rule below,
//     recompute aggregates.
//   - if event_type='sold' AND marketplace IS NULL → tag marketplace=
//     'magic-eden' and (if our extracted price disagrees with existing
//     sale_price_sats by >1%) log a warning. Don't overwrite price.
//   - if event_type='sold' AND marketplace='satflow' (or other) → log + skip.
//
// Sale-price extraction:
//   - ACP shape: SIGHASH_SINGLE commits input N → output N. Sum vout[N].value
//     for each ACP input N whose prevout.address == old_owner.
//   - Cooperative shape: vout[feeVoutIdx - 1] is the seller payment in every
//     fixture in §6.6 (consistent layout across years). Returns null when
//     that points at the inscription destination (vout[0]) — that's the
//     no-payment delivery-leg case (#11273300), not a real sale.
//
// Idempotent. Required env: BITCOIN_RPC_URL. Required env: OMB_DB_PATH.
//
// CLI flags:
//   --dry-run                 Read-only; report counts.
//   --inscription-number=N    Limit to one inscription (debugging).
//   --since=UNIX_TS           Only events with block_timestamp >= UNIX_TS.
//   --max-events=N            Stop after scanning N events.
//   --verbose                 Per-event log lines.

const path = require('node:path');
const Database = require('better-sqlite3');

// ---- env + args ----
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
const CONCURRENCY = parseInt(process.env.MAGIC_EDEN_FP_CONCURRENCY ?? '8', 10);

const ARGS = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = {
    dryRun: false,
    inscriptionNumber: null,
    since: null,
    maxEvents: null,
    verbose: false,
  };
  for (const a of argv) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a.startsWith('--inscription-number=')) {
      out.inscriptionNumber = parseInt(a.slice('--inscription-number='.length), 10);
    } else if (a.startsWith('--since=')) {
      out.since = parseInt(a.slice('--since='.length), 10);
    } else if (a.startsWith('--max-events=')) {
      out.maxEvents = parseInt(a.slice('--max-events='.length), 10);
    } else {
      console.error(`[magic-eden-fp] unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

if (!RPC_URL) {
  console.error('[magic-eden-fp] BITCOIN_RPC_URL is required');
  process.exit(1);
}

// ---- bitcoind RPC ----
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

// ---- fingerprint (mirrors src/lib/marketplaceFingerprint.ts) ----
const ME_FEE_ADDRS = new Set(['bc1qcq2uv5nk6hec6kvag3wyevp6574qmsm9scjxc2']);

function addressFromSpk(spk) {
  if (!spk || typeof spk !== 'object') return null;
  if (typeof spk.address === 'string' && spk.address.length > 0) return spk.address;
  if (Array.isArray(spk.addresses) && typeof spk.addresses[0] === 'string') return spk.addresses[0];
  return null;
}

function findAcpInputs(tx) {
  const out = [];
  for (let i = 0; i < tx.vin.length; i++) {
    const w = tx.vin[i]?.txinwitness ?? [];
    if (!w || w.length === 0) continue;
    const first = w[0];
    if (typeof first === 'string' && first.length === 130 && first.endsWith('83')) {
      out.push(i);
    }
  }
  return out;
}

function findFeeVoutIdx(tx, addrs) {
  for (let i = 0; i < tx.vout.length; i++) {
    const a = addressFromSpk(tx.vout[i]?.scriptPubKey);
    if (a && addrs.has(a)) return i;
  }
  return -1;
}

function detectMagicEden(tx) {
  if (!tx?.vin?.length || !tx?.vout?.length) return null;
  const feeIdx = findFeeVoutIdx(tx, ME_FEE_ADDRS);
  if (feeIdx < 0) return null;
  const acp = findAcpInputs(tx);
  if (acp.length > 0) return { shape: 'acp', acpInputs: acp, feeVoutIdx: feeIdx };
  return { shape: 'cooperative', acpInputs: [], feeVoutIdx: feeIdx };
}

function btcToSats(v) {
  if (typeof v === 'number') return Math.round(v * 1e8);
  if (typeof v === 'string') return Math.round(parseFloat(v) * 1e8);
  return 0;
}

function extractPriceSats(tx, match, sellerAddress) {
  if (match.shape === 'cooperative') {
    const idx = match.feeVoutIdx - 1;
    if (idx <= 0) return null;
    const v = tx.vout[idx];
    if (!v || v.value == null) return null;
    return btcToSats(v.value);
  }
  let total = 0;
  let n = 0;
  for (const idx of match.acpInputs) {
    const vin = tx.vin[idx];
    const prevAddr = addressFromSpk(vin?.prevout?.scriptPubKey);
    if (prevAddr !== sellerAddress) continue;
    const vout = tx.vout[idx];
    if (!vout || vout.value == null) continue;
    total += btcToSats(vout.value);
    n++;
  }
  return n > 0 ? total : null;
}

// ---- main ----
async function main() {
  const db = new Database(DB_PATH, { readonly: ARGS.dryRun });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  try {
    const info = await rpc('getblockchaininfo', []);
    console.log(`[magic-eden-fp] bitcoind ok: blocks=${info.blocks} chain=${info.chain}`);
  } catch (e) {
    console.error('[magic-eden-fp] bitcoind RPC failed:', e.message);
    process.exit(1);
  }

  const conds = [`(event_type = 'transferred' OR (event_type = 'sold' AND marketplace IS NULL))`];
  const params = {};
  if (ARGS.inscriptionNumber != null) {
    conds.push('inscription_number = @insc');
    params.insc = ARGS.inscriptionNumber;
  }
  if (ARGS.since != null) {
    conds.push('block_timestamp >= @since');
    params.since = ARGS.since;
  }
  const limit = ARGS.maxEvents != null ? `LIMIT ${ARGS.maxEvents}` : '';
  const sql = `
    SELECT id, inscription_id, inscription_number, event_type, marketplace,
           sale_price_sats, old_owner, new_owner, txid, block_timestamp, raw_json
      FROM events
     WHERE ${conds.join(' AND ')}
     ORDER BY block_timestamp DESC
     ${limit}
  `;
  const events = db.prepare(sql).all(params);
  console.log(`[magic-eden-fp] candidates: ${events.length}`);

  const upgradeTransferred = db.prepare(`
    UPDATE events
       SET event_type      = 'sold',
           marketplace     = 'magic-eden',
           sale_price_sats = @sale_price_sats,
           raw_json        = json_set(COALESCE(raw_json, '{}'), '$.magic_eden_fp', json(@meta))
     WHERE id = @id AND event_type = 'transferred'
  `);
  const tagSold = db.prepare(`
    UPDATE events
       SET marketplace = 'magic-eden',
           raw_json    = json_set(COALESCE(raw_json, '{}'), '$.magic_eden_fp', json(@meta))
     WHERE id = @id AND event_type = 'sold' AND marketplace IS NULL
  `);
  const unbumpOnUpgrade = db.prepare(`
    UPDATE inscriptions SET
      transfer_count    = MAX(transfer_count - 1, 0),
      sale_count        = sale_count + 1,
      total_volume_sats = total_volume_sats + COALESCE(@sale_price_sats, 0),
      highest_sale_sats = MAX(highest_sale_sats, COALESCE(@sale_price_sats, 0))
    WHERE inscription_number = @inscription_number
  `);

  let scanned = 0;
  let matched = 0;
  let upgraded = 0;
  let tagged = 0;
  let collisions = 0;
  let priceMismatches = 0;
  let rpcFails = 0;
  const startedAt = Date.now();

  let cursor = 0;
  async function workerLoop() {
    while (cursor < events.length) {
      const ev = events[cursor++];
      scanned++;
      let tx;
      try {
        tx = await rpc('getrawtransaction', [ev.txid, 2]);
      } catch (e) {
        rpcFails++;
        if (ARGS.verbose) console.warn(`[magic-eden-fp] rpc fail tx=${ev.txid}: ${e.message}`);
        continue;
      }
      const match = detectMagicEden(tx);
      if (!match) continue;
      matched++;
      const priceSats = ev.old_owner ? extractPriceSats(tx, match, ev.old_owner) : null;
      const meta = JSON.stringify({
        source: 'onchain-magic-eden-fp',
        shape: match.shape,
        acp_inputs: match.acpInputs,
        fee_vout_idx: match.feeVoutIdx,
        extracted_price_sats: priceSats,
        matched_at: Math.floor(Date.now() / 1000),
      });
      if (ev.event_type === 'transferred') {
        if (priceSats == null && ARGS.verbose) {
          console.warn(
            `[magic-eden-fp] insc=${ev.inscription_number} matched but no price extractable (shape=${match.shape})`
          );
        }
        if (!ARGS.dryRun) {
          db.transaction(() => {
            const r = upgradeTransferred.run({
              id: ev.id,
              sale_price_sats: priceSats,
              meta,
            });
            if (r.changes > 0) {
              unbumpOnUpgrade.run({
                inscription_number: ev.inscription_number,
                sale_price_sats: priceSats ?? 0,
              });
            }
          })();
        }
        upgraded++;
        if (ARGS.verbose)
          console.log(
            `[magic-eden-fp] UPGRADE insc=${ev.inscription_number} tx=${ev.txid.slice(0, 12)} shape=${match.shape} price=${priceSats}`
          );
      } else {
        if (priceSats != null && ev.sale_price_sats != null) {
          const diff = Math.abs(priceSats - ev.sale_price_sats);
          if (diff > Math.max(1000, ev.sale_price_sats * 0.01)) {
            priceMismatches++;
            console.warn(
              `[magic-eden-fp] price mismatch insc=${ev.inscription_number} tx=${ev.txid.slice(0, 12)} ` +
                `existing=${ev.sale_price_sats} fp=${priceSats}`
            );
          }
        }
        if (!ARGS.dryRun) tagSold.run({ id: ev.id, meta });
        tagged++;
        if (ARGS.verbose)
          console.log(
            `[magic-eden-fp] TAG insc=${ev.inscription_number} tx=${ev.txid.slice(0, 12)}`
          );
      }
    }
  }

  const existingNonMe = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events e
        WHERE e.event_type='sold' AND e.marketplace IS NOT NULL AND e.marketplace != 'magic-eden'`
    )
    .get();
  collisions = existingNonMe?.n ?? 0;

  await Promise.all(Array.from({ length: CONCURRENCY }, () => workerLoop()));

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[magic-eden-fp] DONE in ${elapsed}s — scanned=${scanned} matched=${matched} ` +
      `upgraded=${upgraded} tagged=${tagged} priceMismatches=${priceMismatches} ` +
      `rpcFails=${rpcFails} (existingNonMeSold=${collisions} skipped from start)` +
      (ARGS.dryRun ? ' (DRY RUN — no writes)' : '')
  );
  db.close();
}

main().catch(e => {
  console.error('[magic-eden-fp] FATAL:', e);
  process.exit(1);
});
