#!/usr/bin/env node
/* eslint-disable */
// On-chain loan lifecycle detection.
//
// Detects non-custodial Bitcoin loans collateralized by OMB inscriptions by
// finding taproot script-path spends whose witness script matches the
// timelocked-escrow shape:
//
//   <timelock_data> OP_CLTV|OP_CSV OP_DROP OP_PUSHBYTES_32 <32-byte pubkey> OP_CHECKSIG
//   bytes:           b1   |  b2     75      20              <32 bytes>      ac
//
// OP_CLTV (BIP-65, absolute timelock against the spending tx's nLocktime) is
// what the prod escrows we've seen actually use; OP_CSV (BIP-112, relative
// timelock against the input's nSequence) is the other plausible shape that
// future lenders might adopt, so we accept either.
//
// That shape is the loan-default leaf: the lender claims the inscription
// after the borrower fails to repay before <timelock_data>. Sister leaves
// without the timelock opcode are the unlock paths.
//
// Lifecycle this script reconstructs from on-chain state:
//
//   Phase 1 — defaults: script-path spends matching the shape above. Strict
//             structural guards reject atomic-swaps, HTLCs, lightning anchors,
//             and other CSV-bearing scripts.
//   Phase 2 — originations: for each default, trace the prevout to the tx that
//             created the taproot escrow. Validate via lender→borrower BTC
//             flow shape. Compute the loan principal as the borrower's net
//             receive (sum of outputs to borrower − sum of inputs from
//             borrower).
//   Phase 3 — unlocks: re-scan transferred events for taproot script-path
//             spends from a previously-identified escrow address WHERE the
//             script does NOT contain CSV+OP_DROP. The borrower has reclaimed
//             the collateral.
//   Phase 4 — repayments (best-effort): for each unlock, walk back ≤2 hops
//             from the unlock tx's non-inscription inputs to find a tx whose
//             output set contains the lender. If found, synthesize a
//             loan-repaid event row. This is informational only — the unlock
//             event already encodes the lifecycle outcome.
//
// All four upgrade in place where possible (UPDATE existing transferred rows)
// to keep events.id stable for activity-feed ordering. loan-repaid is the
// exception: it has no inscription movement, so it INSERTS a synthetic row
// keyed to the inscription_number with txid = repayment tx.
//
// effective_owner is updated alongside each event:
//   loan-originated → effective_owner = borrower (escrow holds it on-chain)
//   loan-defaulted  → effective_owner = lender
//   loan-unlocked   → effective_owner = current_owner (next ord poll confirms)
//
// Aggregates:
//   loan-originated: loan_count++, active_loan_count++, transfer_count--
//   loan-defaulted:  active_loan_count--, transfer_count--
//   loan-unlocked:   active_loan_count--, transfer_count--
//   loan-repaid:     no aggregate change (informational)
//
// Required env:
//   BITCOIN_RPC_URL    e.g. http://user:<password>@127.0.0.1:8332
// Optional env:
//   OMB_DB_PATH                  default ./tmp/dev.db
//   ONCHAIN_HEUR_CONCURRENCY     default 4
//
// CLI flags:
//   --dry-run                    Don't write to DB. Logs candidates only.
//                                (NOT the default — must opt out of writes.)
//   --inscription-number=N       Restrict to one inscription (smoke test).
//                                Repeatable.
//   --max-events=N               Safety cap on the work set.
//   --verbose                    Per-event debug logs.
//   --verify                     Verify against scripts/known-transactions.json.
//   --json                       Output findings as JSON for piping.
//
// Run AFTER backfill-transfers.js (needs transferred rows to inspect). Schema
// migration v17→v18 (which adds the loan event types and the loan_count /
// active_loan_count / effective_owner columns) is owned by src/lib/db.ts and
// runs automatically on app boot — this script does NOT migrate, it just
// reads + writes.
//
// Idempotent. Re-running upgrades the same rows to the same types and the
// aggregate adjustments only fire when the row's event_type actually changes
// (the WHERE event_type='transferred' clause guards against double-counting).

const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

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
    return { url: raw, authHeader: null };
  }
})();
const DB_PATH = process.env.OMB_DB_PATH ?? path.resolve(__dirname, '..', 'tmp', 'dev.db');
const CONCURRENCY = parseInt(process.env.ONCHAIN_HEUR_CONCURRENCY ?? '4', 10);
const REQUEST_TIMEOUT_MS = 30_000;
const BATCH_SIZE = 200;
const DETECTOR_VERSION = 2; // v1 = defaults-only; v2 = scan-all + unlocks + repayments

// Plausible timelock value bounds. CLTV (absolute) is either a Unix timestamp
// or a block height; CSV (relative) is either a relative number of seconds
// (encoded with the type-flag bit set, BIP-68) or a relative number of blocks.
// To keep the parser simple we treat the raw integer and accept it if it's
// EITHER a plausible timestamp (2023-01-01..2030-01-01) OR a plausible block
// height/count (144 to ~5M, covering 1 day relative to ~7 years absolute).
// Anything outside both is rejected as "this isn't a loan-shaped script."
const TIMELOCK_TIMESTAMP_MIN = 1_672_531_200; // 2023-01-01 UTC
const TIMELOCK_TIMESTAMP_MAX = 1_893_456_000; // 2030-01-01 UTC
const TIMELOCK_BLOCKS_MIN = 144;              // 1 day relative
const TIMELOCK_BLOCKS_MAX = 5_000_000;        // ~95 years; covers absolute heights into 2070s

// Repayment trace bounds. Larger walks let us find more repayments but blow up
// RPC cost; ≤2 hops covers the typical "borrower funds repay tx → unlock tx
// pulls a fee/dust input from the borrower's wallet" pattern.
const REPAYMENT_TRACE_MAX_HOPS = 2;

