#!/usr/bin/env node
/* eslint-disable */
// research-loan-terms.js
//
// Read-only analysis of Liquidium loan term lengths inferred from on-chain
// data. Goal: figure out whether resolved-default loans cluster on a discrete
// menu of term lengths so we can show estimated expirations on currently
// active loans.
//
// What this does (NO writes):
//   1. Pulls all loan-defaulted and loan-originated events.
//   2. Joins them by escrow_addr (raw_json).
//   3. Decodes the on-chain timelock from each defaulted loan:
//        - Modern: raw_json.leaf_script_hex (CSV-gated 2-key leaf, BIP-112
//          relative timelock).
//        - Legacy v3 detector: raw_json.timelock_value + timelock_kind
//          (already parsed by loanDetect.ts).
//        - Legacy v1 detector: raw_json.csv_value (only the leaf-script hash
//          was stored; we can't decode without re-fetching the tx — flagged
//          as 'opaque' in the output so the operator knows what's missing).
//   4. Computes term length:
//        - block-relative CSV: blocks
//        - time-relative CSV (BIP-112 bit 22 set): seconds (units of 512s)
//        - absolute CLTV timestamp: (csv_timestamp - origination_block_time)
//        - absolute CLTV blocks: (csv_blocks - origination_block_height)
//   5. Histograms the terms (rounded to nearest day for time, nearest 144
//      blocks for blocks). Also breaks out by:
//        - source detector (legacy vs modern)
//        - lender vault address (top 10)
//        - principal-amount bucket (log-binned)
//   6. Prints a "current active loans" summary: count + per-color count + age
//      distribution, so the operator can see how many of these we'd be
//      estimating expirations for.
//
// Usage:
//   OMB_DB_PATH=tmp/prod.db node scripts/research-loan-terms.js
//   OMB_DB_PATH=/data/app.db node scripts/research-loan-terms.js   # on prod
//   OMB_DB_PATH=tmp/prod.db node scripts/research-loan-terms.js --json   # raw rows
//   OMB_DB_PATH=tmp/prod.db node scripts/research-loan-terms.js --csv > terms.csv
//
// Idempotent + read-only. Safe to run on prod against the live DB.

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.OMB_DB_PATH || path.resolve(__dirname, '..', 'tmp', 'prod.db');
const ARGS = new Set(process.argv.slice(2));
const EMIT_JSON = ARGS.has('--json');
const EMIT_CSV = ARGS.has('--csv');

// ---------- BIP-112 OP_CSV decoder ----------
// Per BIP-112: 32-bit field. Bit 31 (0x80000000) = disable. If not disabled:
//   Bit 22 (0x00400000) = 1 → time-based, units of 512 seconds.
//   Bit 22 = 0           → block-based, raw block count.
//   Lower 16 bits        = the magnitude.
function decodeCsv(value) {
  if (value & 0x80000000) return { disabled: true };
  const magnitude = value & 0x0000ffff;
  if (value & 0x00400000) {
    return { kind: 'time', seconds: magnitude * 512 };
  }
  return { kind: 'blocks', blocks: magnitude };
}

// Parse the modern Liquidium default leaf script (`<csv> b275 <pkA> ad <pkB> ac`).
// Returns the raw little-endian timelock value as a Number, or null.
function parseModernDefaultLeafCsv(scriptHex) {
  if (typeof scriptHex !== 'string' || scriptHex.length < 12) return null;
  const opByte = parseInt(scriptHex.slice(0, 2), 16);
  let dataLen, dataStart;
  if (opByte >= 0x01 && opByte <= 0x4b) {
    dataLen = opByte;
    dataStart = 2;
  } else if (opByte === 0x4c) {
    dataLen = parseInt(scriptHex.slice(2, 4), 16);
    dataStart = 4;
  } else if (opByte === 0x4d) {
    const lo = scriptHex.slice(2, 4);
    const hi = scriptHex.slice(4, 6);
    dataLen = parseInt(hi + lo, 16);
    dataStart = 6;
  } else return null;
  if (dataLen <= 0 || dataLen > 5) return null;
  const dataBytesEnd = dataStart + dataLen * 2;
  if (scriptHex.slice(dataBytesEnd, dataBytesEnd + 4).toLowerCase() !== 'b275') return null;
  let n = 0;
  for (let i = 0; i < dataLen; i++) {
    const b = parseInt(scriptHex.slice(dataStart + i * 2, dataStart + i * 2 + 2), 16);
    n += b * Math.pow(2, i * 8);
  }
  return n;
}

