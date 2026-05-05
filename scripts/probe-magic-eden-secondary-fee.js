#!/usr/bin/env node
/* eslint-disable */
// Probe for the Magic Eden secondary candidate fee address `3P4WqXDbSLRhzo2H6MT6YFbvBKBDPLbVtQ`.
//
// Walks every `transferred` + `marketplace IS NULL sold` event, fetches the
// tx via bitcoind RPC, and counts how many carry the secondary fee output.
// Also records co-occurrence with the primary fee address `bc1qcq2uv5n…`,
// time distribution, and a sample of matched txids so we can decide whether
// to promote the secondary address into the live MAGIC_EDEN_FEE_ADDRS set.
//
// Read-only. No DB writes.

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
    const authHeader =
      user || pass ? 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') : null;
    return { url: u.toString(), authHeader };
  } catch {
    return { url: raw, authHeader: null };
  }
})();
const DB_PATH = process.env.OMB_DB_PATH ?? path.resolve(__dirname, '..', 'tmp', 'dev.db');
const REQUEST_TIMEOUT_MS = 30_000;
const CONCURRENCY = parseInt(process.env.PROBE_CONCURRENCY ?? '8', 10);

const PRIMARY_FEE = 'bc1qcq2uv5nk6hec6kvag3wyevp6574qmsm9scjxc2';
const SECONDARY_FEE = '3P4WqXDbSLRhzo2H6MT6YFbvBKBDPLbVtQ';

if (!RPC_URL) {
  console.error('[probe-me-secondary] BITCOIN_RPC_URL is required');
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

function addressFromSpk(spk) {
  if (!spk || typeof spk !== 'object') return null;
  if (typeof spk.address === 'string' && spk.address.length > 0) return spk.address;
  if (Array.isArray(spk.addresses) && typeof spk.addresses[0] === 'string') return spk.addresses[0];
  return null;
}

async function main() {
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  try {
    await rpc('getblockchaininfo', []);
  } catch (e) {
    console.error('[probe-me-secondary] bitcoind RPC failed:', e.message);
    process.exit(1);
  }

  const events = db
    .prepare(
      `SELECT id, inscription_number, txid, block_height, block_timestamp, event_type, marketplace
         FROM events
        WHERE event_type = 'transferred' OR (event_type = 'sold' AND marketplace IS NULL)
        ORDER BY block_timestamp DESC`
    )
    .all();
  console.log(`[probe-me-secondary] candidates: ${events.length}`);

  // Dedupe by txid — multi-inscription txs only need one fetch.
  const byTxid = new Map();
  for (const ev of events) {
    if (!byTxid.has(ev.txid)) byTxid.set(ev.txid, []);
    byTxid.get(ev.txid).push(ev);
  }
  const uniqueTxids = Array.from(byTxid.keys());
  console.log(`[probe-me-secondary] unique txids: ${uniqueTxids.length}`);

  let scanned = 0;
  let secondaryHits = 0;
  let bothHits = 0;
  let secondaryOnlyHits = 0;
  let rpcFails = 0;
  const samples = [];
  const monthHistogram = new Map(); // YYYY-MM → count of secondary-only hits
  const startedAt = Date.now();

  let cursor = 0;
  async function workerLoop() {
    while (cursor < uniqueTxids.length) {
      const txid = uniqueTxids[cursor++];
      scanned++;
      if (scanned % 2000 === 0) {
        console.log(
          `[probe-me-secondary] scanned ${scanned}/${uniqueTxids.length} secondary=${secondaryHits} both=${bothHits} secondaryOnly=${secondaryOnlyHits}`
        );
      }
      let tx;
      try {
        tx = await rpc('getrawtransaction', [txid, 2]);
      } catch (e) {
        rpcFails++;
        continue;
      }
      const addrs = new Set();
      for (const v of tx.vout || []) {
        const a = addressFromSpk(v?.scriptPubKey);
        if (a) addrs.add(a);
      }
      const hasSecondary = addrs.has(SECONDARY_FEE);
      const hasPrimary = addrs.has(PRIMARY_FEE);
      if (hasSecondary) {
        secondaryHits++;
        if (hasPrimary) bothHits++;
        else {
          secondaryOnlyHits++;
          // Sample only secondary-only — these are the ones the live rule misses.
          const ev = byTxid.get(txid)[0];
          if (samples.length < 30) {
            samples.push({
              txid,
              inscription_number: ev.inscription_number,
              block_timestamp: ev.block_timestamp,
              n_inscriptions: byTxid.get(txid).length,
              n_in: tx.vin.length,
              n_out: tx.vout.length,
            });
          }
          if (ev.block_timestamp) {
            const d = new Date(ev.block_timestamp * 1000);
            const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
            monthHistogram.set(key, (monthHistogram.get(key) || 0) + 1);
          }
        }
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => workerLoop()));

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n[probe-me-secondary] DONE in ${elapsed}s`);
  console.log(`  scanned: ${scanned}`);
  console.log(`  secondary fee present:        ${secondaryHits}`);
  console.log(`    of which co-occur primary:  ${bothHits} (already tagged)`);
  console.log(`    of which secondary-ONLY:    ${secondaryOnlyHits} (the gap)`);
  console.log(`  rpc failures: ${rpcFails}`);
  console.log(`\nSecondary-only month histogram:`);
  const months = Array.from(monthHistogram.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [m, c] of months) console.log(`  ${m}: ${c}`);
  console.log(`\nSample of secondary-only txs (first ${samples.length}):`);
  for (const s of samples) {
    const d = new Date(s.block_timestamp * 1000).toISOString().slice(0, 10);
    console.log(
      `  ${d}  insc=${s.inscription_number}  txid=${s.txid.slice(0, 16)}  ` +
        `n_in=${s.n_in} n_out=${s.n_out} n_inscriptions=${s.n_inscriptions}`
    );
  }

  db.close();
}

main().catch(e => {
  console.error('[probe-me-secondary] FATAL:', e);
  process.exit(1);
});
