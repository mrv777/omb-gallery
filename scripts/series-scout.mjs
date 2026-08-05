#!/usr/bin/env node
/* eslint-disable */
// Curation tool for the named sub-series in src/lib/series.ts.
//
// READ-ONLY. Prints to stdout and writes nothing, ever. Series membership is
// hand-curated and belongs in a diff a human reviewed — this tool finds
// candidates and formats them for pasting, it does not edit the catalogue.
// (Deliberately not an extension of scripts/update-descriptions.js, which
// writes into the 888 KB inscriptions.json.)
//
// .mjs rather than .js because it imports src/lib/series.ts directly via
// Node's type stripping, so the member lists have exactly one source of truth.
//
// Usage:
//   pnpm series-scout --seed pirate
//   pnpm series-scout --series fuck-you-sketch            # uses that set's own seed
//   pnpm series-scout --series fuck-you-sketch --missing  # which of 1..50 are unclaimed
//   pnpm series-scout --series pirates --diff             # seed hits not in members, and vice versa
//   pnpm series-scout --series pirates --band 83296231-83314539
//
// The --band output is the point of the tool: it prints a /slideshow?ids= link
// covering everything in the band that ISN'T already a member, so reviewing a
// 300-piece stretch is a two-minute slideshow instead of a scroll-and-squint
// session in the grid.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const { SERIES, getSeries } = await import(resolve(ROOT, 'src/lib/series.ts'));
const { encodeIds } = await import(resolve(ROOT, 'src/lib/slideshowCodec.ts'));

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://ordinalmaxibiz.wiki';
/** Slideshow URLs stay well under browser limits; past this we print a count instead. */
const MAX_SLIDESHOW_IDS = 500;

// ---------------------------------------------------------------- load data

function loadInscriptions() {
  const raw = JSON.parse(
    readFileSync(resolve(ROOT, 'src/data/collections/omb/inscriptions.json'), 'utf8')
  );
  const out = [];
  for (const color of Object.keys(raw)) {
    for (const r of raw[color]) {
      out.push({
        number: parseInt(r.filename, 10),
        color,
        description: r.description ?? '',
        tags: r.tags ?? [],
      });
    }
  }
  return out.sort((a, b) => a.number - b.number);
}

function matches(rec, seed) {
  const re = new RegExp(seed.pattern, 'i');
  if (seed.in.includes('description') && re.test(rec.description)) return true;
  // One record stores both tags in a single comma-joined string ("Optimus, Tesla"),
  // so match against the raw tag text rather than requiring an exact element.
  if (seed.in.includes('tags') && rec.tags.some(t => re.test(t))) return true;
  return false;
}

// ---------------------------------------------------------------- output

function printHits(label, hits) {
  console.log(`\n${label} — ${hits.length} ${hits.length === 1 ? 'hit' : 'hits'}`);
  if (hits.length === 0) return;
  for (const h of hits) {
    console.log(
      `  ${String(h.number).padEnd(10)} ${h.color.padEnd(7)} ${h.description.slice(0, 88) || '(no description)'}`
    );
  }
  const nums = hits.map(h => h.number);
  console.log(`  band: #${nums[0]} – #${nums[nums.length - 1]}`);
}

function printDensity(hits, all) {
  if (hits.length < 2) return;
  // Bucket by position in the collection-sorted order, not by raw inscription
  // number — the numbers jump by millions between drops, which makes raw-number
  // buckets useless for spotting a cluster.
  const index = new Map(all.map((r, i) => [r.number, i]));
  const positions = hits.map(h => index.get(h.number)).sort((a, b) => a - b);
  const lo = positions[0];
  const hi = positions[positions.length - 1];
  const BUCKETS = 20;
  const span = Math.max(1, hi - lo);
  const counts = new Array(BUCKETS).fill(0);
  for (const p of positions) {
    counts[Math.min(BUCKETS - 1, Math.floor(((p - lo) / span) * BUCKETS))]++;
  }
  const max = Math.max(...counts);
  console.log(`\n  density across collection positions ${lo}–${hi}:`);
  console.log(
    '  ' +
      counts.map(c => (c === 0 ? '·' : '▁▂▃▄▅▆▇█'[Math.min(7, Math.round((c / max) * 7))])).join('')
  );
}

function printMembersArray(nums) {
  console.log(`\n  paste-ready members (${nums.length}):`);
  const sorted = [...nums].sort((a, b) => a - b);
  const lines = [];
  for (let i = 0; i < sorted.length; i += 9)
    lines.push('      ' + sorted.slice(i, i + 9).join(', ') + ',');
  console.log('    members: [');
  console.log(lines.join('\n'));
  console.log('    ],');
}

function printSlideshow(label, nums) {
  if (nums.length === 0) return;
  if (nums.length > MAX_SLIDESHOW_IDS) {
    console.log(
      `\n  ${label}: ${nums.length} pieces — too many for one slideshow link, narrow the band with --band`
    );
    return;
  }
  const encoded = encodeIds(nums.map(String));
  console.log(`\n  ${label} (${nums.length} pieces):`);
  console.log(`  ${SITE}/slideshow?ids=${encoded}`);
}

// ---------------------------------------------------------------- commands

function cmdSeed(all, seed, label, existing) {
  const hits = all.filter(r => matches(r, seed));
  printHits(`seed /${seed.pattern}/i in ${seed.in.join('+')} — ${label}`, hits);
  printDensity(hits, all);
  printMembersArray(hits.map(h => h.number));
  const fresh = hits.map(h => h.number).filter(n => !existing.has(n));
  if (existing.size > 0) {
    console.log(`\n  ${fresh.length} of these are NOT yet in the catalogue.`);
    printSlideshow('review the new ones', fresh);
  } else {
    printSlideshow(
      'review all hits',
      hits.map(h => h.number)
    );
  }
}