// Parse the legacy default leaf (`<timelock> b1|b2 75 20 <pubkey> ac`).
// Returns { value, opcode: 'CLTV'|'CSV' } or null.
function parseLegacyDefaultLeaf(scriptHex) {
  if (typeof scriptHex !== 'string' || scriptHex.length < 76) return null;
  const opByte = parseInt(scriptHex.slice(0, 2), 16);
  let dataLen, dataStart;
  if (opByte >= 0x01 && opByte <= 0x4b) { dataLen = opByte; dataStart = 2; }
  else if (opByte === 0x4c) { dataLen = parseInt(scriptHex.slice(2, 4), 16); dataStart = 4; }
  else if (opByte === 0x4d) {
    const lo = scriptHex.slice(2, 4);
    const hi = scriptHex.slice(4, 6);
    dataLen = parseInt(hi + lo, 16);
    dataStart = 6;
  } else return null;
  if (dataLen <= 0 || dataLen > 5) return null;
  const end = dataStart + dataLen * 2;
  const opcodeBytes = scriptHex.slice(end, end + 4).toLowerCase();
  let opcode;
  if (opcodeBytes === 'b175') opcode = 'CLTV';
  else if (opcodeBytes === 'b275') opcode = 'CSV';
  else return null;
  let n = 0;
  for (let i = 0; i < dataLen; i++) {
    const b = parseInt(scriptHex.slice(dataStart + i * 2, dataStart + i * 2 + 2), 16);
    n += b * Math.pow(2, i * 8);
  }
  return { value: n, opcode };
}

// Self-test: validate decoder against the modern test fixture (30 days).
function selfTest() {
  const FIXTURE_LEAF =
    '03c61340' + 'b275' + '20' +
    'a4c184aae8b4ccba9682b5ea95faf15ff2f82820fa1eb34aa5a13220fb366285' +
    'ad' + '20' +
    '94933588001ce9bace34f1b017055e6a9547a8241414d61e4e0f6045c8c77b75' + 'ac';
  const csv = parseModernDefaultLeafCsv(FIXTURE_LEAF);
  if (csv == null) throw new Error('selfTest: failed to parse modern leaf');
  const dec = decodeCsv(csv);
  if (dec.kind !== 'time' || dec.seconds !== 2_591_744) {
    throw new Error(`selfTest: expected time/2591744s (30d), got ${JSON.stringify(dec)}`);
  }
  if (Math.round(dec.seconds / 86400) !== 30) {
    throw new Error(`selfTest: expected 30d, got ${dec.seconds / 86400}d`);
  }
}

selfTest();

// ---------- Data extraction ----------
const db = new Database(DB_PATH, { readonly: true });

// All loan-originated events keyed by escrow_addr → meta.
const origRows = db.prepare(`
  SELECT
    e.id              AS event_id,
    e.inscription_number,
    e.txid            AS origination_txid,
    e.block_timestamp AS origination_ts,
    json_extract(e.raw_json,'$.escrow_addr')      AS escrow_addr,
    json_extract(e.raw_json,'$.lender_addr')      AS lender_addr,
    json_extract(e.raw_json,'$.borrower_addr')    AS borrower_addr,
    json_extract(e.raw_json,'$.loan_amount_sats') AS principal_sats,
    json_extract(e.raw_json,'$.match_kind')       AS match_kind,
    json_extract(e.raw_json,'$.source')           AS source,
    json_extract(e.raw_json,'$.confidence')       AS confidence,
    json_extract(e.raw_json,'$.detector_version') AS detector_version,
    i.color
  FROM events e
  JOIN inscriptions i USING (inscription_number)
  WHERE e.event_type = 'loan-originated'
`).all();

const origByEscrow = new Map();
for (const o of origRows) {
  if (o.escrow_addr) origByEscrow.set(o.escrow_addr, o);
}

