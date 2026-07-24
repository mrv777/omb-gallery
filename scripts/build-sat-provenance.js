#!/usr/bin/env node
/* eslint-disable */
// Generates src/data/collections/omb/sat-provenance.json — the tiny baked file
// that lets the CLIENT-side gallery talk about sat provenance without shipping
// 9,001 sat numbers.
//
// WHY A FILE AND NOT THE DB: the gallery is fully "use client" and never
// touches SQLite. The three obvious alternatives were measured and rejected:
//   - adding `sat` to all 9,001 records in inscriptions.json → +~270 KB (+30%)
//     on a payload every visitor downloads, for a value that is IDENTICAL for
//     97.8% of the collection.
//   - an /api/traits route → a fetch waterfall for data that is immutable by
//     definition (OMB is a closed collection; sats never change).
// So we bake the *exceptions*: a per-color default block for the colors whose
// sats are uniform, plus every sat for the colors that aren't (today: red).
// ~5 KB.
//
// THE UNIFORMITY INVARIANT: that compression is only honest while green/orange/
// black really are all on block 9 and blue really is all on block 78. This
// script re-derives the defaults from the DB and cross-checks them against
// EXPECTED_UNIFORM below. On divergence it exits non-zero and writes nothing —
// regenerating is the only way to update the file, so the claim can't rot
// silently. tests/sat-provenance.test.ts guards the committed file from the
// other side.
//
// Host-side only (needs the prod DB + bitcoind), like the other backfill
// scripts — it is not part of the Docker image.
//
// Required env:
//   BITCOIN_RPC_URL   e.g. http://user:pass@127.0.0.1:8332   (for block times)
// Optional env:
//   OMB_DB_PATH       default ./tmp/dev.db
// Flags:
//   --stdout          print JSON to stdout instead of writing the file
//   --out <path>      override the output path
//   --stamp <date>    value for `generatedAt` (default: today, UTC).
//                     Pass the committed file's stamp to verify byte-identical
//                     regeneration.
//
// Max sat (~2.1e15) is well within Number.MAX_SAFE_INTEGER (9.007e15), so plain
// JS numbers are exact here — no BigInt needed (unlike backfill-transfers.js,
// which sums arbitrary tx outputs).

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { rpc } = require('./lib/chain');

const DB_PATH = process.env.OMB_DB_PATH ?? path.resolve(__dirname, '..', 'tmp', 'dev.db');
const COLLECTION = 'omb';

// The blocks we believe each color's sats were sourced from. Derived from the
// DB at generation time; this constant exists purely so a divergence is loud.
const EXPECTED_UNIFORM = { green: 9, orange: 9, black: 9, blue: 78 };
// Colors we expect to have individually-sourced sats (no single default).
const EXPECTED_VARIED = ['red'];

const HALVING_INTERVAL = 210_000;
const INITIAL_SUBSIDY = 5_000_000_000;

// Mirror of blockForSat() in src/lib/satProvenance.ts. Duplicated rather than
// imported because ops scripts are plain CJS and the lib is TS; the test suite
// asserts the two agree on the committed file.
function heightForSat(sat) {
  let subsidy = INITIAL_SUBSIDY;
  let epochStartSat = 0;
  let epochStartHeight = 0;
  while (subsidy > 0) {
    const epochSats = subsidy * HALVING_INTERVAL;
    if (sat < epochStartSat + epochSats) break;
    epochStartSat += epochSats;
    epochStartHeight += HALVING_INTERVAL;
    subsidy = Math.floor(subsidy / 2);
  }
  if (subsidy === 0) return null; // past the last subsidy epoch — not reachable for real sats
  return epochStartHeight + Math.floor((sat - epochStartSat) / subsidy);
}

