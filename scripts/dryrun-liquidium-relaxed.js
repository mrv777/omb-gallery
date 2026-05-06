#!/usr/bin/env node
/*
 * Dry-run report: which events would `detectLiquidiumOriginationCandidate`
 * tag as loan-originated if we relaxed the matchKind gate to accept any of
 * {P2SH, P2WPKH, P2TR} at vout[2] with no vin count cap, while keeping all
 * the strong structural gates intact?
 *
 * Read-only. Writes nothing to the DB. Outputs JSON to stdout.
 */

const Database = require('better-sqlite3');
const DB_PATH = process.env.OMB_DB_PATH || '/data/app.db';
const FEE_ADDR = 'bc1papmpmu0xzfvw4x9qe4jstgxfnfy5q8zhh6xredjxd86ca74uph3s59se9u';
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY || '16', 10);

const { rpcUrl, rpcAuth } = (() => {
  const raw = process.env.BITCOIN_RPC_URL;
  if (!raw) return { rpcUrl: null, rpcAuth: null };
  const u = new URL(raw);
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  u.username = '';
  u.password = '';
  return {
    rpcUrl: u.toString(),
    rpcAuth: user || pass ? 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') : null,
  };
})();
if (!rpcUrl) {
  console.error('BITCOIN_RPC_URL is required');
  process.exit(1);
}