// All loan-defaulted events.
const defaultRows = db.prepare(`
  SELECT
    e.id              AS event_id,
    e.inscription_number,
    e.txid            AS resolution_txid,
    e.block_timestamp AS resolution_ts,
    json_extract(e.raw_json,'$.escrow_addr')       AS escrow_addr,
    json_extract(e.raw_json,'$.lender_addr')       AS lender_addr,
    json_extract(e.raw_json,'$.timelock_value')    AS timelock_value_v3,
    json_extract(e.raw_json,'$.timelock_kind')     AS timelock_kind_v3,
    json_extract(e.raw_json,'$.timelock_opcode')   AS timelock_opcode_v3,
    json_extract(e.raw_json,'$.csv_value')         AS csv_value_v1,
    json_extract(e.raw_json,'$.leaf_script_hex')   AS leaf_script_hex_modern,
    json_extract(e.raw_json,'$.source')            AS source,
    json_extract(e.raw_json,'$.detector_version')  AS detector_version,
    i.color
  FROM events e
  JOIN inscriptions i USING (inscription_number)
  WHERE e.event_type = 'loan-defaulted'
`).all();

const repaidRows = db.prepare(`
  SELECT COUNT(*) AS c FROM events WHERE event_type = 'loan-repaid'
`).get();
const unlockedRows = db.prepare(`
  SELECT COUNT(*) AS c FROM events WHERE event_type = 'loan-unlocked'
`).get();

// ---------- Term inference ----------
const decoded = [];
let opaqueCount = 0;
let unmatchedOriginations = 0;

for (const d of defaultRows) {
  const orig = d.escrow_addr ? origByEscrow.get(d.escrow_addr) : null;
  const origTs = orig?.origination_ts ?? null;
  const principal = orig?.principal_sats ?? null;
  const lenderVault = orig?.lender_addr ?? d.lender_addr ?? null;

  if (!orig) unmatchedOriginations++;

  let termSeconds = null;
  let termBlocks = null;
  let termSource = null;
  let csvRaw = null;
  let opaque = false;

  // Path A: modern detector → leaf hex available, parse and decode CSV.
  if (d.leaf_script_hex_modern) {
    const csv = parseModernDefaultLeafCsv(d.leaf_script_hex_modern);
    if (csv != null) {
      csvRaw = csv;
      const dec = decodeCsv(csv);
      if (dec.kind === 'time') {
        termSeconds = dec.seconds;
        termSource = 'modern-csv-time';
      } else if (dec.kind === 'blocks') {
        termBlocks = dec.blocks;
        termSource = 'modern-csv-blocks';
      }
    }
  }

  // Path B: legacy v3 detector — already parsed.
  if (termSource == null && d.timelock_value_v3 != null) {
    const v = Number(d.timelock_value_v3);
    csvRaw = v;
    const opcode = d.timelock_opcode_v3;
    if (opcode === 'CSV') {
      const dec = decodeCsv(v);
      if (dec.kind === 'time') { termSeconds = dec.seconds; termSource = 'legacy-csv-time'; }
      else if (dec.kind === 'blocks') { termBlocks = dec.blocks; termSource = 'legacy-csv-blocks'; }
    } else if (opcode === 'CLTV') {
      // Absolute. Subtract origination timestamp to get the borrowed-for term.
      if (d.timelock_kind_v3 === 'timestamp' && origTs) {
        termSeconds = v - origTs;
        termSource = 'legacy-cltv-time';
      } else if (d.timelock_kind_v3 === 'blocks') {
        // No origination block height stored on event rows; would need bitcoind.
        opaque = true;
        termSource = 'legacy-cltv-blocks-no-height';
      }
    }
  }

  // Path C: legacy v1 detector — only the leaf hash was stored, not the
  // timelock bytes. Cannot decode without re-fetching the tx.
  if (termSource == null && d.csv_value_v1 && d.csv_value_v1.length === 64) {
    opaque = true;
    termSource = 'legacy-v1-opaque';
  }

  if (termSource == null) {
    opaque = true;
    termSource = 'no-fields';
  }

  if (opaque) opaqueCount++;

  decoded.push({
    inscription_number: d.inscription_number,
    color: d.color,
    origination_ts: origTs,
    resolution_ts: d.resolution_ts,
    escrow_addr: d.escrow_addr,
    lender_vault: lenderVault,
    principal_sats: principal,
    detector_version_default: d.detector_version,
    detector_version_origination: orig?.detector_version ?? null,
    csv_raw: csvRaw,
    term_source: termSource,
    term_seconds: termSeconds,
    term_blocks: termBlocks,
    term_days: termSeconds != null ? +(termSeconds / 86400).toFixed(2) : null,
    actual_held_seconds:
      origTs != null && d.resolution_ts != null ? d.resolution_ts - origTs : null,
    opaque,
  });
}