function parseArgs(argv) {
  const out = { stdout: false, out: null, stamp: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stdout') out.stdout = true;
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--stamp') out.stamp = argv[++i];
    else {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const stamp = args.stamp ?? new Date().toISOString().slice(0, 10);

  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const rows = db
    .prepare(
      `SELECT inscription_number AS num, color, sat
         FROM inscriptions
        WHERE collection_slug = ? AND sat IS NOT NULL
        ORDER BY inscription_number`
    )
    .all(COLLECTION);
  const missing = db
    .prepare(`SELECT COUNT(*) AS n FROM inscriptions WHERE collection_slug = ? AND sat IS NULL`)
    .get(COLLECTION).n;
  db.close();

  if (rows.length === 0) {
    console.error('no OMB rows with a sat — is OMB_DB_PATH pointing at the right database?');
    process.exit(1);
  }
  if (missing > 0) {
    console.error(
      `${missing} OMB rows still have sat IS NULL. Run scripts/backfill-sats.js first —\n` +
        `a partial file would bake in defaults derived from an incomplete sample.`
    );
    process.exit(1);
  }

  // ---- derive per-color height sets -------------------------------------
  const heightsByColor = new Map(); // color -> Map<height, count>
  const heightByNum = new Map(); // num -> height
  for (const r of rows) {
    const h = heightForSat(r.sat);
    if (h == null) {
      console.error(`sat ${r.sat} (#${r.num}) is past the final subsidy epoch — refusing to guess`);
      process.exit(1);
    }
    heightByNum.set(r.num, h);
    if (!heightsByColor.has(r.color)) heightsByColor.set(r.color, new Map());
    const m = heightsByColor.get(r.color);
    m.set(h, (m.get(h) ?? 0) + 1);
  }

  const colorDefaults = {};
  const variedColors = [];
  for (const [color, m] of heightsByColor) {
    if (m.size === 1) colorDefaults[color] = [...m.keys()][0];
    else variedColors.push(color);
  }

  // ---- assert the invariant ---------------------------------------------
  const problems = [];
  for (const [color, expected] of Object.entries(EXPECTED_UNIFORM)) {
    const m = heightsByColor.get(color);
    if (!m) {
      problems.push(`expected color "${color}" to exist, but no rows have that color`);
      continue;
    }
    if (m.size !== 1) {
      const spread = [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([h, c]) => `${h}×${c}`)
        .join(', ');
      problems.push(
        `"${color}" was uniform on block ${expected}, now spans ${m.size} blocks (${spread}…)`
      );
      continue;
    }
    const actual = [...m.keys()][0];
    if (actual !== expected) {
      problems.push(`"${color}" was uniform on block ${expected}, now uniform on block ${actual}`);
    }
  }
  for (const color of EXPECTED_VARIED) {
    const m = heightsByColor.get(color);
    if (m && m.size === 1) {
      problems.push(
        `"${color}" was individually-sourced, now uniform on block ${[...m.keys()][0]} — ` +
          `the page's "only per-piece scarcity gradient" claim no longer holds`
      );
    }
  }
  for (const color of heightsByColor.keys()) {
    if (!(color in EXPECTED_UNIFORM) && !EXPECTED_VARIED.includes(color)) {
      problems.push(`unknown color "${color}" — add it to EXPECTED_UNIFORM or EXPECTED_VARIED`);
    }
  }
  if (problems.length > 0) {
    console.error('sat-provenance invariant failed; nothing written:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  // ---- explicit sats for the varied colors ------------------------------
  const sats = {};
  for (const r of rows) {
    if (variedColors.includes(r.color)) sats[r.num] = r.sat;
  }

  // ---- exact block times, from our own node -----------------------------
  // Only the distinct blocks OMB actually touches (~40), so mined-dates on the
  // page are exact rather than interpolated from a 10-minute average.
  const distinctHeights = [...new Set(heightByNum.values())].sort((a, b) => a - b);
  const blockTimes = {};
  for (const h of distinctHeights) {
    const hash = await rpc('getblockhash', [h]);
    const header = await rpc('getblockheader', [hash, true]);
    blockTimes[h] = header.time;
  }

  // ---- emit (deterministic key order) ------------------------------------
  const sortNum = (a, b) => Number(a) - Number(b);
  const doc = {
    generatedAt: stamp,
    source:
      'inscriptions.sat (scripts/backfill-sats.js) + bitcoind getblockheader; ' +
      'regenerate with scripts/build-sat-provenance.js',
    collection: COLLECTION,
    total: rows.length,
    colorDefaults: Object.fromEntries(
      Object.entries(colorDefaults).sort(([a], [b]) => (a < b ? -1 : 1))
    ),
    variedColors: variedColors.slice().sort(),
    sats: Object.fromEntries(
      Object.keys(sats)
        .sort(sortNum)
        .map(k => [k, sats[k]])
    ),
    blockTimes: Object.fromEntries(
      Object.keys(blockTimes)
        .sort(sortNum)
        .map(k => [k, blockTimes[k]])
    ),
  };

  const json = JSON.stringify(doc, null, 2) + '\n';
  if (args.stdout) {
    process.stdout.write(json);
  } else {
    const outPath =
      args.out ??
      path.resolve(
        __dirname,
        '..',
        'src',
        'data',
        'collections',
        COLLECTION,
        'sat-provenance.json'
      );
    fs.writeFileSync(outPath, json);
    console.error(
      `wrote ${outPath} — ${rows.length} inscriptions, ` +
        `${Object.keys(colorDefaults).length} uniform colors, ` +
        `${Object.keys(sats).length} explicit sats, ` +
        `${distinctHeights.length} blocks, ${(json.length / 1024).toFixed(1)} KB`
    );
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
