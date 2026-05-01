#!/usr/bin/env node
/* eslint-disable */
// Exploratory: sample known-sold rows whose tx does NOT carry an ACP signature
// and dump their structural shape (input wallet clustering, output destinations,
// fees) so we can design a heuristic for cooperative SIGHASH_ALL sales.
//
// Read-only. Does not write to the DB.

const path = require('node:path');
const Database = require('better-sqlite3');

const { url: RPC_URL, authHeader: RPC_AUTH } = (() => {
  const raw = process.env.BITCOIN_RPC_URL;
  if (!raw) throw new Error('BITCOIN_RPC_URL required');
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
const SAMPLE = parseInt(process.env.SAMPLE ?? '20', 10);

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
    const j = await res.json();
    if (j.error) throw new Error(JSON.stringify(j.error));
    return j.result;
  } finally {
    clearTimeout(t);
  }
}

function btcToSats(v) {
  if (typeof v === 'number') return BigInt(Math.round(v * 1e8));
  if (typeof v === 'string') {
    const [whole, frac = ''] = v.split('.');
    const padded = (frac + '00000000').slice(0, 8);
    return BigInt(whole || '0') * 100_000_000n + BigInt(padded || '0');
  }
  return 0n;
}

function addr(spk) {
  if (!spk) return null;
  return spk.address ?? (Array.isArray(spk.addresses) ? spk.addresses[0] : null);
}

// Quick witness-shape classifier (no full sighash parse — just tail byte).
function inputSig(vin) {
  const w = vin.txinwitness || [];
  if (w.length === 0) {
    if (vin.scriptSig?.hex) return 'legacy-scriptsig';
    return 'no-witness';
  }
  const last = w[w.length - 1];
  if (typeof last === 'string' && last.length >= 66 && (last.length - 66) % 64 === 0) {
    const fb = parseInt(last.slice(0, 2), 16);
    if (fb === 0xc0 || fb === 0xc1) return `tap-script(${w.length}items)`;
  }
  const first = w[0];
  if (typeof first !== 'string') return '?';
  const len = first.length / 2;
  if (len === 64) return 'sch64';
  if (len === 65) return `sch65/${first.slice(128, 130)}`;
  if (first.startsWith('30')) return `ecdsa/${first.slice(-2)}`;
  return `?${len}`;
}

