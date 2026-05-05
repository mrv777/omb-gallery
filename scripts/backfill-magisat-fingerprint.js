#!/usr/bin/env node
/* eslint-disable */
// On-chain Magisat marketplace tagger.
//
// Walks every `transferred` and `marketplace IS NULL` `sold` event in the DB,
// fetches the underlying tx via bitcoind RPC, and applies the §2.6 fingerprint
// from ONCHAIN_TAGGING.md:
//   - any vout's address ∈ MAGISAT_FEE_ADDRS
//   - AND ≥1 vin signed with SIGHASH_SINGLE | ANYONECANPAY (0x83)
//
// On match:
//   - if event_type='transferred' → upgrade to 'sold', set marketplace='magisat',
//     extract sale_price_sats from the SIGHASH_SINGLE input(s) matching old_owner,
//     recompute aggregates.
//   - if event_type='sold' AND marketplace IS NULL → tag marketplace='magisat'
//     and (if our extracted price disagrees with existing sale_price_sats by >1%
//     log a warning). Don't overwrite price.
//   - if event_type='sold' AND marketplace='satflow' (or other) → log + skip.
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
const CONCURRENCY = parseInt(process.env.MAGISAT_FP_CONCURRENCY ?? '8', 10);

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
      console.error(`[magisat-fp] unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

if (!RPC_URL) {
  console.error('[magisat-fp] BITCOIN_RPC_URL is required');
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
const MAGISAT_FEE_ADDRS = new Set(['3Ke21osfhEbEryUeqdwAuAY8VKxm5B9uB2']);

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

function detectMagisat(tx) {
  if (!tx?.vin?.length || !tx?.vout?.length) return null;
  const hasFee = tx.vout.some(v => {
    const a = addressFromSpk(v?.scriptPubKey);
    return !!a && MAGISAT_FEE_ADDRS.has(a);
  });
  if (!hasFee) return null;
  const acp = findAcpInputs(tx);
  if (acp.length === 0) return null;
  return { acpInputs: acp };
}

function btcToSats(v) {
  if (typeof v === 'number') return Math.round(v * 1e8);
  if (typeof v === 'string') return Math.round(parseFloat(v) * 1e8);
  return 0;
}

function extractPriceSats(tx, match, sellerAddress) {
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
    console.log(`[magisat-fp] bitcoind ok: blocks=${info.blocks} chain=${info.chain}`);
  } catch (e) {
    console.error('[magisat-fp] bitcoind RPC failed:', e.message);
    process.exit(1);
  }

  // Candidate set: transferred OR sold-with-no-marketplace.
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
  console.log(`[magisat-fp] candidates: ${events.length}`);

  // Prepared writes
  const upgradeTransferred = db.prepare(`
    UPDATE events
       SET event_type      = 'sold',
           marketplace     = 'magisat',
           sale_price_sats = @sale_price_sats,
           raw_json        = json_set(COALESCE(raw_json, '{}'), '$.magisat_fp', json(@meta))
     WHERE id = @id AND event_type = 'transferred'
  `);
  const tagSold = db.prepare(`
    UPDATE events
       SET marketplace = 'magisat',
           raw_json    = json_set(COALESCE(raw_json, '{}'), '$.magisat_fp', json(@meta))
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

  // Bounded concurrency over the candidate set.
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
        if (ARGS.verbose) console.warn(`[magisat-fp] rpc fail tx=${ev.txid}: ${e.message}`);
        continue;
      }
      const match = detectMagisat(tx);
      if (!match) continue;
      matched++;
      const priceSats = ev.old_owner ? extractPriceSats(tx, match, ev.old_owner) : null;
      const meta = JSON.stringify({
        source: 'onchain-magisat-fp',
        acp_inputs: match.acpInputs,
        extracted_price_sats: priceSats,
        matched_at: Math.floor(Date.now() / 1000),
      });
      if (ev.event_type === 'transferred') {
        if (priceSats == null) {
          if (ARGS.verbose)
            console.warn(
              `[magisat-fp] insc=${ev.inscription_number} matched but no price extractable (old_owner mismatch?)`
            );
          // Still upgrade — leave price null. Better to record the marketplace
          // than miss the sale entirely.
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
            `[magisat-fp] UPGRADE insc=${ev.inscription_number} tx=${ev.txid.slice(0, 12)} price=${priceSats}`
          );
      } else {
        // sold + marketplace null → tag
        if (priceSats != null && ev.sale_price_sats != null) {
          const diff = Math.abs(priceSats - ev.sale_price_sats);
          if (diff > Math.max(1000, ev.sale_price_sats * 0.01)) {
            priceMismatches++;
            console.warn(
              `[magisat-fp] price mismatch insc=${ev.inscription_number} tx=${ev.txid.slice(0, 12)} ` +
                `existing=${ev.sale_price_sats} fp=${priceSats}`
            );
          }
        }
        if (!ARGS.dryRun) tagSold.run({ id: ev.id, meta });
        tagged++;
        if (ARGS.verbose)
          console.log(`[magisat-fp] TAG insc=${ev.inscription_number} tx=${ev.txid.slice(0, 12)}`);
      }
    }
  }

  // Track collisions (sold + marketplace already set to non-magisat) up front
  // since we filter them out of the candidate set; query for visibility.
  const existingNonMagisat = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events e
        WHERE e.event_type='sold' AND e.marketplace IS NOT NULL AND e.marketplace != 'magisat'`
    )
    .get();
  collisions = existingNonMagisat?.n ?? 0;

  await Promise.all(Array.from({ length: CONCURRENCY }, () => workerLoop()));

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[magisat-fp] DONE in ${elapsed}s — scanned=${scanned} matched=${matched} ` +
      `upgraded=${upgraded} tagged=${tagged} priceMismatches=${priceMismatches} ` +
      `rpcFails=${rpcFails} (existingNonMagisatSold=${collisions} skipped from start)` +
      (ARGS.dryRun ? ' (DRY RUN — no writes)' : '')
  );
  db.close();
}

main().catch(e => {
  console.error('[magisat-fp] FATAL:', e);
  process.exit(1);
});
