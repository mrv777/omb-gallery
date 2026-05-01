#!/usr/bin/env node
/* eslint-disable */
// Heuristic on-chain sale detection.
//
// Inspects each `events` row with event_type='transferred' and re-classifies
// it as `sold` when the underlying tx carries the PSBT marketplace signature
// shape: the seller's inscription input has a witness signature with the
// SIGHASH_ANYONECANPAY (0x80) bit set — i.e. one of {0x81, 0x82, 0x83}.
//
// Why: Satflow's API only sees Satflow fills; ord.net's republished history is
// incomplete (e.g. inscription #213924's 2.9 BTC sale is missing). But every
// marketplace sale leaves a fully-determined fingerprint on-chain, so we can
// rebuild the missing labels from raw txs without a third-party feed.
//
// Required env:
//   BITCOIN_RPC_URL    e.g. http://user:<password>@127.0.0.1:8332
// Optional env:
//   OMB_DB_PATH                  default ./tmp/dev.db
//   ONCHAIN_HEUR_CONCURRENCY     default 8
//
// CLI flags:
//   --dry-run                    Don't write to the DB. Logs candidates only.
//   --inscription-number=N       Restrict to one inscription (smoke test).
//   --since=<unix>               Only look at events with block_timestamp >= unix.
//   --until=<unix>               Only look at events with block_timestamp <= unix.
//   --max-events=N               Safety cap on the work set.
//   --verbose                    Per-event debug logs (otherwise only summary +
//                                upgraded txids).
//
// Run AFTER backfill-transfers.js (which populates the `transferred` rows this
// script operates on). Idempotent: re-running is a no-op once rows are flipped
// to `sold` (the WHERE filter excludes them).
//
// Notes on safety:
//   - Backfill paths NEVER enqueue notify_pending. Upgrading thousands of rows
//     here would otherwise spam every firehose subscriber with historical
//     events. This script does not touch notify_pending.
//   - Upgrades flip the row's event_type but leave events.id stable, so the
//     activity feed ordering is undisturbed.
//   - inscriptions aggregates (transfer_count / sale_count / total_volume_sats
//     / highest_sale_sats) shift; explorer leaderboards reshuffle on next read.

const path = require('node:path');
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
const CONCURRENCY = parseInt(process.env.ONCHAIN_HEUR_CONCURRENCY ?? '8', 10);
const REQUEST_TIMEOUT_MS = 30_000;
const BATCH_SIZE = 200;
const DETECTOR_VERSION = 1;