function cmdMissing(series) {
  if (series.declaredSize == null) {
    console.log(
      `\n"${series.label}" is open-ended (declaredSize: null) — there is no known denominator, so` +
        ` nothing to enumerate as missing. Use --band to sweep for more.`
    );
    return;
  }
  const claimed = new Set(Object.values(series.memberIndex ?? {}));
  const missing = [];
  for (let i = 1; i <= series.declaredSize; i++) if (!claimed.has(i)) missing.push(i);
  console.log(
    `\n${series.label}: ${claimed.size} of ${series.declaredSize} catalogued, ${missing.length} unclaimed`
  );
  console.log(`  missing indices: ${missing.join(', ')}`);
  const nums = [...series.members].sort((a, b) => a - b);
  if (nums.length > 0) {
    console.log(`\n  known members span #${nums[0]} – #${nums[nums.length - 1]}`);
    console.log(
      `  try:  pnpm series-scout --series ${series.slug} --band ${nums[0]}-${nums[nums.length - 1]}`
    );
  }
}

function cmdDiff(all, series) {
  if (!series.seed) {
    console.log(
      `\n${series.label} has no catalogue-metadata seed — membership came from a maintainer-supplied list.`
    );
    return;
  }
  const members = new Set(series.members);
  const hits = all.filter(r => matches(r, series.seed));
  const hitNums = new Set(hits.map(h => h.number));

  const unlisted = hits.filter(h => !members.has(h.number));
  const unmatched = all.filter(r => members.has(r.number) && !hitNums.has(r.number));

  console.log(`\n${series.label} — diff against seed /${series.seed.pattern}/i`);
  if (unlisted.length === 0 && unmatched.length === 0) {
    console.log('  clean: every seed hit is a member, and every member still matches the seed.');
    return;
  }
  if (unlisted.length > 0) {
    console.log(
      `\n  ${unlisted.length} seed hit(s) NOT in members — new descriptions, or a missed paste:`
    );
    for (const h of unlisted) console.log(`    ${h.number}  ${h.description.slice(0, 80)}`);
    printSlideshow(
      'review',
      unlisted.map(h => h.number)
    );
  }
  if (unmatched.length > 0) {
    console.log(
      `\n  ${unmatched.length} member(s) whose description no longer matches the seed — fine if they` +
        ` were added by eye, suspicious if not:`
    );
    for (const r of unmatched)
      console.log(`    ${r.number}  ${r.description.slice(0, 80) || '(no description)'}`);
  }
}

function cmdBand(all, series, from, to) {
  const members = new Set(series?.members ?? []);
  const inBand = all.filter(r => r.number >= from && r.number <= to);
  const candidates = inBand.filter(r => !members.has(r.number));
  console.log(
    `\nband #${from} – #${to}: ${inBand.length} pieces, ${inBand.length - candidates.length} already catalogued`
  );
  const described = candidates.filter(r => r.description);
  console.log(`  ${candidates.length} to review (${described.length} have a description)`);
  printSlideshow(
    'review the band',
    candidates.map(r => r.number)
  );
  if (described.length > 0) {
    console.log(`\n  candidates that already have a description (skim these first):`);
    for (const r of described.slice(0, 40)) {
      console.log(`    ${String(r.number).padEnd(10)} ${r.description.slice(0, 84)}`);
    }
    if (described.length > 40) console.log(`    … and ${described.length - 40} more`);
  }
}

function listSeries() {
  console.log('\nseries in src/lib/series.ts:\n');
  for (const s of SERIES) {
    const size =
      s.declaredSize != null ? `${s.members.length}/${s.declaredSize}` : `${s.members.length}`;
    console.log(`  ${s.slug.padEnd(18)} ${size.padEnd(8)} ${s.status.padEnd(8)} ${s.label}`);
  }
  console.log('\nrun with --series <slug> [--missing|--diff|--band a-b], or --seed <term>');
}

// ---------------------------------------------------------------- main

function parseArgs(argv) {
  const out = { series: null, seed: null, band: null, missing: false, diff: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--series') out.series = argv[++i];
    else if (a === '--seed') out.seed = argv[++i];
    else if (a === '--band') out.band = argv[++i];
    else if (a === '--missing') out.missing = true;
    else if (a === '--diff') out.diff = true;
    else {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const args = parseArgs(process.argv);
const all = loadInscriptions();

if (!args.series && !args.seed) {
  listSeries();
  process.exit(0);
}

let series = null;
if (args.series) {
  series = getSeries(args.series);
  if (!series) {
    console.error(`no series with slug "${args.series}"`);
    listSeries();
    process.exit(2);
  }
}

if (args.band) {
  const m = args.band.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) {
    console.error('--band expects <from>-<to>, e.g. --band 83294043-83308608');
    process.exit(2);
  }
  cmdBand(all, series, parseInt(m[1], 10), parseInt(m[2], 10));
} else if (args.missing) {
  if (!series) {
    console.error('--missing requires --series <slug>');
    process.exit(2);
  }
  cmdMissing(series);
} else if (args.diff) {
  if (!series) {
    console.error('--diff requires --series <slug>');
    process.exit(2);
  }
  cmdDiff(all, series);
} else {
  const seed = args.seed ? { pattern: args.seed, in: ['description', 'tags'] } : series.seed;
  if (!seed) {
    console.error(
      `series "${series.slug}" has no catalogue-metadata seed; pass --seed <term> or use --band`
    );
    process.exit(2);
  }
  const label = series ? series.label : 'ad-hoc';
  cmdSeed(all, seed, label, new Set(series?.members ?? []));
}