if (EMIT_JSON) {
  console.log(JSON.stringify({
    summary: {
      total_defaults: defaultRows.length,
      total_originations: origRows.length,
      total_repaids: repaidRows.c,
      total_unlocks: unlockedRows.c,
      decoded_with_term: decoded.filter(r => !r.opaque).length,
      opaque: opaqueCount,
      unmatched_originations: unmatchedOriginations,
    },
    rows: decoded,
  }, null, 2));
  process.exit(0);
}

if (EMIT_CSV) {
  const cols = [
    'inscription_number', 'color', 'origination_ts', 'resolution_ts',
    'lender_vault', 'principal_sats', 'csv_raw', 'term_source',
    'term_seconds', 'term_blocks', 'term_days', 'actual_held_seconds',
    'detector_version_default', 'detector_version_origination',
  ];
  console.log(cols.join(','));
  for (const r of decoded) {
    console.log(cols.map(c => {
      const v = r[c];
      if (v == null) return '';
      if (typeof v === 'string' && v.includes(',')) return `"${v}"`;
      return v;
    }).join(','));
  }
  process.exit(0);
}

// ---------- Pretty-printed analysis ----------
console.log(`\n=== Loan term research (DB: ${DB_PATH}) ===\n`);

console.log(`Lifecycle event counts:`);
console.log(`  loan-originated : ${origRows.length}`);
console.log(`  loan-defaulted  : ${defaultRows.length}`);
console.log(`  loan-repaid     : ${repaidRows.c}`);
console.log(`  loan-unlocked   : ${unlockedRows.c}`);

console.log(`\nDefault decoding sources:`);
const bySource = new Map();
for (const r of decoded) {
  bySource.set(r.term_source, (bySource.get(r.term_source) ?? 0) + 1);
}
for (const [src, n] of [...bySource.entries()].sort((a,b) => b[1] - a[1])) {
  console.log(`  ${src.padEnd(30)} ${n}`);
}

console.log(`\nUnmatched originations (defaulted but no origination event in DB): ${unmatchedOriginations}`);
console.log(`Opaque rows (term not decodable): ${opaqueCount}`);

// Histogram time-based terms in DAYS, rounded to nearest day.
const timeTerms = decoded.filter(r => r.term_seconds != null);
const timeBuckets = new Map();
for (const r of timeTerms) {
  const days = Math.round(r.term_seconds / 86400);
  timeBuckets.set(days, (timeBuckets.get(days) ?? 0) + 1);
}
console.log(`\nTime-based term distribution (days, rounded):`);
for (const [days, n] of [...timeBuckets.entries()].sort((a,b) => a[0] - b[0])) {
  const bar = '#'.repeat(Math.min(60, n));
  console.log(`  ${String(days).padStart(4)}d : ${String(n).padStart(4)}  ${bar}`);
}

// Histogram block-based terms (rounded to nearest 144 blocks ≈ 1 day).
const blockTerms = decoded.filter(r => r.term_blocks != null);
const blockBuckets = new Map();
for (const r of blockTerms) {
  const days = Math.round(r.term_blocks / 144);
  blockBuckets.set(days, (blockBuckets.get(days) ?? 0) + 1);
}
console.log(`\nBlock-based term distribution (days @ ~144 blk/day):`);
for (const [days, n] of [...blockBuckets.entries()].sort((a,b) => a[0] - b[0])) {
  const bar = '#'.repeat(Math.min(60, n));
  console.log(`  ${String(days).padStart(4)}d : ${String(n).padStart(4)}  ${bar}`);
}

// "Actual held" distribution — useful sanity check vs declared term.
const heldDays = decoded
  .filter(r => r.actual_held_seconds != null && r.term_seconds != null)
  .map(r => ({
    declared: Math.round(r.term_seconds / 86400),
    held:     Math.round(r.actual_held_seconds / 86400),
  }));