(async () => {
  const db = new Database(DB_PATH, { readonly: true });
  // Pull random ord.net-backfilled sold rows. We'll filter to "no-acp on carry
  // input" inside the loop so this works even if the source schema changes.
  const rows = db
    .prepare(
      `
    SELECT inscription_number, txid, old_owner, new_owner, sale_price_sats
      FROM events
     WHERE event_type='sold'
       AND json_extract(raw_json,'$.source') = 'ord-net-history-backfill'
     ORDER BY RANDOM() LIMIT ${SAMPLE * 4}
  `
    )
    .all();

  let printed = 0;
  for (const r of rows) {
    if (printed >= SAMPLE) break;
    let tx;
    try {
      tx = await rpc('getrawtransaction', [r.txid, 2]);
    } catch (e) {
      continue;
    }
    if (!tx?.vin || !tx?.vout) continue;

    // Identify the seller's input by old_owner prevAddr match.
    const sellerIdx = tx.vin.findIndex(v => addr(v.prevout?.scriptPubKey) === r.old_owner);

    // Cluster non-seller inputs by sender addr. Exclude ALL inputs whose
    // prevAddr matches old_owner (seller may spend multiple UTXOs from the
    // same wallet); otherwise their payout addr could leak into the cluster.
    const senderCluster = new Map();
    for (let i = 0; i < tx.vin.length; i++) {
      const a = addr(tx.vin[i].prevout?.scriptPubKey);
      if (!a) continue;
      if (a === r.old_owner) continue;
      senderCluster.set(a, (senderCluster.get(a) ?? 0) + 1);
    }

    const sellerSig = sellerIdx >= 0 ? inputSig(tx.vin[sellerIdx]) : 'NO-SELLER-IDX';
    // Skip rows that ARE ACP — we're hunting non-PSBT cooperative shape.
    if (sellerSig.startsWith('sch65/8') || sellerSig.startsWith('ecdsa/8')) {
      continue;
    }

    printed++;
    console.log(
      `\n=== #${r.inscription_number}  price=${r.sale_price_sats} sats  txid=${r.txid.slice(0, 16)}…`
    );
    console.log(
      `    old=${r.old_owner?.slice(0, 16)}…  new=${r.new_owner?.slice(0, 16)}…  sellerIdx=${sellerIdx}  sellerSig=${sellerSig}`
    );
    console.log(`    senderCluster (non-seller inputs):`);
    for (const [a, n] of senderCluster) console.log(`      ${a.slice(0, 30)}…  ×${n}`);

    const buyerAddrs = new Set([...senderCluster.keys()]);
    if (r.new_owner) buyerAddrs.add(r.new_owner);

    console.log(`    OUTPUTS (${tx.vout.length}):`);
    for (let i = 0; i < tx.vout.length; i++) {
      const o = tx.vout[i];
      const a = addr(o.scriptPubKey);
      const sats = Number(btcToSats(o.value));
      const tag =
        a === r.new_owner
          ? '*INSCRIPTION-DEST*'
          : buyerAddrs.has(a)
            ? '(buyer-cluster)'
            : a === r.old_owner
              ? '*OLD-OWNER*'
              : '<EXTERNAL>';
      console.log(`      vout[${i}] ${sats} sats → ${a?.slice(0, 24) ?? '?'}…  ${tag}`);
    }

    // Heuristic candidate: largest "external" output (not buyer cluster, not
    // inscription destination). If it dominates fees, that's the sale price.
    const externals = [];
    for (let i = 0; i < tx.vout.length; i++) {
      const o = tx.vout[i];
      const a = addr(o.scriptPubKey);
      if (!a || buyerAddrs.has(a) || a === r.new_owner) continue;
      externals.push({ idx: i, addr: a, sats: Number(btcToSats(o.value)) });
    }
    externals.sort((x, y) => y.sats - x.sats);
    const top = externals[0];
    const second = externals[1];

    // Multi-inscription guard: if other `sold` rows reference the same txid,
    // the tx is a batched fill and we can't disaggregate per-inscription
    // pricing from outputs alone.
    const otherSoldCount = db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE txid=? AND id != ?`)
      .get(r.txid, /* keep self */ -1).n;

    const MIN_PRICE = 100_000; // absolute floor (0.001 BTC)
    const MIN_RATIO = 10; // dominance over second-largest external
    let verdict, predicted;
    if (otherSoldCount > 1) {
      verdict = `multi-inscription-tx(n=${otherSoldCount})`;
    } else if (!top) {
      verdict = 'no-externals';
    } else if (top.sats < MIN_PRICE) {
      verdict = `below-floor(${top.sats})`;
    } else if (externals.length === 1) {
      verdict = 'sole-external (skip — too risky)';
    } else {
      const ratio = top.sats / Math.max(second.sats, 1);
      if (ratio >= MIN_RATIO) {
        verdict = `dominant(${ratio.toFixed(1)}x)`;
        predicted = top.sats;
      } else {
        verdict = `weak-ratio(${ratio.toFixed(1)}x)`;
      }
    }
    if (predicted != null) {
      const agree = Math.abs(predicted - r.sale_price_sats) <= 1;
      console.log(
        `    HEURISTIC: ${verdict}  predicted=${predicted}  db=${r.sale_price_sats}  ${agree ? 'AGREE' : 'DISAGREE'}`
      );
    } else {
      console.log(`    HEURISTIC: ${verdict}  (skip — db=${r.sale_price_sats})`);
    }
  }
  console.log(`\n[explore] examined ${printed} non-ACP sold rows`);
})().catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});
