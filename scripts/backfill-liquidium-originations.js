#!/usr/bin/env node
/*
 * Backfill modern Liquidium loan originations.
 *
 * Production policy (ONCHAIN_TAGGING.md §2.4):
 *   - all match kinds anchor on the same strong gates (Liquidium activation-
 *     fee address, P2WSH lender vault as both vin source and vout[3] change,
 *     1-of-2 multisig witness on every non-collateral input, P2TR collateral
 *     value preservation);
 *   - confidence splits by lender-vault provenance: vaults already seen in
 *     confirmed loan-originated events get 'high', new vaults get 'medium';
 *   - strict-p2sh always 'high' (oldest promoted shape, externally verified);
 *   - variant-p2tr always 'medium' (narrower fixture corpus);
 *   - relaxed-p2sh / relaxed-p2wpkh / relaxed-p2tr-bigvin use the known-vault
 *     split. The known-fixture allowlist in scripts/known-transactions.json
 *     remains as a fallback for txids that fail every gate but were
 *     externally confirmed.
 *
 * Requires BITCOIN_RPC_URL and OMB_DB_PATH (default /data/app.db).
 */

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.OMB_DB_PATH || '/data/app.db';
const KNOWN_PATH = path.resolve(__dirname, 'known-transactions.json');
const LIMIT = Number.parseInt(process.env.LIMIT || '0', 10);
const DRY_RUN = process.argv.includes('--dry-run');
const DETECTOR_VERSION = 3;
const FEE_ADDR = 'bc1papmpmu0xzfvw4x9qe4jstgxfnfy5q8zhh6xredjxd86ca74uph3s59se9u';

const { rpcUrl, rpcAuth } = (() => {
  const raw = process.env.BITCOIN_RPC_URL;
  if (!raw) return { rpcUrl: null, rpcAuth: null };
  try {
    const u = new URL(raw);
    const user = decodeURIComponent(u.username);
    const pass = decodeURIComponent(u.password);
    u.username = '';
    u.password = '';
    return {
      rpcUrl: u.toString(),
      rpcAuth: user || pass ? 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') : null,
    };
  } catch {
    return { rpcUrl: raw, rpcAuth: null };
  }
})();

if (!rpcUrl) {
  console.error('BITCOIN_RPC_URL is required');
  process.exit(1);
}