if (heldDays.length > 0) {
  console.log(`\nDeclared term vs actual hold time (defaults only):`);
  console.log(`  ${'declared'.padStart(8)} ${'min_held'.padStart(8)} ${'med_held'.padStart(8)} ${'max_held'.padStart(8)}  N`);
  const byDeclared = new Map();
  for (const h of heldDays) {
    if (!byDeclared.has(h.declared)) byDeclared.set(h.declared, []);
    byDeclared.get(h.declared).push(h.held);
  }
  for (const [decl, vals] of [...byDeclared.entries()].sort((a,b)=>a[0]-b[0])) {
    vals.sort((a,b) => a - b);
    const min = vals[0], max = vals[vals.length - 1], med = vals[Math.floor(vals.length / 2)];
    console.log(`  ${String(decl).padStart(7)}d ${String(min).padStart(7)}d ${String(med).padStart(7)}d ${String(max).padStart(7)}d  ${vals.length}`);
  }
}

// Per-lender-vault breakdown for time terms.
console.log(`\nTop lender vaults by default count (with term distribution):`);
const byVault = new Map();
for (const r of decoded) {
  if (!r.lender_vault) continue;
  if (!byVault.has(r.lender_vault)) byVault.set(r.lender_vault, []);
  byVault.get(r.lender_vault).push(r);
}
const ranked = [...byVault.entries()].sort((a,b) => b[1].length - a[1].length).slice(0, 10);
for (const [vault, rs] of ranked) {
  const termsList = rs
    .map(r => r.term_seconds != null ? Math.round(r.term_seconds / 86400) :
              r.term_blocks != null ? Math.round(r.term_blocks / 144) : null)
    .filter(t => t != null);
  const counts = new Map();
  for (const t of termsList) counts.set(t, (counts.get(t) ?? 0) + 1);
  const summary = [...counts.entries()].sort((a,b) => a[0] - b[0])
    .map(([t,n]) => `${t}d×${n}`).join('  ');
  console.log(`  ${vault.slice(0, 24)}…  N=${rs.length}  ${summary}`);
}

// Active loans summary.
const active = db.prepare(`
  SELECT
    i.inscription_number,
    i.color,
    i.active_loan_count,
    e.id           AS origination_event_id,
    e.txid         AS origination_txid,
    e.block_timestamp AS origination_ts,
    json_extract(e.raw_json,'$.escrow_addr')      AS escrow_addr,
    json_extract(e.raw_json,'$.lender_addr')      AS lender_vault,
    json_extract(e.raw_json,'$.loan_amount_sats') AS principal_sats
  FROM inscriptions i
  JOIN events e ON e.inscription_number = i.inscription_number
  WHERE i.active_loan_count > 0
    AND e.event_type = 'loan-originated'
    AND e.id = (
      SELECT MAX(e2.id) FROM events e2
      WHERE e2.inscription_number = i.inscription_number
        AND e2.event_type = 'loan-originated'
    )
`).all();

console.log(`\n=== Currently active loans ===`);
console.log(`Count: ${active.length}`);
const activeByColor = new Map();
for (const a of active) {
  activeByColor.set(a.color, (activeByColor.get(a.color) ?? 0) + 1);
}
console.log(`By color: ${[...activeByColor.entries()].map(([c,n]) => `${c}×${n}`).join(', ')}`);

const now = Math.floor(Date.now() / 1000);
const ageDays = active
  .filter(a => a.origination_ts != null)
  .map(a => Math.round((now - a.origination_ts) / 86400));
ageDays.sort((a,b) => a - b);
if (ageDays.length > 0) {
  const min = ageDays[0], max = ageDays[ageDays.length - 1];
  const med = ageDays[Math.floor(ageDays.length / 2)];
  console.log(`Origination age (days): min=${min} median=${med} max=${max}`);
}

// How many active loans share a lender vault that we have term data for?
const vaultsWithTerms = new Set(
  [...byVault.entries()].filter(([_, rs]) => rs.some(r => !r.opaque)).map(([v,_]) => v)
);
const activeWithKnownVault = active.filter(a => vaultsWithTerms.has(a.lender_vault)).length;
console.log(`Active loans whose lender vault has at least one decoded historical term: ${activeWithKnownVault}/${active.length}`);

console.log(`\n(Tip: re-run with --csv to export per-row data, --json for machine-readable summary.)`);
