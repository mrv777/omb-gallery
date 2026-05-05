#!/usr/bin/env node
/* eslint-disable */
// TN check: scan ALL events (including those already tagged with a non-ME
// marketplace) for `3P4WqXDbSLRhzo2H6MT6YFbvBKBDPLbVtQ` co-occurrence. If
// any tx with this address is currently tagged 'satflow' / 'magisat' /
// other, that's evidence the address is shared, not ME-exclusive.
const path = require('node:path');
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
    return {
      url: (u.username='', u.password='', u.toString()),
      authHeader: user || pass ? 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') : null,
    };
  } catch {
    return { url: raw, authHeader: null };
  }
})();
const DB_PATH = process.env.OMB_DB_PATH ?? path.resolve(__dirname, '..', 'tmp', 'dev.db');
const SECONDARY_FEE = '3P4WqXDbSLRhzo2H6MT6YFbvBKBDPLbVtQ';
const CONCURRENCY = 8;

let rpcId = 0;
async function rpc(method, params = []) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30_000);
  try {
    const headers = { 'content-type': 'application/json' };
    if (RPC_AUTH) headers['authorization'] = RPC_AUTH;
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '1.0', id: ++rpcId, method, params }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(JSON.stringify(j.error));
    return j.result;
  } finally {
    clearTimeout(t);
  }
}

function addr(spk) {
  if (!spk) return null;
  if (typeof spk.address === 'string') return spk.address;
  return Array.isArray(spk.addresses) ? spk.addresses[0] : null;
}

async function main() {
  const db = new Database(DB_PATH, { readonly: true });
  // ALL marketplace-tagged events: are any of them carrying 3P4Wq?
  const tagged = db
    .prepare(
      `SELECT id, inscription_number, txid, marketplace, sale_price_sats, block_timestamp,
              json_extract(raw_json, '$.source') AS src
         FROM events
        WHERE event_type = 'sold' AND marketplace IS NOT NULL
        ORDER BY block_timestamp ASC`
    )
    .all();
  console.log(`[probe-tn] tagged events: ${tagged.length}`);

  // Group by marketplace for pre-flight info.
  const byMarket = new Map();
  for (const ev of tagged) {
    byMarket.set(ev.marketplace, (byMarket.get(ev.marketplace) || 0) + 1);
  }
  for (const [m, n] of byMarket) console.log(`  ${m}: ${n}`);

  // Dedupe by txid.
  const txids = [...new Set(tagged.map(e => e.txid))];
  console.log(`[probe-tn] unique tagged txids: ${txids.length}`);

  let scanned = 0;
  let secondaryHits = 0;
  const hits = [];
  let cursor = 0;
  async function worker() {
    while (cursor < txids.length) {
      const txid = txids[cursor++];
      scanned++;
      let tx;
      try {
        tx = await rpc('getrawtransaction', [txid, 2]);
      } catch {
        continue;
      }
      const has = (tx.vout || []).some(v => addr(v?.scriptPubKey) === SECONDARY_FEE);
      if (has) {
        secondaryHits++;
        const evs = tagged.filter(e => e.txid === txid);
        for (const e of evs) hits.push(e);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log(`\n[probe-tn] DONE — scanned ${scanned} tagged txids, ${secondaryHits} carry 3P4Wq…`);
  if (hits.length === 0) {
    console.log('  No TN — every tagged-marketplace event is free of 3P4Wq.');
  } else {
    console.log(`\n  TN candidates (events tagged with a non-ME marketplace AND carrying 3P4Wq):`);
    for (const h of hits) {
      const d = new Date(h.block_timestamp * 1000).toISOString().slice(0, 10);
      console.log(
        `    ${d}  insc=${h.inscription_number}  marketplace=${h.marketplace}  src=${h.src}  txid=${h.txid.slice(0, 16)}`
      );
    }
  }
  db.close();
}

main().catch(e => {
  console.error('[probe-tn] FATAL:', e);
  process.exit(1);
});