let rpcId = 0;
async function rpc(method, params = []) {
  const headers = { 'content-type': 'application/json' };
  if (rpcAuth) headers.authorization = rpcAuth;
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '1.0', id: ++rpcId, method, params }),
  });
  if (!res.ok)
    throw new Error(`rpc ${method} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  if (j.error) throw new Error(`rpc ${method} error: ${JSON.stringify(j.error)}`);
  return j.result;
}

function addr(o) {
  return (
    o?.address ??
    o?.scriptpubkey_address ??
    o?.scriptPubKey?.address ??
    o?.scriptPubKey?.addresses?.[0] ??
    null
  );
}
function typ(o) {
  return o?.type ?? o?.scriptpubkey_type ?? o?.scriptPubKey?.type ?? null;
}
function sats(o) {
  const v = o?.value ?? 0;
  return o && 'scriptpubkey_address' in o && Number.isInteger(v)
    ? Math.round(v)
    : Math.round(v * 1e8);
}
function isP2tr(t) {
  return t === 'v1_p2tr' || t === 'witness_v1_taproot';
}
function isP2wsh(t) {
  return t === 'v0_p2wsh' || t === 'witness_v0_scripthash';
}
function isP2sh(t) {
  return t === 'p2sh' || t === 'scripthash';
}
function isP2wpkh(t) {
  return t === 'v0_p2wpkh' || t === 'witness_v0_keyhash';
}
function witness(vin) {
  return vin?.txinwitness ?? vin?.witness ?? [];
}
function isOneOfTwo(vin) {
  const script = witness(vin).at(-1);
  return typeof script === 'string' && /^5121[0-9a-f]{66}21[0-9a-f]{66}52ae$/i.test(script);
}

function detectProduction(tx) {
  if (!Array.isArray(tx?.vin) || !Array.isArray(tx?.vout)) return null;
  if (tx.vin.length < 2 || tx.vout.length !== 4) return null;
  const collateralIn = tx.vin[0]?.prevout;
  const escrowOut = tx.vout[0];
  const feeOut = tx.vout[1];
  const payoutOut = tx.vout[2];
  const changeOut = tx.vout[3];
  const feeAddress = addr(feeOut);
  const borrower = addr(payoutOut);
  const vault = addr(changeOut);
  if (!addr(collateralIn) || !addr(escrowOut) || !borrower || !vault) return null;
  if (!isP2tr(typ(collateralIn)) || !isP2tr(typ(escrowOut))) return null;
  if (sats(collateralIn) !== sats(escrowOut)) return null;
  if (feeAddress !== FEE_ADDR) return null;
  if (!isP2wsh(typ(changeOut))) return null;

  const payoutType = typ(payoutOut);
  const vinCount = tx.vin.length;
  let matchKind = null;
  if (vinCount >= 3 && isP2sh(payoutType)) {
    matchKind = 'strict-p2sh';
  } else if (vinCount <= 4 && isP2tr(payoutType)) {
    matchKind = 'variant-p2tr';
  } else if (vinCount === 2 && isP2sh(payoutType)) {
    matchKind = 'relaxed-p2sh';
  } else if (isP2wpkh(payoutType)) {
    matchKind = 'relaxed-p2wpkh';
  } else if (vinCount > 4 && isP2tr(payoutType)) {
    matchKind = 'relaxed-p2tr-bigvin';
  } else {
    return null;
  }

  for (const vin of tx.vin.slice(1)) {
    if (addr(vin.prevout) !== vault) return null;
    if (!isP2wsh(typ(vin.prevout))) return null;
    if (!isOneOfTwo(vin)) return null;
  }

  return {
    source: 'liquidium-modern-origination-fingerprint',
    matchKind,
    escrowAddr: addr(escrowOut),
    lender: vault,
    borrower,
    loanAmountSats: sats(payoutOut),
    activationFeeSats: sats(feeOut),
  };
}

// Confidence rule shared with src/lib/loanDetect.ts: strict-p2sh always
// 'high'; variant-p2tr always 'medium'; relaxed-* takes 'high' when the
// lender vault has already appeared in a confirmed origination event,
// 'medium' otherwise. The known-fixture fallback below sets
// match.confidence explicitly (always 'high', externally verified) — that
// wins over the structural rule.
function confidenceFor(match, knownVaults) {
  if (match.confidence) return match.confidence;
  if (match.matchKind === 'strict-p2sh') return 'high';
  if (match.matchKind === 'variant-p2tr') return 'medium';
  return knownVaults.has(match.lender) ? 'high' : 'medium';
}

function readKnownLiquidiumTxids() {
  const known = JSON.parse(fs.readFileSync(KNOWN_PATH, 'utf8'));
  const txids = new Set();
  for (const t of known.transactions || []) {
    if (
      t.expected_type === 'loan-originated' &&
      Array.isArray(t.tags) &&
      t.tags.includes('liquidium') &&
      t.tags.includes('origination')
    ) {
      txids.add(t.txid);
    }
  }
  return txids;
}

const knownLiquidiumTxids = readKnownLiquidiumTxids();
const db = new Database(DB_PATH);
db.pragma('busy_timeout = 5000');

// Snapshot the lender-vault set at script start. Used to elevate relaxed-*
// match_kinds from 'medium' to 'high' when the vault already shows up in a
// confirmed origination event (strong corroboration that it's a real
// Liquidium vault).
const knownVaults = new Set(
  db
    .prepare(
      `SELECT DISTINCT json_extract(raw_json,'$.lender_addr') AS vault
         FROM events
        WHERE event_type = 'loan-originated'
          AND json_extract(raw_json,'$.lender_addr') IS NOT NULL`
    )
    .all()
    .map(r => r.vault)
);

const rows = db
  .prepare(
    `
    SELECT e.id, e.inscription_id, e.inscription_number, e.txid, e.event_type,
           e.sale_price_sats, e.block_timestamp
      FROM events e
      JOIN inscriptions i ON i.inscription_number = e.inscription_number
     WHERE i.collection_slug = 'omb'
       AND e.txid NOT LIKE 'listed:%'
       AND e.event_type IN ('transferred','sold')
     ORDER BY e.block_timestamp DESC, e.id DESC
     ${LIMIT > 0 ? 'LIMIT @limit' : ''}
  `
  )
  .all({ limit: LIMIT });

const stmts = {
  upgrade: db.prepare(`
    UPDATE events
       SET event_type = 'loan-originated',
           marketplace = NULL,
           sale_price_sats = NULL,
           raw_json = @raw_json
     WHERE id = @id
       AND event_type IN ('transferred','sold')
  `),
  onTransfer: db.prepare(`
    UPDATE inscriptions SET
      transfer_count = MAX(transfer_count - 1, 0),
      loan_count = loan_count + 1,
      active_loan_count = active_loan_count + 1,
      effective_owner = @borrower
    WHERE inscription_number = @inscription_number
  `),
  onSold: db.prepare(`
    UPDATE inscriptions SET
      sale_count = MAX(sale_count - 1, 0),
      total_volume_sats = MAX(total_volume_sats - COALESCE(@sale_price_sats, 0), 0),
      loan_count = loan_count + 1,
      active_loan_count = active_loan_count + 1,
      effective_owner = @borrower
    WHERE inscription_number = @inscription_number
  `),
  recomputeHighestSale: db.prepare(`
    UPDATE inscriptions
       SET highest_sale_sats = COALESCE((
             SELECT MAX(sale_price_sats) FROM events
              WHERE inscription_number = @inscription_number AND event_type = 'sold'
           ), 0)
     WHERE inscription_number = @inscription_number
  `),
  dequeueNotify: db.prepare(`DELETE FROM notify_pending WHERE event_id = @id`),
};

const apply = db.transaction(item => {
  const raw_json = JSON.stringify({
    source: item.match.source,
    confidence: confidenceFor(item.match, knownVaults),
    loan_type: 'origination',
    match_kind: item.match.matchKind,
    escrow_addr: item.match.escrowAddr,
    lender_addr: item.match.lender,
    borrower_addr: item.match.borrower,
    loan_amount_sats: item.match.loanAmountSats,
    activation_fee_sats: item.match.activationFeeSats,
    detector_version: DETECTOR_VERSION,
  });
  const r = stmts.upgrade.run({ id: item.row.id, raw_json });
  if (r.changes === 0) return false;
  if (item.row.event_type === 'sold') {
    stmts.onSold.run({
      inscription_number: item.row.inscription_number,
      sale_price_sats: item.row.sale_price_sats ?? 0,
      borrower: item.match.borrower,
    });
    stmts.recomputeHighestSale.run({ inscription_number: item.row.inscription_number });
  } else {
    stmts.onTransfer.run({
      inscription_number: item.row.inscription_number,
      borrower: item.match.borrower,
    });
  }
  stmts.dequeueNotify.run({ id: item.row.id });
  return true;
});

async function main() {
  let checked = 0;
  let matched = 0;
  let changed = 0;
  let knownOnly = 0;
  const failures = [];

  for (const row of rows) {
    checked++;
    let tx;
    try {
      tx = await rpc('getrawtransaction', [row.txid, 2]);
    } catch (e) {
      failures.push({ txid: row.txid, error: e.message });
      continue;
    }
    let match = detectProduction(tx);
    if (!match && knownLiquidiumTxids.has(row.txid)) {
      match = {
        source: 'known-liquidium-origination-fixture',
        confidence: 'high',
        matchKind: 'known-fixture',
        escrowAddr: addr(tx.vout[0]),
        lender: addr(tx.vout[3]),
        borrower: addr(tx.vout[2]),
        loanAmountSats: sats(tx.vout[2]),
        activationFeeSats: sats(tx.vout[1]),
      };
      knownOnly++;
    }
    if (!match) continue;
    matched++;
    if (!DRY_RUN && apply.immediate({ row, match })) changed++;
  }

  console.log(
    JSON.stringify(
      {
        dry_run: DRY_RUN,
        checked,
        matched,
        changed,
        known_only_matches: knownOnly,
        failures: failures.slice(0, 10),
      },
      null,
      2
    )
  );
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