const ARGS = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = {
    dryRun: false,
    inscriptionNumbers: [],
    maxEvents: null,
    verbose: false,
    json: false,
    verify: false,
  };
  for (const a of argv) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--json') out.json = true;
    else if (a === '--verify') out.verify = true;
    else if (a.startsWith('--inscription-number=')) {
      const n = parseInt(a.slice('--inscription-number='.length), 10);
      if (Number.isFinite(n)) out.inscriptionNumbers.push(n);
    } else if (a.startsWith('--max-events=')) {
      out.maxEvents = parseInt(a.slice('--max-events='.length), 10);
    } else {
      console.error(`[loan-detector] unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

if (!RPC_URL) {
  console.error('[loan-detector] BITCOIN_RPC_URL is required');
  process.exit(1);
}

// ---------------- bitcoind RPC ----------------

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

// Memoized tx fetch — many queries hit the same prevouts repeatedly during
// origination tracing + repayment walks. ~64-byte tx ids, ~5KB tx bodies; a
// few thousand entries is well under any reasonable memory bound.
const txCache = new Map();
async function getTx(txid) {
  const cached = txCache.get(txid);
  if (cached) return cached;
  const tx = await rpc('getrawtransaction', [txid, 2]);
  txCache.set(txid, tx);
  return tx;
}

// ---------------- helpers ----------------

function btcToSats(v) {
  if (typeof v === 'number') return BigInt(Math.round(v * 1e8));
  if (typeof v === 'string') {
    const [whole, frac = ''] = v.split('.');
    const padded = (frac + '00000000').slice(0, 8);
    return BigInt(whole || '0') * 100_000_000n + BigInt(padded || '0');
  }
  return 0n;
}

function addressFromScriptPubKey(spk) {
  if (!spk || typeof spk !== 'object') return null;
  if (typeof spk.address === 'string' && spk.address.length > 0) return spk.address;
  if (Array.isArray(spk.addresses) && typeof spk.addresses[0] === 'string') return spk.addresses[0];
  return null;
}

// ---------------- taproot script-path analysis ----------------
//
// Witness layout for a taproot script-path spend (BIP-341):
//   [stack items..., script, control_block]
// The control block starts with a version byte 0xc0 or 0xc1 (parity + leaf
// version 0). A key-path spend is a single 64- or 65-byte signature, so any
// 1-item witness is NOT script-path.

// Returns null if vin is not a taproot script-path spend.
// Returns { scriptHex, controlBlockHex } if it is.
function extractTaprootScriptPath(vin) {
  if (!vin || !Array.isArray(vin.txinwitness)) return null;
  if (vin.txinwitness.length < 2) return null;

  const controlBlock = vin.txinwitness[vin.txinwitness.length - 1];
  if (typeof controlBlock !== 'string') return null;
  const firstByte = parseInt(controlBlock.slice(0, 2), 16);
  if (firstByte !== 0xc0 && firstByte !== 0xc1) return null;

  // Control block length must be 33 + 32k bytes (k merkle siblings, k ≤ 128).
  const cbBytes = controlBlock.length / 2;
  if (cbBytes < 33 || (cbBytes - 33) % 32 !== 0) return null;

  const scriptHex = vin.txinwitness[vin.txinwitness.length - 2];
  if (typeof scriptHex !== 'string') return null;

  return { scriptHex, controlBlockHex: controlBlock };
}

// Loan default leaf: <push TIMELOCK_BYTES> (b1|b2) 75 20 <32-byte pubkey> ac
//
// Returns { timelockBytes, timelockNumber, timelockKind, opcode, pubkeyHex }
// when the script is a valid loan-default leaf, null otherwise.
// timelockKind is 'timestamp' or 'blocks' depending on which plausibility
// window the value falls in. opcode is 'CLTV' or 'CSV'.
function parseLoanDefaultLeaf(scriptHex) {
  // Minimum length: 1 (push opcode) + 1 (data byte) + 2 (opcode b1|b2 + 75) + 1 (push 32) + 32 (pubkey) + 1 (ac) = 38 bytes = 76 hex chars
  if (typeof scriptHex !== 'string' || scriptHex.length < 76) return null;

  const opByte = parseInt(scriptHex.slice(0, 2), 16);
  let dataLen = 0;
  let dataStart = 2;
  if (opByte >= 0x01 && opByte <= 0x4b) {
    dataLen = opByte;
  } else if (opByte === 0x4c) {
    dataLen = parseInt(scriptHex.slice(2, 4), 16);
    dataStart = 4;
  } else if (opByte === 0x4d) {
    const lo = scriptHex.slice(2, 4);
    const hi = scriptHex.slice(4, 6);
    dataLen = parseInt(hi + lo, 16);
    dataStart = 6;
  } else {
    return null;
  }
  // CLTV/CSV both consume up to 4 bytes (nLocktime / nSequence are uint32).
  // Push lengths >4 are a signal of "this isn't a loan timelock."
  if (dataLen <= 0 || dataLen > 5) return null; // 5 to allow the canonical encoding for unsigned values requiring a leading 0x00
  const dataBytesEnd = dataStart + dataLen * 2;
  if (dataBytesEnd >= scriptHex.length) return null;

  const timelockBytes = scriptHex.slice(dataStart, dataBytesEnd);

  // Next two bytes must be either b1 75 (CLTV+DROP) or b2 75 (CSV+DROP).
  const opcodeBytes = scriptHex.slice(dataBytesEnd, dataBytesEnd + 4);
  let opcode;
  if (opcodeBytes === 'b175') opcode = 'CLTV';
  else if (opcodeBytes === 'b275') opcode = 'CSV';
  else return null;

  const pushOpOff = dataBytesEnd + 4;
  if (scriptHex.slice(pushOpOff, pushOpOff + 2) !== '20') return null;
  const pubkeyOff = pushOpOff + 2;
  const pubkeyHex = scriptHex.slice(pubkeyOff, pubkeyOff + 64);
  if (pubkeyHex.length !== 64) return null;
  const checksigOff = pubkeyOff + 64;
  if (scriptHex.slice(checksigOff, checksigOff + 2) !== 'ac') return null;
  // Strict: the script must end here. Trailing opcodes mean the leaf does
  // more than a single CHECKSIG, which is not the loan shape.
  if (checksigOff + 2 !== scriptHex.length) return null;

  // Decode timelock value (little-endian script number; signed but loan
  // timelocks are positive, so the standard parse works).
  let timelockNumber = 0;
  for (let i = 0; i < dataLen; i++) {
    const b = parseInt(timelockBytes.slice(i * 2, i * 2 + 2), 16);
    timelockNumber += b * Math.pow(2, i * 8);
  }
  let timelockKind = null;
  if (timelockNumber >= TIMELOCK_TIMESTAMP_MIN && timelockNumber <= TIMELOCK_TIMESTAMP_MAX) {
    timelockKind = 'timestamp';
  } else if (timelockNumber >= TIMELOCK_BLOCKS_MIN && timelockNumber <= TIMELOCK_BLOCKS_MAX) {
    timelockKind = 'blocks';
  } else {
    return null; // implausible — could be HTLC, atomic swap, etc.
  }

  return { timelockBytes, timelockNumber, timelockKind, opcode, pubkeyHex };
}

// Loan unlock leaf: <push 32> <32-byte pubkey> <ac>  (just 1 CHECKSIG, no CSV)
// This is permissive — it matches any single-pubkey CHECKSIG taproot script.
// Combined with the "must spend a known escrow address" check in caller, the
// chance of false-positive is low (an arbitrary single-CHECKSIG taproot leaf
// would have to coincidentally be on a previously-classified loan escrow
// address, which doesn't happen — escrow addresses are per-loan unique).
function parseUnlockLeaf(scriptHex) {
  if (typeof scriptHex !== 'string' || scriptHex.length !== 68) return null;
  if (scriptHex.slice(0, 2) !== '20') return null;
  const pubkeyHex = scriptHex.slice(2, 66);
  if (pubkeyHex.length !== 64) return null;
  if (scriptHex.slice(66, 68) !== 'ac') return null;
  return { pubkeyHex };
}

// ---------------- classification: spend-side ----------------
//
// Classifies a tx by inspecting its inputs for the loan-default leaf or the
// unlock-candidate leaf shape. Returns:
//   { kind: 'default',         escrowAddr, lender, timelock, prevoutTxid, prevoutVout, vinIndex, scriptHex, txid, blockTime }
//   { kind: 'unlock-candidate', escrowAddr, prevoutTxid, prevoutVout, vinIndex, pubkeyHex, txid, blockTime }
//   { kind: 'skip', reason }
//
// Unlock candidates are SHAPE matches only — many random taproot
// single-CHECKSIG leaves exist in the wild (Liquidium-style and others).
// Origination tracing in Phase 2 confirms whether the prevout was actually a
// loan escrow.
function classifySpendSide(tx) {
  if (!tx || !Array.isArray(tx.vin) || !Array.isArray(tx.vout)) {
    return { kind: 'skip', reason: 'bad-tx' };
  }
  if (tx.vin.some((v) => v && v.coinbase)) {
    return { kind: 'skip', reason: 'coinbase' };
  }

  // Default detection (strict): script-path with timelock+drop+single-checksig.
  for (let i = 0; i < tx.vin.length; i++) {
    const vin = tx.vin[i];
    const sp = extractTaprootScriptPath(vin);
    if (!sp) continue;
    const leaf = parseLoanDefaultLeaf(sp.scriptHex);
    if (!leaf) continue;

    const escrowAddr = addressFromScriptPubKey(vin.prevout?.scriptPubKey);
    if (!escrowAddr) return { kind: 'skip', reason: 'no-escrow-addr' };

    // Lender = the dominant non-escrow input.
    const lenderCandidates = new Map();
    for (let j = 0; j < tx.vin.length; j++) {
      if (j === i) continue;
      const v = tx.vin[j];
      const a = addressFromScriptPubKey(v.prevout?.scriptPubKey);
      if (!a) continue;
      const sats = Number(btcToSats(v.prevout?.value ?? 0));
      lenderCandidates.set(a, (lenderCandidates.get(a) ?? 0) + sats);
    }
    let lender = null;
    let lenderSats = 0;
    for (const [addr, sats] of lenderCandidates) {
      if (sats > lenderSats) {
        lenderSats = sats;
        lender = addr;
      }
    }
    // Fallback: lender = largest output recipient (covers single-input defaults).
    if (!lender) {
      let bestSats = 0;
      for (const o of tx.vout) {
        const a = addressFromScriptPubKey(o.scriptPubKey);
        if (!a) continue;
        const sats = Number(btcToSats(o.value));
        if (sats > bestSats) {
          bestSats = sats;
          lender = a;
        }
      }
    }
    if (!lender) return { kind: 'skip', reason: 'no-lender' };

    return {
      kind: 'default',
      escrowAddr,
      lender,
      timelock: {
        bytes: leaf.timelockBytes,
        number: leaf.timelockNumber,
        kind: leaf.timelockKind,
        opcode: leaf.opcode,
      },
      prevoutTxid: vin.txid,
      prevoutVout: vin.vout,
      vinIndex: i,
      scriptHex: sp.scriptHex,
      txid: tx.txid,
      blockTime: tx.blocktime,
    };
  }

  // Unlock-candidate detection (permissive): script-path with single-pubkey
  // CHECKSIG leaf and no timelock. Validation happens in Phase 2 when we try
  // to trace the prevout back to a loan-origination-shaped tx.
  for (let i = 0; i < tx.vin.length; i++) {
    const vin = tx.vin[i];
    const sp = extractTaprootScriptPath(vin);
    if (!sp) continue;
    if (parseLoanDefaultLeaf(sp.scriptHex)) continue; // already would have matched above
    if (!parseUnlockLeaf(sp.scriptHex)) continue;
    const escrowAddr = addressFromScriptPubKey(vin.prevout?.scriptPubKey);
    if (!escrowAddr) continue;
    return {
      kind: 'unlock-candidate',
      escrowAddr,
      prevoutTxid: vin.txid,
      prevoutVout: vin.vout,
      vinIndex: i,
      pubkeyHex: parseUnlockLeaf(sp.scriptHex).pubkeyHex,
      txid: tx.txid,
      blockTime: tx.blocktime,
    };
  }

  return { kind: 'skip', reason: 'no-loan-leaf' };
}

// ---------------- origination tracing ----------------

// Traces a default's prevout back to the tx that created the escrow output.
// Returns:
//   { kind: 'origination', txid, escrowAddr, lender, borrower, loanAmountSats,
//     blockTimestamp, blockHeight, escrowVout }
//   { kind: 'skip', reason }
//
// Validation guards:
//   - tx must contain an output to escrowAddr
//   - non-escrow funding flow: 1+ input addresses (the lender or lender+fee
//     payer); 1+ non-escrow output addresses (the borrower receives proceeds);
//     borrower must NOT be the lender (that's a self-spend, not a loan)
async function traceOrigination(defaultResult) {
  const { prevoutTxid, escrowAddr } = defaultResult;
  let tx;
  try {
    tx = await getTx(prevoutTxid);
  } catch (e) {
    return { kind: 'skip', reason: `orig-rpc-fail:${e.message.slice(0, 80)}` };
  }
  if (!tx || !Array.isArray(tx.vin) || !Array.isArray(tx.vout)) {
    return { kind: 'skip', reason: 'bad-orig-tx' };
  }

  const escrowVout = tx.vout.findIndex(
    (o) => addressFromScriptPubKey(o.scriptPubKey) === escrowAddr
  );
  if (escrowVout < 0) return { kind: 'skip', reason: 'escrow-not-here' };

  // Sum inputs by address (= who funded this tx).
  const inputBy = new Map();
  for (const vin of tx.vin) {
    const a = addressFromScriptPubKey(vin.prevout?.scriptPubKey);
    if (!a) continue;
    const sats = Number(btcToSats(vin.prevout?.value ?? 0));
    inputBy.set(a, (inputBy.get(a) ?? 0) + sats);
  }
  // Sum outputs by address (excluding the escrow itself).
  const outputBy = new Map();
  for (let i = 0; i < tx.vout.length; i++) {
    if (i === escrowVout) continue;
    const a = addressFromScriptPubKey(tx.vout[i].scriptPubKey);
    if (!a) continue;
    const sats = Number(btcToSats(tx.vout[i].value));
    outputBy.set(a, (outputBy.get(a) ?? 0) + sats);
  }

  // Lender = largest input contributor. Borrower = largest non-lender output
  // recipient. (We don't try to over-engineer "is the lender's change
  // identifiable" — picking the dominant non-lender output is correct in the
  // 2-input/2-output cooperative-origination shape these escrows use.)
  let lender = null;
  let lenderInputSats = 0;
  for (const [addr, sats] of inputBy) {
    if (sats > lenderInputSats) {
      lenderInputSats = sats;
      lender = addr;
    }
  }
  if (!lender) return { kind: 'skip', reason: 'no-lender-input' };

  let borrower = null;
  let borrowerOutputSats = 0;
  for (const [addr, sats] of outputBy) {
    if (addr === lender) continue;
    if (addr === escrowAddr) continue;
    if (sats > borrowerOutputSats) {
      borrowerOutputSats = sats;
      borrower = addr;
    }
  }
  if (!borrower) return { kind: 'skip', reason: 'no-borrower-output' };
  if (borrower === lender) return { kind: 'skip', reason: 'self-spend' };

  // Loan amount = borrower's net receive: outputs to borrower − inputs from
  // borrower (the borrower contributed the inscription input, value typically
  // 1-10k sats). Falls back to gross output if borrower has no inputs.
  const borrowerInputSats = inputBy.get(borrower) ?? 0;
  const loanAmountSats = Math.max(0, borrowerOutputSats - borrowerInputSats);
  if (loanAmountSats <= 0) return { kind: 'skip', reason: 'no-loan-flow' };

  return {
    kind: 'origination',
    txid: tx.txid,
    escrowAddr,
    lender,
    borrower,
    loanAmountSats,
    blockTimestamp: tx.blocktime ?? null,
    blockHeight: null, // bitcoind doesn't return block height in getrawtransaction
    escrowVout,
  };
}

// ---------------- repayment trace ----------------
//
// For a detected unlock, walk back ≤REPAYMENT_TRACE_MAX_HOPS hops from the
// unlock tx's NON-escrow inputs looking for a tx whose outputs include the
// lender. Returns the matching tx (the repayment tx) or null if not found.
//
// Bounded walk: we don't BFS the whole graph — at each level we expand each
// candidate's source txs, capped at MAX_BRANCHING per level, total RPC calls
// per unlock bounded by MAX_BRANCHING ^ MAX_HOPS.

const MAX_BRANCHING_PER_LEVEL = 4;

async function traceRepayment(unlockTx, escrowVinIndex, lenderAddr, originationBlock) {
  // Seed the frontier with the parent-tx of each non-escrow input of the unlock.
  const seedTxids = [];
  for (let i = 0; i < unlockTx.vin.length; i++) {
    if (i === escrowVinIndex) continue;
    const v = unlockTx.vin[i];
    if (typeof v?.txid !== 'string') continue;
    seedTxids.push(v.txid);
  }
  if (seedTxids.length === 0) return null;

  let frontier = seedTxids.slice(0, MAX_BRANCHING_PER_LEVEL);
  const seen = new Set();

  for (let hop = 0; hop < REPAYMENT_TRACE_MAX_HOPS; hop++) {
    const next = [];
    for (const txid of frontier) {
      if (seen.has(txid)) continue;
      seen.add(txid);

      let tx;
      try {
        tx = await getTx(txid);
      } catch {
        continue;
      }
      if (!tx || !Array.isArray(tx.vout)) continue;

      // Confirmation that this tx is at or after origination — we don't want
      // to match a tx that pre-dates the loan (which would be a coincidence).
      if (originationBlock != null && tx.blocktime != null && tx.blocktime < originationBlock) {
        continue;
      }

      // Match: lender appears as an output recipient. Take the first such tx
      // (closest hop wins). The matched tx is the repayment.
      for (const o of tx.vout) {
        const a = addressFromScriptPubKey(o.scriptPubKey);
        if (a === lenderAddr) {
          return {
            txid: tx.txid,
            blockTimestamp: tx.blocktime ?? null,
            paymentSats: Number(btcToSats(o.value)),
          };
        }
      }

      // Expand the frontier with this tx's input parents.
      if (Array.isArray(tx.vin)) {
        for (const v of tx.vin) {
          if (typeof v?.txid === 'string') next.push(v.txid);
        }
      }
    }
    frontier = next.slice(0, MAX_BRANCHING_PER_LEVEL);
    if (frontier.length === 0) break;
  }
  return null;
}

// ---------------- main ----------------

async function main() {
  const db = new Database(DB_PATH, { readonly: ARGS.dryRun });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  // Fail-fast bitcoind probe.
  try {
    const info = await rpc('getblockchaininfo', []);
    console.log(
      `[loan-detector] bitcoind ok: blocks=${info.blocks} chain=${info.chain}`
    );
  } catch (e) {
    console.error('[loan-detector] bitcoind RPC failed:', e.message);
    process.exit(1);
  }

  // Verify schema is at v19 or later — v18 widened the events CHECK but v19
  // is what added the loan_count / active_loan_count / effective_owner
  // columns this script writes to. Without v19 the writes would fail.
  const schemaVer = db.pragma('user_version', { simple: true });
  if (schemaVer < 19) {
    console.error(
      `[loan-detector] schema is v${schemaVer}, need v19+. Boot the app once to run migrations, then re-run.`
    );
    process.exit(1);
  }

  console.log(
    `[loan-detector] db=${DB_PATH} dryRun=${ARGS.dryRun} concurrency=${CONCURRENCY} schema=v${schemaVer}`
  );

  // ---- prepared statements (lazy: only build in write mode) ----
  //
  // Better-sqlite3 validates SQL at prepare-time, so referencing the v18
  // columns (loan_count / active_loan_count / effective_owner) here would
  // throw against a DB where the script-side migration ran but the app's
  // db.ts hasn't been re-run yet (or vice versa). Defer to the write block.
  let writeStmts = null;
  function getWriteStmts() {
    if (writeStmts) return writeStmts;
    writeStmts = {
      upgradeToDefault: db.prepare(`
        UPDATE events
           SET event_type = 'loan-defaulted',
               raw_json   = @raw_json
         WHERE inscription_id = @inscription_id
           AND txid           = @txid
           AND event_type     = 'transferred'
      `),
      upgradeToOrigination: db.prepare(`
        UPDATE events
           SET event_type = 'loan-originated',
               raw_json   = @raw_json
         WHERE inscription_id = @inscription_id
           AND txid           = @txid
           AND event_type     IN ('transferred','sold')
      `),
      upgradeToUnlock: db.prepare(`
        UPDATE events
           SET event_type = 'loan-unlocked',
               raw_json   = @raw_json
         WHERE inscription_id = @inscription_id
           AND txid           = @txid
           AND event_type     = 'transferred'
      `),
      insertRepaid: db.prepare(`
        INSERT OR IGNORE INTO events
          (inscription_id, inscription_number, event_type, block_timestamp,
           txid, old_owner, new_owner, raw_json)
        VALUES
          (@inscription_id, @inscription_number, 'loan-repaid', @block_timestamp,
           @txid, @borrower, @lender, @raw_json)
      `),
      onOrigination: db.prepare(`
        UPDATE inscriptions SET
          transfer_count    = MAX(transfer_count - 1, 0),
          loan_count        = loan_count + 1,
          active_loan_count = active_loan_count + 1,
          effective_owner   = @borrower
        WHERE inscription_number = @inscription_number
      `),
      onDefault: db.prepare(`
        UPDATE inscriptions SET
          transfer_count    = MAX(transfer_count - 1, 0),
          active_loan_count = MAX(active_loan_count - 1, 0),
          effective_owner   = @lender
        WHERE inscription_number = @inscription_number
      `),
      onUnlock: db.prepare(`
        UPDATE inscriptions SET
          transfer_count    = MAX(transfer_count - 1, 0),
          active_loan_count = MAX(active_loan_count - 1, 0),
          effective_owner   = current_owner
        WHERE inscription_number = @inscription_number
      `),
    };
    return writeStmts;
  }

  // ---- Phase 1: scan all transferred events + previously-classified loan
  // events. Including loan-* rows lets re-runs re-detect (and verify)
  // existing classifications without losing them. The write phase's
  // upgrade-only-if-transferred guard prevents double-counting.

  const where = [
    "e.event_type IN ('transferred','loan-originated','loan-defaulted','loan-unlocked')",
    "e.old_owner != e.new_owner",
  ];
  const sqlParams = {};
  if (ARGS.inscriptionNumbers.length > 0) {
    const placeholders = ARGS.inscriptionNumbers.map((_, i) => `@n${i}`).join(',');
    where.push(`e.inscription_number IN (${placeholders})`);
    ARGS.inscriptionNumbers.forEach((n, i) => {
      sqlParams[`n${i}`] = n;
    });
  }
  let sql = `
    SELECT e.id, e.inscription_id, e.inscription_number, e.txid,
           e.old_owner, e.new_owner, e.block_timestamp
      FROM events e
     WHERE ${where.join(' AND ')}
     ORDER BY e.block_timestamp ASC, e.id ASC
  `;
  if (ARGS.maxEvents != null) sql += ` LIMIT ${ARGS.maxEvents}`;
  const targets = db.prepare(sql).all(sqlParams);

  // Deduplicate by txid — one tx may carry multiple inscriptions.
  const txToEvents = new Map(); // txid → events[]
  for (const t of targets) {
    if (!txToEvents.has(t.txid)) txToEvents.set(t.txid, []);
    txToEvents.get(t.txid).push(t);
  }
  const uniqueTxids = [...txToEvents.keys()];
  console.log(
    `[loan-detector] phase 1: classifying ${uniqueTxids.length} unique txids (${targets.length} events)`
  );

  // ---- Phase 1: classify every tx as default / unlock-candidate / skip ----

  const defaults = [];          // { verdict, events }
  const unlockCandidates = [];  // { verdict, events }
  const skipReasons = Object.create(null);
  let processed = 0;
  let errors = 0;
  const startedAt = Date.now();

  let next = 0;
  async function classifyWorker() {
    while (next < uniqueTxids.length) {
      const i = next++;
      const txid = uniqueTxids[i];
      try {
        const tx = await getTx(txid);
        const verdict = classifySpendSide(tx);
        if (verdict.kind === 'default') {
          defaults.push({ verdict, events: txToEvents.get(txid) });
          if (ARGS.verbose || defaults.length <= 10) {
            console.log(
              `[loan-detector] DEFAULT  ${txid.slice(0, 16)}… ` +
                `escrow=${verdict.escrowAddr.slice(0, 16)}… ` +
                `lender=${verdict.lender.slice(0, 16)}… ` +
                `${verdict.timelock.opcode}=${verdict.timelock.number} (${verdict.timelock.kind})`
            );
          }
        } else if (verdict.kind === 'unlock-candidate') {
          unlockCandidates.push({ verdict, events: txToEvents.get(txid) });
          if (ARGS.verbose || unlockCandidates.length <= 5) {
            console.log(
              `[loan-detector] UNLOCK?  ${txid.slice(0, 16)}… ` +
                `escrow=${verdict.escrowAddr.slice(0, 16)}…`
            );
          }
        } else {
          skipReasons[verdict.reason] = (skipReasons[verdict.reason] ?? 0) + 1;
        }
      } catch (e) {
        errors++;
        if (errors <= 5) {
          console.error(`[loan-detector] err ${txid.slice(0, 16)}…:`, e.message);
        }
      }
      processed++;
      if (processed % 200 === 0) {
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = processed / elapsed;
        console.log(
          `[loan-detector] phase 1: ${processed}/${uniqueTxids.length} ` +
            `defaults=${defaults.length} unlock-cands=${unlockCandidates.length} ` +
            `err=${errors} ${rate.toFixed(1)}/s`
        );
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, classifyWorker));
  console.log(
    `[loan-detector] phase 1 done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ` +
      `defaults=${defaults.length} unlock-candidates=${unlockCandidates.length} errors=${errors}`
  );

  // ---- Phase 2: trace originations from BOTH defaults and unlock-candidates.
  //
  // For unlock-candidates, the origination trace is also the validation step:
  // if the prevout's creating tx doesn't have the loan-origination shape
  // (1 dominant lender input, 1 escrow output, 1 dominant borrower output),
  // it's not a real loan and we drop the candidate.

  const originations = [];     // { origination, source: 'default'|'unlock', sourceEntry }
  const escrowMap = new Map(); // escrowAddr → { lender, borrower, loanAmountSats, originationTxid, originationBlock, inscriptionNumber, inscriptionId }
  const unlocks = [];          // { verdict, events, escrowInfo }

  console.log(
    `[loan-detector] phase 2: tracing ${defaults.length} default-origs + ` +
      `${unlockCandidates.length} unlock-cand-origs`
  );
  const phase2Start = Date.now();

  for (const d of defaults) {
    const orig = await traceOrigination(d.verdict);
    if (orig.kind === 'origination') {
      const ev = d.events[0];
      orig.inscriptionNumber = ev.inscription_number;
      orig.inscriptionId = ev.inscription_id;
      originations.push({ origination: orig, source: 'default', sourceEntry: d });
      escrowMap.set(orig.escrowAddr, {
        lender: orig.lender,
        borrower: orig.borrower,
        loanAmountSats: orig.loanAmountSats,
        originationTxid: orig.txid,
        originationBlock: orig.blockTimestamp,
        inscriptionNumber: orig.inscriptionNumber,
        inscriptionId: orig.inscriptionId,
      });
      if (ARGS.verbose || originations.length <= 10) {
        console.log(
          `[loan-detector] ORIG     ${orig.txid.slice(0, 16)}… ` +
            `escrow=${orig.escrowAddr.slice(0, 16)}… ` +
            `lender=${orig.lender.slice(0, 16)}… ` +
            `borrower=${orig.borrower.slice(0, 16)}… ` +
            `loan=${(orig.loanAmountSats / 1e8).toFixed(4)} BTC (from default)`
        );
      }
    } else {
      skipReasons[`orig:${orig.reason}`] = (skipReasons[`orig:${orig.reason}`] ?? 0) + 1;
    }
  }

  for (const uc of unlockCandidates) {
    // If we've already mapped this escrow via a default trace, the unlock is
    // already validated — skip the redundant origination trace.
    let escrowInfo = escrowMap.get(uc.verdict.escrowAddr);
    if (!escrowInfo) {
      const orig = await traceOrigination(uc.verdict);
      if (orig.kind !== 'origination') {
        skipReasons[`unlock-orig:${orig.reason}`] = (skipReasons[`unlock-orig:${orig.reason}`] ?? 0) + 1;
        continue;
      }
      const ev = uc.events[0];
      orig.inscriptionNumber = ev.inscription_number;
      orig.inscriptionId = ev.inscription_id;
      escrowInfo = {
        lender: orig.lender,
        borrower: orig.borrower,
        loanAmountSats: orig.loanAmountSats,
        originationTxid: orig.txid,
        originationBlock: orig.blockTimestamp,
        inscriptionNumber: orig.inscriptionNumber,
        inscriptionId: orig.inscriptionId,
      };
      escrowMap.set(orig.escrowAddr, escrowInfo);
      originations.push({ origination: orig, source: 'unlock', sourceEntry: uc });
      if (ARGS.verbose || originations.length <= 10) {
        console.log(
          `[loan-detector] ORIG     ${orig.txid.slice(0, 16)}… ` +
            `escrow=${orig.escrowAddr.slice(0, 16)}… ` +
            `lender=${orig.lender.slice(0, 16)}… ` +
            `borrower=${orig.borrower.slice(0, 16)}… ` +
            `loan=${(orig.loanAmountSats / 1e8).toFixed(4)} BTC (from unlock)`
        );
      }
    }
    unlocks.push({ verdict: uc.verdict, events: uc.events, escrowInfo });
    if (ARGS.verbose || unlocks.length <= 10) {
      console.log(
        `[loan-detector] UNLOCK   ${uc.verdict.txid.slice(0, 16)}… ` +
          `escrow=${uc.verdict.escrowAddr.slice(0, 16)}…`
      );
    }
  }

  console.log(
    `[loan-detector] phase 2 done in ${((Date.now() - phase2Start) / 1000).toFixed(1)}s — ` +
      `originations=${originations.length} escrows=${escrowMap.size} unlocks=${unlocks.length}`
  );

  // ---- Phase 3: trace repayments for each unlock (best-effort) ----

  const repayments = []; // { unlock, repayment }
  if (unlocks.length > 0) {
    console.log(`[loan-detector] phase 3: tracing ${unlocks.length} repayments`);
    const phase3Start = Date.now();
    for (const u of unlocks) {
      try {
        const tx = await getTx(u.verdict.txid);
        const r = await traceRepayment(
          tx,
          u.verdict.vinIndex,
          u.escrowInfo.lender,
          u.escrowInfo.originationBlock
        );
        if (r) {
          repayments.push({ unlock: u, repayment: r });
          if (ARGS.verbose || repayments.length <= 10) {
            console.log(
              `[loan-detector] REPAID   ${r.txid.slice(0, 16)}… ` +
                `→ lender ${u.escrowInfo.lender.slice(0, 16)}… ` +
                `${(r.paymentSats / 1e8).toFixed(4)} BTC`
            );
          }
        }
      } catch (e) {
        if (ARGS.verbose) console.error(`[loan-detector] repay-trace err:`, e.message);
      }
    }
    console.log(
      `[loan-detector] phase 3 done in ${((Date.now() - phase3Start) / 1000).toFixed(1)}s — ` +
        `repayments=${repayments.length}/${unlocks.length}`
    );
  }

  // ---- Write phase ----

  let writeStats = { defaults: 0, originations: 0, unlocks: 0, repayments: 0 };

  if (!ARGS.dryRun) {
    console.log(
      `[loan-detector] writing: ${defaults.length} defaults, ` +
        `${originations.length} originations, ${unlocks.length} unlocks, ` +
        `${repayments.length} repayments`
    );

    // All writes for one run land in one transaction so the inscription
    // aggregates and event upgrades stay consistent if a SIGTERM hits mid-run.
    const w = getWriteStmts();
    const writeAll = db.transaction(() => {
      // Originations FIRST so active_loan_count is bumped before any
      // default/unlock decrements it. Otherwise the MAX(x-1, 0) clamp would
      // eat the decrement (0→0) for inscriptions whose origination event
      // gets processed in the same tick — leaving active_loan_count stuck
      // at 1 after origination instead of 0 after the close-out event.
      // effective_owner ends correct either way: defaults overwrite to
      // lender; unlocks overwrite to current_owner.
      for (const o of originations) {
        const orig = o.origination;
        const raw = JSON.stringify({
          source: 'onchain-loan-heuristic',
          confidence: 'high',
          loan_type: 'origination',
          escrow_addr: orig.escrowAddr,
          lender_addr: orig.lender,
          borrower_addr: orig.borrower,
          loan_amount_sats: orig.loanAmountSats,
          detector_version: DETECTOR_VERSION,
        });
        const u = w.upgradeToOrigination.run({
          inscription_id: orig.inscriptionId,
          txid: orig.txid,
          raw_json: raw,
        });
        if (u.changes > 0) {
          w.onOrigination.run({
            inscription_number: orig.inscriptionNumber,
            borrower: orig.borrower,
          });
          writeStats.originations++;
        }
      }

      for (const d of defaults) {
        const v = d.verdict;
        // borrower_addr is known via the escrowMap (populated when origination
        // tracing succeeded for this escrow). Including it on the default row
        // lets /holder/[borrower] surface "you got defaulted on" without
        // having to JOIN-walk back to the origination event.
        const escrowInfo = escrowMap.get(v.escrowAddr);
        const raw = JSON.stringify({
          source: 'onchain-loan-heuristic',
          confidence: 'high',
          loan_type: 'default',
          escrow_addr: v.escrowAddr,
          lender_addr: v.lender,
          borrower_addr: escrowInfo?.borrower ?? null,
          timelock_value: v.timelock.number,
          timelock_kind: v.timelock.kind,
          timelock_opcode: v.timelock.opcode,
          prevout_txid: v.prevoutTxid,
          prevout_vout: v.prevoutVout,
          detector_version: DETECTOR_VERSION,
        });
        for (const ev of d.events) {
          const u = w.upgradeToDefault.run({
            inscription_id: ev.inscription_id,
            txid: ev.txid,
            raw_json: raw,
          });
          if (u.changes > 0) {
            w.onDefault.run({
              inscription_number: ev.inscription_number,
              lender: v.lender,
            });
            writeStats.defaults++;
          }
        }
      }

      for (const u of unlocks) {
        const info = u.escrowInfo;
        const raw = JSON.stringify({
          source: 'onchain-loan-heuristic',
          confidence: 'high',
          loan_type: 'unlock',
          escrow_addr: u.verdict.escrowAddr,
          lender_addr: info.lender,
          borrower_addr: info.borrower,
          loan_amount_sats: info.loanAmountSats,
          origination_txid: info.originationTxid,
          detector_version: DETECTOR_VERSION,
        });
        for (const ev of u.events) {
          const r = w.upgradeToUnlock.run({
            inscription_id: ev.inscription_id,
            txid: ev.txid,
            raw_json: raw,
          });
          if (r.changes > 0) {
            w.onUnlock.run({ inscription_number: ev.inscription_number });
            writeStats.unlocks++;
          }
        }
      }

      for (const r of repayments) {
        const info = r.unlock.escrowInfo;
        const raw = JSON.stringify({
          source: 'onchain-loan-heuristic',
          confidence: 'medium', // best-effort short walk — not every match is the actual repayment
          loan_type: 'repayment',
          escrow_addr: r.unlock.verdict.escrowAddr,
          lender_addr: info.lender,
          borrower_addr: info.borrower,
          loan_amount_sats: info.loanAmountSats,
          payment_sats: r.repayment.paymentSats,
          unlock_txid: r.unlock.verdict.txid,
          detector_version: DETECTOR_VERSION,
        });
        const ins = w.insertRepaid.run({
          inscription_id: info.inscriptionId,
          inscription_number: info.inscriptionNumber,
          block_timestamp: r.repayment.blockTimestamp ?? r.unlock.verdict.blockTime,
          txid: r.repayment.txid,
          borrower: info.borrower,
          lender: info.lender,
          raw_json: raw,
        });
        if (ins.changes > 0) writeStats.repayments++;
      }
    });
    writeAll.immediate();
    console.log(
      `[loan-detector] write complete: defaults=${writeStats.defaults} ` +
        `originations=${writeStats.originations} unlocks=${writeStats.unlocks} ` +
        `repayments=${writeStats.repayments}`
    );
  }

  // ---- Summary ----

  const totalElapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n[loan-detector] COMPLETE in ${totalElapsed}s`);
  console.log(`  defaults:     ${defaults.length}`);
  console.log(`  originations: ${originations.length}`);
  console.log(`  unlocks:      ${unlocks.length}`);
  console.log(`  repayments:   ${repayments.length}`);
  console.log(`  escrows:      ${escrowMap.size}`);
  console.log(`  errors:       ${errors}`);
  if (Object.keys(skipReasons).length > 0) {
    console.log(`  skip reasons:`, skipReasons);
  }

  // ---- Verification ----

  if (ARGS.verify) {
    runVerification({ defaults, originations, unlocks, repayments });
  }

  if (ARGS.json) {
    console.log(
      '\n[JSON]',
      JSON.stringify({
        defaults: defaults.map((d) => ({ ...d.verdict, events: d.events })),
        originations: originations.map((o) => o.origination),
        unlocks: unlocks.map((u) => ({ ...u.verdict, events: u.events, escrowInfo: u.escrowInfo })),
        repayments: repayments.map((r) => ({ ...r.repayment, unlock_txid: r.unlock.unlock.txid })),
      })
    );
  }

  db.close();
}

