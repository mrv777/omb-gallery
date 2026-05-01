#!/usr/bin/env node
/* eslint-disable */
// One-shot revert for `sold` rows that the Layer-1 ACP heuristic flagged
// before the no-buyer-input guard was added (see backfill-onchain-sales.js
// commit message for context). Mirrors the prior coop-layer revert pattern:
// flips event_type back to 'transferred', clears price/marketplace, retags
// raw_json with the revert audit trail, and rebalances inscriptions
// aggregates (transfer_count, sale_count, total_volume_sats, highest_sale_sats).
//
// Re-fetches each candidate tx via bitcoind RPC and applies the same buyer-
// input check the patched detector uses; only rows that fail the guard are
// reverted. Idempotent — once a row is flipped, the WHERE filter excludes it.
//
// Required env:
//   BITCOIN_RPC_URL   e.g. http://user:<password>@127.0.0.1:8332
// Optional env:
//   OMB_DB_PATH       default ./tmp/dev.db
//
// CLI flags:
//   --apply           Without this, runs in dry-run mode (no DB writes).
//   --verbose         Per-row decision logs.

const path = require('node:path');
const Database = require('better-sqlite3');

const { url: RPC_URL, authHeader: RPC_AUTH } = (() => {
  const raw = process.env.BITCOIN_RPC_URL;
  if (!raw) return { url: null, authHeader: null };
  const u = new URL(raw);
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  u.username = '';
  u.password = '';
  const authHeader =
    user || pass ? 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') : null;
  return { url: u.toString(), authHeader };
})();
const DB_PATH = process.env.OMB_DB_PATH ?? path.resolve(__dirname, '..', 'tmp', 'dev.db');

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');

if (!RPC_URL) {
  console.error('[revert-acp] BITCOIN_RPC_URL is required');
  process.exit(1);
}

let rpcId = 0;
async function rpc(method, params = []) {
  const headers = { 'content-type': 'application/json' };
  if (RPC_AUTH) headers['authorization'] = RPC_AUTH;
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '1.0', id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${method} HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`rpc ${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

function addrFromSpk(spk) {
  if (!spk || typeof spk !== 'object') return null;
  if (typeof spk.address === 'string' && spk.address.length > 0) return spk.address;
  if (Array.isArray(spk.addresses) && typeof spk.addresses[0] === 'string') return spk.addresses[0];
  return null;
}

async function main() {
  const db = new Database(DB_PATH, { readonly: !APPLY });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  const candidates = db
    .prepare(
      `SELECT id, inscription_id, inscription_number, txid, sale_price_sats,
              old_owner, raw_json
         FROM events
        WHERE event_type = 'sold'
          AND json_extract(raw_json, '$.source') = 'onchain-heuristic'
        ORDER BY id`
    )
    .all();

  console.log(
    `[revert-acp] db=${DB_PATH} apply=${APPLY} candidates=${candidates.length}`
  );

  const toRevert = [];
  for (const ev of candidates) {
    if (!ev.old_owner) {
      if (VERBOSE) console.log(`#${ev.inscription_number} id=${ev.id}: no old_owner — skip`);
      continue;
    }
    let tx;
    try {
      tx = await rpc('getrawtransaction', [ev.txid, 2]);
    } catch (e) {
      console.warn(`#${ev.inscription_number} id=${ev.id}: rpc fail (${e.message}) — skip`);
      continue;
    }
    let hasBuyerInput = false;
    for (const v of tx.vin) {
      const a = addrFromSpk(v.prevout?.scriptPubKey);
      if (a && a !== ev.old_owner) {
        hasBuyerInput = true;
        break;
      }
    }
    const status = hasBuyerInput ? 'KEEP' : 'REVERT';
    if (VERBOSE || !hasBuyerInput) {
      console.log(
        `[${status}] #${ev.inscription_number} id=${ev.id} txid=${ev.txid.slice(0, 12)}… ` +
          `price=${(ev.sale_price_sats / 1e8).toFixed(4)} BTC seller=${ev.old_owner.slice(0, 10)}…`
      );
    }
    if (!hasBuyerInput) toRevert.push(ev);
  }

  console.log(
    `\n[revert-acp] verdict: ${toRevert.length}/${candidates.length} rows fail acp:no-buyer-input guard`
  );

  if (toRevert.length === 0 || !APPLY) {
    if (toRevert.length > 0 && !APPLY) {
      console.log('[revert-acp] DRY RUN — pass --apply to commit reverts');
    }
    db.close();
    return;
  }

  // ---- apply revert ----
  // For each row:
  //   1. Build new raw_json: source='reverted-from-onchain-heuristic',
  //      previous_price_sats, previous_carry_idx, previous_sighash,
  //      previous_seller_payout_addr, reverted_at.
  //   2. UPDATE events: event_type='transferred', sale_price_sats=NULL,
  //      marketplace=NULL, raw_json=<new>.
  //   3. Adjust inscriptions: transfer_count++, sale_count--, total_volume_sats -=
  //      price. highest_sale_sats: recompute as MAX over remaining 'sold' events
  //      for the inscription (need a SELECT, can't decrement a max).

  const updateEvent = db.prepare(`
    UPDATE events
       SET event_type      = 'transferred',
           sale_price_sats = NULL,
           marketplace     = NULL,
           raw_json        = @raw_json
     WHERE id              = @id
       AND event_type      = 'sold'
  `);
  const adjustInscr = db.prepare(`
    UPDATE inscriptions
       SET transfer_count    = transfer_count + 1,
           sale_count        = MAX(sale_count - 1, 0),
           total_volume_sats = MAX(total_volume_sats - @price, 0),
           highest_sale_sats = COALESCE(
             (SELECT MAX(sale_price_sats) FROM events
               WHERE inscription_number = @num
                 AND event_type = 'sold'
                 AND id != @event_id),
             0
           )
     WHERE inscription_number = @num
  `);

  const now = Math.floor(Date.now() / 1000);
  const txn = db.transaction(rows => {
    let n = 0;
    for (const ev of rows) {
      const prev = JSON.parse(ev.raw_json || '{}');
      const newRaw = JSON.stringify({
        source: 'reverted-from-onchain-heuristic',
        previous_price_sats: ev.sale_price_sats,
        previous_carry_idx: prev.carry_idx,
        previous_sighash: prev.sighash,
        previous_seller_payout_addr: prev.seller_payout_addr,
        reverted_at: now,
        revert_reason: 'acp:no-buyer-input',
      });
      const r = updateEvent.run({ id: ev.id, raw_json: newRaw });
      if (r.changes > 0) {
        adjustInscr.run({
          num: ev.inscription_number,
          event_id: ev.id,
          price: ev.sale_price_sats,
        });
        n++;
      }
    }
    return n;
  });

  const reverted = txn.immediate(toRevert);
  console.log(`[revert-acp] APPLIED: reverted ${reverted} rows`);
  db.close();
}

main().catch(e => {
  console.error('[revert-acp] FATAL:', e);
  process.exit(1);
});