let rpcId = 0;
async function rpc(method, params) {
  const headers = { 'content-type': 'application/json' };
  if (rpcAuth) headers.authorization = rpcAuth;
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '1.0', id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

const addr = o =>
  o?.address ??
  o?.scriptpubkey_address ??
  o?.scriptPubKey?.address ??
  o?.scriptPubKey?.addresses?.[0] ??
  null;
const typ = o => o?.type ?? o?.scriptpubkey_type ?? o?.scriptPubKey?.type ?? null;
const sats = o => {
  const v = o?.value ?? 0;
  return o && 'scriptpubkey_address' in o && Number.isInteger(v)
    ? Math.round(v)
    : Math.round(v * 1e8);
};
const isP2tr = t => t === 'v1_p2tr' || t === 'witness_v1_taproot';
const isP2wsh = t => t === 'v0_p2wsh' || t === 'witness_v0_scripthash';
const isP2sh = t => t === 'p2sh' || t === 'scripthash';
const isP2wpkh = t => t === 'v0_p2wpkh' || t === 'witness_v0_keyhash';
const witness = vin => vin?.txinwitness ?? vin?.witness ?? [];
const isOneOfTwo = vin => {
  const s = witness(vin).at(-1);
  return typeof s === 'string' && /^5121[0-9a-f]{66}21[0-9a-f]{66}52ae$/i.test(s);
};

function detectRelaxed(tx) {
  if (!Array.isArray(tx?.vin) || !Array.isArray(tx?.vout)) return null;
  if (tx.vin.length < 2 || tx.vout.length !== 4) return null;
  const collateralIn = tx.vin[0]?.prevout;
  const escrowOut = tx.vout[0];
  const feeOut = tx.vout[1];
  const payoutOut = tx.vout[2];
  const changeOut = tx.vout[3];
  if (!addr(collateralIn) || !addr(escrowOut) || !addr(payoutOut) || !addr(changeOut)) return null;
  if (!isP2tr(typ(collateralIn)) || !isP2tr(typ(escrowOut))) return null;
  if (sats(collateralIn) !== sats(escrowOut)) return null;
  if (addr(feeOut) !== FEE_ADDR) return null;
  if (!isP2wsh(typ(changeOut))) return null;

  const payoutType = typ(payoutOut);
  let payoutClass;
  if (isP2sh(payoutType)) payoutClass = 'p2sh';
  else if (isP2wpkh(payoutType)) payoutClass = 'p2wpkh';
  else if (isP2tr(payoutType)) payoutClass = 'p2tr';
  else return null;

  const vault = addr(changeOut);
  for (const vin of tx.vin.slice(1)) {
    if (addr(vin.prevout) !== vault) return null;
    if (!isP2wsh(typ(vin.prevout))) return null;
    if (!isOneOfTwo(vin)) return null;
  }

  // Strict-prod equivalent? (so we can split: already-tagged-eligible vs new)
  const isStrict =
    (tx.vin.length >= 3 && isP2sh(payoutType)) || (tx.vin.length <= 4 && isP2tr(payoutType));

  return {
    payoutClass,
    payoutType,
    vinCount: tx.vin.length,
    isStrict,
    vault,
    borrower: addr(payoutOut),
    loanAmountSats: sats(payoutOut),
    activationFeeSats: sats(feeOut),
  };
}

async function main() {
  const db = new Database(DB_PATH, { readonly: true });
  // Distinct txids that are NOT already tagged loan-originated.
  const rows = db
    .prepare(
      `SELECT e.txid, MIN(e.id) AS event_id
         FROM events e
        WHERE e.event_type IN ('transferred','sold')
          AND NOT EXISTS (
            SELECT 1 FROM events x
             WHERE x.txid = e.txid AND x.event_type = 'loan-originated'
          )
        GROUP BY e.txid`
    )
    .all();

  const inscByTxid = new Map();
  const inscRows = db
    .prepare(
      `SELECT e.txid, i.inscription_number, e.event_type
         FROM events e
         JOIN inscriptions i ON i.inscription_id = e.inscription_id
        WHERE e.event_type IN ('transferred','sold')`
    )
    .all();
  for (const r of inscRows) {
    if (!inscByTxid.has(r.txid)) inscByTxid.set(r.txid, []);
    inscByTxid.get(r.txid).push({ n: r.inscription_number, type: r.event_type });
  }

  console.error(`scanning ${rows.length} distinct txids with concurrency ${CONCURRENCY}`);

  const matches = [];
  let scanned = 0;
  let errors = 0;

  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= rows.length) return;
      const { txid } = rows[idx];
      try {
        const tx = await rpc('getrawtransaction', [txid, 2]);
        const m = detectRelaxed(tx);
        if (m) {
          const inscs = inscByTxid.get(txid) || [];
          matches.push({
            txid,
            inscriptions: inscs,
            payoutClass: m.payoutClass,
            payoutType: m.payoutType,
            vinCount: m.vinCount,
            isStrict: m.isStrict,
            vault: m.vault,
            borrower: m.borrower,
            loanAmountSats: m.loanAmountSats,
            activationFeeSats: m.activationFeeSats,
          });
        }
      } catch (e) {
        errors++;
        if (errors < 10) console.error(`err ${txid}: ${e.message}`);
      }
      scanned++;
      if (scanned % 2000 === 0)
        console.error(`  ${scanned}/${rows.length} scanned, ${matches.length} matches`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Cross-reference against existing loan-originated rows so we can split
  // "already-tagged" from "would-be-newly-tagged".
  const existing = db
    .prepare(`SELECT txid FROM events WHERE event_type='loan-originated'`)
    .all()
    .map(r => r.txid);
  const existingSet = new Set(existing);

  const newMatches = matches.filter(m => !existingSet.has(m.txid));
  const splitByClass = list => {
    const out = { p2sh: 0, p2wpkh: 0, p2tr: 0 };
    for (const m of list) out[m.payoutClass]++;
    return out;
  };

  const summary = {
    total_distinct_txids_scanned: scanned,
    rpc_errors: errors,
    relaxed_matches_total: matches.length,
    relaxed_matches_already_tagged: matches.length - newMatches.length,
    relaxed_matches_new: newMatches.length,
    new_by_payout_class: splitByClass(newMatches),
    strict_split_within_new: {
      strict_eligible_but_untagged: newMatches.filter(m => m.isStrict).length,
      relaxed_only: newMatches.filter(m => !m.isStrict).length,
    },
  };

  console.log(JSON.stringify({ summary, new_matches: newMatches }, null, 2));
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