const ARGS = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = {
    dryRun: false,
    inscriptionNumber: null,
    since: null,
    until: null,
    maxEvents: null,
    verbose: false,
    auditSold: false,
  };
  for (const a of argv) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--audit-sold') {
      // Cross-source validation mode: include `sold` rows in the work set and
      // compare the heuristic's classification against existing sale_price_sats.
      // Forces dry-run — never writes. Used to verify the detector recognizes
      // known-good sales before trusting it on `transferred` rows.
      out.auditSold = true;
      out.dryRun = true;
    } else if (a.startsWith('--inscription-number=')) {
      const n = parseInt(a.slice('--inscription-number='.length), 10);
      if (Number.isFinite(n)) out.inscriptionNumber = n;
    } else if (a.startsWith('--since=')) out.since = parseInt(a.slice('--since='.length), 10);
    else if (a.startsWith('--until=')) out.until = parseInt(a.slice('--until='.length), 10);
    else if (a.startsWith('--max-events='))
      out.maxEvents = parseInt(a.slice('--max-events='.length), 10);
    else {
      console.error(`[onchain-heuristic] unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

if (!RPC_URL) {
  console.error('[onchain-heuristic] BITCOIN_RPC_URL is required');
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

// ---------------- sighash detection ----------------
//
// SIGHASH flags we treat as "marketplace PSBT" — anything with the
// ANYONECANPAY bit (0x80) set:
//   0x81 = ALL    | ANYONECANPAY
//   0x82 = NONE   | ANYONECANPAY
//   0x83 = SINGLE | ANYONECANPAY  (the canonical Magic Eden / OKX / Magisat /
//                                  Satflow ordinal-listing flag)
function isAcpFlag(b) {
  return b === 0x81 || b === 0x82 || b === 0x83;
}

// Extract candidate sighash bytes from a witness stack + scriptSig hex.
// Returns an array of {flag, source}. source is one of 'taproot65',
// 'ecdsa-witness', 'ecdsa-scriptsig'. We deliberately ignore taproot 64-byte
// signatures (SIGHASH_DEFAULT) because they carry no explicit flag and
// reading their last data byte as a flag would false-positive on every
// modern wallet move.
function extractSighashCandidates(witnessHex, scriptSigHex) {
  const out = [];
  if (Array.isArray(witnessHex)) {
    // Identify a taproot script-path witness so we can skip the trailing
    // [script, control_block] entries when scanning for signatures. Heuristic:
    // last item is 33 + 32k bytes long and begins with 0xc0 or 0xc1.
    let scanLen = witnessHex.length;
    if (witnessHex.length >= 2) {
      const last = witnessHex[witnessHex.length - 1];
      if (typeof last === 'string' && last.length >= 66 && (last.length - 66) % 64 === 0) {
        const firstByte = parseInt(last.slice(0, 2), 16);
        if (firstByte === 0xc0 || firstByte === 0xc1) {
          scanLen = witnessHex.length - 2; // peel off control block + script
        }
      }
    }
    for (let i = 0; i < scanLen; i++) {
      const item = witnessHex[i];
      if (typeof item !== 'string' || item.length === 0 || item.length % 2 !== 0) continue;
      const byteLen = item.length / 2;

      // Taproot schnorr with explicit sighash byte.
      if (byteLen === 65) {
        const flag = parseInt(item.slice(128, 130), 16);
        out.push({ flag, source: 'taproot65' });
        continue;
      }
      // 64-byte schnorr = SIGHASH_DEFAULT (= ALL semantically). Skip — no flag.
      if (byteLen === 64) continue;

      // ECDSA DER: 0x30 LL 0x02 RR <r> 0x02 SS <s> [sighash]
      // Total bytes = LL + 3 (DER + sighash byte). Validate structure before
      // trusting the trailing byte — random data starting with 0x30 must not
      // false-positive.
      if (byteLen >= 9 && byteLen <= 73) {
        const flag = derSighashByte(item);
        if (flag != null) out.push({ flag, source: 'ecdsa-witness' });
      }
    }
  }
  // ScriptSig pushes (legacy p2pkh / wrapped p2sh signatures live here too).
  // Parse minimal bitcoin-script push opcodes; for each push extract the data
  // and run the DER probe.
  if (typeof scriptSigHex === 'string' && scriptSigHex.length > 0) {
    for (const push of iterateScriptPushes(scriptSigHex)) {
      const flag = derSighashByte(push);
      if (flag != null) out.push({ flag, source: 'ecdsa-scriptsig' });
    }
  }
  return out;
}

// Validate that `hex` is a DER-encoded ECDSA signature with a trailing sighash
// byte. Returns the sighash byte on match, null otherwise.
function derSighashByte(hex) {
  const totalBytes = hex.length / 2;
  if (totalBytes < 9 || totalBytes > 73) return null;
  if (hex.slice(0, 2) !== '30') return null;
  const declaredLen = parseInt(hex.slice(2, 4), 16); // length of DER body
  if (declaredLen + 3 !== totalBytes) return null;
  if (hex.slice(4, 6) !== '02') return null;
  const rLen = parseInt(hex.slice(6, 8), 16);
  if (rLen <= 0 || rLen > 33) return null;
  const sMarkerOff = 8 + rLen * 2;
  if (sMarkerOff + 4 > hex.length) return null;
  if (hex.slice(sMarkerOff, sMarkerOff + 2) !== '02') return null;
  const sLen = parseInt(hex.slice(sMarkerOff + 2, sMarkerOff + 4), 16);
  if (sLen <= 0 || sLen > 33) return null;
  // 6 bytes of header (0x30 LL 0x02 RR + 0x02 SS) + rLen + sLen + 1 sighash
  if (6 + rLen + sLen + 1 !== totalBytes) return null;
  const sighashOff = (totalBytes - 1) * 2;
  return parseInt(hex.slice(sighashOff, sighashOff + 2), 16);
}

// Yields each data push in a scriptSig, decoded to hex. Handles the standard
// bitcoin-script push opcodes (0x01..0x4b, OP_PUSHDATA1/2/4). Non-push opcodes
// are silently skipped — we're only fishing for signature bytes.
function* iterateScriptPushes(hex) {
  let i = 0;
  while (i < hex.length) {
    const op = parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(op)) return;
    i += 2;
    let dataLen = 0;
    if (op >= 0x01 && op <= 0x4b) {
      dataLen = op;
    } else if (op === 0x4c) {
      if (i + 2 > hex.length) return;
      dataLen = parseInt(hex.slice(i, i + 2), 16);
      i += 2;
    } else if (op === 0x4d) {
      if (i + 4 > hex.length) return;
      dataLen = parseInt(hex.slice(i + 2, i + 4) + hex.slice(i, i + 2), 16); // LE
      i += 4;
    } else if (op === 0x4e) {
      if (i + 8 > hex.length) return;
      const b0 = hex.slice(i, i + 2);
      const b1 = hex.slice(i + 2, i + 4);
      const b2 = hex.slice(i + 4, i + 6);
      const b3 = hex.slice(i + 6, i + 8);
      dataLen = parseInt(b3 + b2 + b1 + b0, 16);
      i += 8;
    } else {
      // Non-push opcode (OP_0..OP_16, OP_DUP, etc) — no data bytes.
      continue;
    }
    if (dataLen <= 0 || i + dataLen * 2 > hex.length) return;
    yield hex.slice(i, i + dataLen * 2);
    i += dataLen * 2;
  }
}

// ---------------- classification ----------------

// Marketplace listings on Bitcoin ordinals (ME, OKX, Magisat, Satflow) commit
// the seller's input with SIGHASH_SINGLE | ANYONECANPAY (0x83), which binds
// vout[carryIdx] as the seller's payment. We identify the seller's input by
// scanning all inputs for an ACP-flagged signature and matching the input's
// prevout address against `event.old_owner` (the inscription's previous
// holder, populated by the chain walker / live diff-poller). This sidesteps
// the satpoint-offset ambiguity that breaks `txid:vout` two-part satpoints.
//
// Sellers commonly route the payout to a different address than their
// inscription-holding wallet (e.g. P2SH payout vs P2TR holding for ME), so
// vout[carryIdx]'s recipient is NOT compared to old_owner. Instead the
// recipient must NOT equal `event.new_owner` (don't pay the buyer) and the
// payment must clear a dust floor.
const MIN_SALE_PRICE_SATS = 10_000; // 0.0001 BTC; below this is padding/dust

// Returns a classification object for one event:
//   { kind: 'sale', flag, sigSource, carryIdx, sellerAddr, salePriceSats }
//   { kind: 'skip', reason: <string> }
async function classifyEvent(event) {
  let tx;
  try {
    tx = await rpc('getrawtransaction', [event.txid, 2]);
  } catch (e) {
    return { kind: 'skip', reason: `rpc-fail:${e.message.slice(0, 80)}` };
  }
  if (!tx || !Array.isArray(tx.vin) || !Array.isArray(tx.vout)) {
    return { kind: 'skip', reason: 'bad-tx' };
  }
  if (tx.vin.some(v => v && v.coinbase)) {
    return { kind: 'skip', reason: 'coinbase' };
  }

  // Find all inputs with at least one ACP-flagged signature.
  const acpInputs = [];
  for (let i = 0; i < tx.vin.length; i++) {
    const vin = tx.vin[i];
    if (!vin) continue;
    const cands = extractSighashCandidates(vin.txinwitness, vin.scriptSig?.hex);
    const acp = cands.find(c => isAcpFlag(c.flag));
    if (!acp) continue;
    const prevAddr = addressFromScriptPubKey(vin.prevout?.scriptPubKey);
    acpInputs.push({ idx: i, flag: acp.flag, source: acp.source, prevAddr });
  }
  if (acpInputs.length === 0) return { kind: 'skip', reason: 'no-acp-sighash' };

  // Identify the seller's input. Strong path: match prevAddr to old_owner.
  // Fallback: if the tx has exactly one ACP-signed input, accept it (single-
  // listing case where old_owner may be null or in a non-comparable format).
  let match = null;
  if (event.old_owner) {
    match = acpInputs.find(a => a.prevAddr === event.old_owner) ?? null;
  }
  if (!match) {
    if (acpInputs.length === 1) match = acpInputs[0];
    else return { kind: 'skip', reason: 'no-matching-acp-input' };
  }

  const paymentVout = tx.vout[match.idx];
  if (!paymentVout) return { kind: 'skip', reason: 'no-payment-vout' };
  const sellerAddr = addressFromScriptPubKey(paymentVout.scriptPubKey);
  if (!sellerAddr) return { kind: 'skip', reason: 'unparseable-payment-spk' };

  if (event.new_owner && sellerAddr === event.new_owner) {
    return { kind: 'skip', reason: 'pays-buyer' };
  }

  const salePriceSats = Number(btcToSats(paymentVout.value));
  if (salePriceSats < MIN_SALE_PRICE_SATS) {
    return { kind: 'skip', reason: `dust-payment (${salePriceSats} sats)` };
  }

  return {
    kind: 'sale',
    flag: match.flag,
    sigSource: match.source,
    carryIdx: match.idx,
    sellerAddr,
    salePriceSats,
  };
}

// ---------------- main ----------------

async function main() {
  const db = new Database(DB_PATH, { readonly: ARGS.dryRun });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  // Fail-fast probe so a bad RPC URL surfaces at the top.
  try {
    const info = await rpc('getblockchaininfo', []);
    console.log(`[onchain-heuristic] bitcoind ok: blocks=${info.blocks} chain=${info.chain}`);
  } catch (e) {
    console.error('[onchain-heuristic] bitcoind RPC failed:', e.message);
    process.exit(1);
  }

  // ---- prepared statements (mirrors scripts/backfill-ordnet-sales.js) ----

  const upgradeToSold = db.prepare(`
    UPDATE events
       SET event_type      = 'sold',
           sale_price_sats = @sale_price_sats,
           marketplace     = NULL,
           raw_json        = @raw_json
     WHERE inscription_id = @inscription_id
       AND txid           = @txid
       AND event_type     = 'transferred'
  `);
  // MAX(... , 0) clamp: protect against re-runs over a repaired DB driving the
  // counter negative (matches backfill-ordnet-sales.js:325).
  const unbumpTransferOnUpgrade = db.prepare(`
    UPDATE inscriptions SET
      transfer_count    = MAX(transfer_count - 1, 0),
      sale_count        = sale_count + 1,
      total_volume_sats = total_volume_sats + COALESCE(@sale_price_sats, 0),
      highest_sale_sats = MAX(highest_sale_sats, COALESCE(@sale_price_sats, 0))
    WHERE inscription_number = @inscription_number
  `);

  const flushBatch = db.transaction(rows => {
    let upgraded = 0;
    for (const r of rows) {
      const u = upgradeToSold.run({
        inscription_id: r.inscription_id,
        txid: r.txid,
        sale_price_sats: r.sale_price_sats,
        raw_json: r.raw_json,
      });
      if (u.changes > 0) {
        upgraded++;
        unbumpTransferOnUpgrade.run({
          inscription_number: r.inscription_number,
          sale_price_sats: r.sale_price_sats,
        });
      }
    }
    return { upgraded };
  });

  // ---- target selection ----

  const where = ['e.txid IS NOT NULL'];
  if (ARGS.auditSold) {
    where.push("e.event_type IN ('transferred','sold')");
  } else {
    where.push("e.event_type = 'transferred'");
  }
  const params = {};
  if (ARGS.inscriptionNumber != null) {
    where.push('e.inscription_number = @num');
    params.num = ARGS.inscriptionNumber;
  }
  if (ARGS.since != null) {
    where.push('e.block_timestamp >= @since');
    params.since = ARGS.since;
  }
  if (ARGS.until != null) {
    where.push('e.block_timestamp <= @until');
    params.until = ARGS.until;
  }
  // In audit mode pull `event_type` and existing `sale_price_sats` so the
  // worker can compare heuristic vs DB price; ORDER RANDOM so the sample is
  // representative of the full corpus rather than time-skewed.
  let sql = `
    SELECT e.id, e.inscription_id, e.inscription_number, e.txid,
           e.new_satpoint, e.old_owner, e.new_owner, e.block_timestamp,
           e.event_type, e.sale_price_sats
      FROM events e
     WHERE ${where.join(' AND ')}
     ORDER BY ${ARGS.auditSold ? 'RANDOM()' : 'e.block_timestamp DESC, e.id DESC'}
  `;
  if (ARGS.maxEvents != null) sql += ` LIMIT ${ARGS.maxEvents}`;
  const targets = db.prepare(sql).all(params);

  console.log(
    `[onchain-heuristic] db=${DB_PATH} dryRun=${ARGS.dryRun} concurrency=${CONCURRENCY} ` +
      `targets=${targets.length} ` +
      (ARGS.auditSold ? '(AUDIT MODE — transferred+sold)' : '(transferred-only)')
  );
  if (targets.length === 0) {
    console.log('[onchain-heuristic] nothing to do');
    db.close();
    return;
  }

  // ---- concurrent classifier + batched writer ----

  let next = 0;
  let processed = 0;
  let detected = 0;
  let upgradedTotal = 0;
  let errors = 0;
  const reasons = Object.create(null);
  const startedAt = Date.now();
  let pendingBatch = [];

  // Audit-mode counters: agreement between heuristic and existing DB sales.
  let auditAgree = 0;
  let auditPriceMismatch = 0;
  let auditMissedSale = 0; // detector skipped a row that DB already has as 'sold'
  let auditFalseFlag = 0; // detector flagged a row DB has as 'transferred'
  const auditDeltaSamples = [];

  function flushPending() {
    if (pendingBatch.length === 0) return;
    if (ARGS.dryRun) {
      pendingBatch = [];
      return;
    }
    // .immediate() forces BEGIN IMMEDIATE so SELECT-then-UPDATE can't race the
    // live diff-poll cron writing to the same DB.
    const r = flushBatch.immediate(pendingBatch);
    upgradedTotal += r.upgraded;
    pendingBatch = [];
  }

  async function worker() {
    while (next < targets.length) {
      const i = next++;
      const ev = targets[i];
      try {
        const verdict = await classifyEvent(ev);
        if (ARGS.auditSold) {
          // Audit mode: compare verdict against the row's existing event_type.
          if (ev.event_type === 'sold') {
            if (verdict.kind === 'sale') {
              const dbPrice = ev.sale_price_sats ?? 0;
              const delta = verdict.salePriceSats - dbPrice;
              if (Math.abs(delta) <= 1) auditAgree++;
              else {
                auditPriceMismatch++;
                if (auditDeltaSamples.length < 10) {
                  auditDeltaSamples.push({
                    n: ev.inscription_number,
                    txid: ev.txid.slice(0, 16),
                    heur: verdict.salePriceSats,
                    db: dbPrice,
                    delta,
                  });
                }
              }
            } else {
              auditMissedSale++;
              reasons[`miss:${verdict.reason}`] = (reasons[`miss:${verdict.reason}`] ?? 0) + 1;
            }
          } else if (verdict.kind === 'sale') {
            auditFalseFlag++;
          } else {
            reasons[`xfer-skip:${verdict.reason}`] =
              (reasons[`xfer-skip:${verdict.reason}`] ?? 0) + 1;
          }
          processed++;
          continue;
        }
        if (verdict.kind === 'sale') {
          detected++;
          const rawJson = JSON.stringify({
            source: 'onchain-heuristic',
            sighash: '0x' + verdict.flag.toString(16).padStart(2, '0'),
            sig_source: verdict.sigSource,
            carry_idx: verdict.carryIdx,
            seller_payout_addr: verdict.sellerAddr,
            inscription_holder_addr: ev.old_owner,
            buyer_addr: ev.new_owner,
            price_sats: verdict.salePriceSats,
            detector_version: DETECTOR_VERSION,
          });
          if (ARGS.verbose || detected <= 20) {
            console.log(
              `[onchain-heuristic] SALE #${ev.inscription_number} txid=${ev.txid.slice(0, 16)}… ` +
                `sighash=0x${verdict.flag.toString(16)} carry=${verdict.carryIdx} ` +
                `price=${verdict.salePriceSats} sats (${(verdict.salePriceSats / 1e8).toFixed(4)} BTC)`
            );
          }
          pendingBatch.push({
            inscription_id: ev.inscription_id,
            inscription_number: ev.inscription_number,
            txid: ev.txid,
            sale_price_sats: verdict.salePriceSats,
            raw_json: rawJson,
          });
          if (pendingBatch.length >= BATCH_SIZE) flushPending();
        } else {
          reasons[verdict.reason] = (reasons[verdict.reason] ?? 0) + 1;
          if (ARGS.verbose) {
            console.log(
              `[onchain-heuristic] skip #${ev.inscription_number} txid=${ev.txid.slice(0, 16)}… reason=${verdict.reason}`
            );
          }
        }
      } catch (e) {
        errors++;
        if (errors <= 5) {
          console.error(
            `[onchain-heuristic] event id=${ev.id} #${ev.inscription_number}:`,
            e.message
          );
        }
      }
      processed++;
      if (processed % 200 === 0) {
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = processed / elapsed;
        const eta = Math.round((targets.length - processed) / rate);
        console.log(
          `[onchain-heuristic] ${processed}/${targets.length} ` +
            `detected=${detected} upgraded=${upgradedTotal} err=${errors} ` +
            `${rate.toFixed(1)}/s eta=${eta}s`
        );
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  flushPending();

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (ARGS.auditSold) {
    const totalSold = auditAgree + auditPriceMismatch + auditMissedSale;
    const totalXfer = processed - totalSold;
    console.log(
      `[onchain-heuristic] AUDIT DONE in ${elapsed}s — sold-rows=${totalSold} xfer-rows=${totalXfer}`
    );
    console.log(
      `  on existing 'sold' rows:   agree=${auditAgree}  price-mismatch=${auditPriceMismatch}  missed=${auditMissedSale}`
    );
    console.log(
      `  on existing 'transferred': would-flip-to-sold=${auditFalseFlag}  left-alone=${totalXfer - auditFalseFlag}`
    );
    if (auditDeltaSamples.length) {
      console.log('  price-mismatch samples:');
      for (const d of auditDeltaSamples) console.log('   ', d);
    }
    console.log('[onchain-heuristic] skip-reason histogram:', reasons);
  } else {
    console.log(
      `[onchain-heuristic] DONE in ${elapsed}s — ` +
        `processed=${processed} detected=${detected} upgraded=${upgradedTotal} err=${errors}` +
        (ARGS.dryRun ? ' (DRY RUN — no writes)' : '')
    );
    console.log('[onchain-heuristic] skip reasons:', reasons);
  }

  db.close();
}

main().catch(e => {
  console.error('[onchain-heuristic] FATAL:', e);
  process.exit(1);
});