function runVerification({ defaults, originations, unlocks, repayments }) {
  const knownPath = path.resolve(__dirname, 'known-transactions.json');
  let known;
  try {
    known = JSON.parse(fs.readFileSync(knownPath, 'utf-8'));
  } catch (e) {
    console.log(`[loan-detector] VERIFY: could not load ${knownPath}: ${e.message}`);
    return;
  }
  if (!known || !Array.isArray(known.transactions)) return;

  const defaultTxids = new Set(defaults.map((d) => d.verdict.txid));
  const origTxids = new Set(originations.map((o) => o.origination.txid));
  const unlockTxids = new Set(unlocks.map((u) => u.verdict.txid));
  const repayTxids = new Set(repayments.map((r) => r.repayment.txid));

  const detectedAs = (txid) => {
    if (defaultTxids.has(txid)) return 'loan-defaulted';
    if (origTxids.has(txid)) return 'loan-originated';
    if (unlockTxids.has(txid)) return 'loan-unlocked';
    if (repayTxids.has(txid)) return 'loan-repaid';
    return null;
  };

  let pass = 0;
  let fail = 0;
  console.log(`\n[loan-detector] VERIFY against ${known.transactions.length} known transactions:`);
  for (const kt of known.transactions) {
    const detected = detectedAs(kt.txid);
    const ok = detected === kt.expected_type;
    if (ok) pass++;
    else fail++;
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'} ${kt.expected_type.padEnd(16)} ` +
        `${kt.txid.slice(0, 16)}… #${kt.inscription_number}` +
        (ok ? '' : ` — got ${detected ?? 'not-detected'}`)
    );
  }
  console.log(`\n[loan-detector] VERIFY: pass=${pass} fail=${fail}`);
  if (fail > 0) {
    console.log(`[loan-detector] VERIFY: REGRESSION — ${fail} known transaction(s) misclassified`);
    process.exitCode = 2;
  } else {
    console.log(`[loan-detector] VERIFY: all known transactions matched expected types`);
  }
}

main().catch((e) => {
  console.error('[loan-detector] FATAL:', e);
  process.exit(1);
});
