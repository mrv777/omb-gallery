#!/usr/bin/env node
/* eslint-disable no-console */
// One-shot collection seed from Satflow.
//
// Walks `/v1/activity/listings` and `/v1/activity/sales` for the given collection
// slug, dedupes inscription_ids, then resolves each id to its inscription_number
// via ord (`GET /inscription/<id>` against an ord HTTP base — defaults to
// ordinals.com, no local-ord required). Writes a static JSON inventory to
// `src/data/collections/<slug>/`.
//
// Why both id AND number: `inscription_number` is the PRIMARY KEY in our
// schema, so id-only entries can't seed. Inscriptions found on Satflow that
// ord doesn't recognise (404) are dropped from the output with a count log.
//
// What it captures:
// - Every inscription currently listed on Satflow
// - Every inscription that has ever been sold on Satflow
//
// What it misses:
// - Inscriptions never listed and never sold on Satflow
//
// Usage:
//   SATFLOW_API_KEY=... node scripts/seed-collection-from-satflow.mjs \
//     --slug=bravocados [--name="Bitcoin Bravocados"] \
//     [--satflow-slug=bravocados] [--out=src/data/collections/bravocados] \
//     [--ord-base-url=https://ordinals.com]
//
// Optional env:
//   SATFLOW_BASE_URL   default https://api.satflow.com
//   ORD_BASE_URL       default https://ordinals.com (override with --ord-base-url=)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const ARGS = parseArgs(process.argv.slice(2));
if (!ARGS.slug) {
  console.error(
    'Usage: SATFLOW_API_KEY=... node scripts/seed-collection-from-satflow.mjs --slug=<our-slug> [--name="..."] [--satflow-slug=<satflow-slug>] [--out=<dir>]'
  );
  process.exit(1);
}

const SATFLOW_BASE = (process.env.SATFLOW_BASE_URL ?? 'https://api.satflow.com').replace(/\/+$/, '');
const ORD_BASE = (ARGS['ord-base-url'] ?? process.env.ORD_BASE_URL ?? 'https://ordinals.com').replace(
  /\/+$/,
  ''
);
const API_KEY = process.env.SATFLOW_API_KEY ?? null;
if (!API_KEY) {
  console.error('[seed] SATFLOW_API_KEY env is required.');
  process.exit(1);
}

const SATFLOW_SLUG = ARGS['satflow-slug'] ?? ARGS.slug;
const OUR_SLUG = ARGS.slug;
const NAME = ARGS.name ?? OUR_SLUG;
const OUT_DIR = ARGS.out
  ? path.resolve(REPO_ROOT, ARGS.out)
  : path.join(REPO_ROOT, 'src', 'data', 'collections', OUR_SLUG);

const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 20_000;
const ORD_CONCURRENCY = 10;

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[seed] target dir = ${path.relative(REPO_ROOT, OUT_DIR)}`);
  console.log(`[seed] satflow slug = ${SATFLOW_SLUG}`);
  console.log(`[seed] ord base = ${ORD_BASE}`);

  const seen = new Set();

  // listings first (cheaper, gives us currently-active inventory)
  await walkPaged('listings', '/v1/activity/listings', { sortBy: 'createdAt' }, seen);
  // then sales — historical, can be many pages on a large collection
  await walkPaged('sales', '/v1/activity/sales', { sortBy: 'fillCompletedAt' }, seen);

  // Resolve inscription_number for every collected id. Numbers are required
  // by the DB schema (PRIMARY KEY); ids without numbers can't seed and are
  // dropped here with a count log.
  const ids = [...seen];
  const numbers = await resolveNumbersViaOrd(ids);

  const inscriptions = ids
    .filter((id) => numbers.has(id))
    .map((inscription_id) => ({
      inscription_id,
      inscription_number: numbers.get(inscription_id),
    }))
    .sort((a, b) => a.inscription_number - b.inscription_number);

  const dropped = ids.length - inscriptions.length;
  const manifest = {
    slug: OUR_SLUG,
    name: NAME,
    satflow_slug: SATFLOW_SLUG,
    shape: 'flat',
    total_seen: ids.length,
    total: inscriptions.length,
    dropped_unresolved: dropped,
    generated_at: new Date().toISOString(),
    source: `satflow listings + sales (deduped), inscription_number resolved via ${ORD_BASE}`,
  };

  fs.writeFileSync(
    path.join(OUT_DIR, 'inscriptions.json'),
    JSON.stringify(inscriptions, null, 2) + '\n'
  );
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log(
    `[seed] DONE — wrote ${inscriptions.length} (id, number) pairs to ${path.relative(REPO_ROOT, OUT_DIR)}/ (dropped ${dropped} unresolved)`
  );
}

// Resolve inscription_number for each id via `GET <ord>/inscription/<id>`.
// Runs `ORD_CONCURRENCY` requests in parallel; logs progress every 100 ids.
// 404 responses (ord doesn't know that id) are silently skipped — caller
// drops those entries from the output. Other errors abort the script.
async function resolveNumbersViaOrd(ids) {
  if (ids.length === 0) return new Map();
  console.log(`[seed] resolving ${ids.length} inscription_numbers via ord (concurrency=${ORD_CONCURRENCY})`);
  const out = new Map();
  let done = 0;
  let missing = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < ids.length) {
      const i = cursor++;
      const id = ids[i];
      const result = await fetchOrdNumber(id);
      done++;
      if (result.status === 'ok') {
        out.set(id, result.number);
      } else if (result.status === 'missing') {
        missing++;
      } else {
        // unrecoverable — surface and abort
        throw new Error(`ord lookup failed for ${id}: ${result.error}`);
      }
      if (done % 100 === 0) {
        console.log(`[seed] ord resolve progress: ${done}/${ids.length} (missing=${missing})`);
      }
    }
  }

  await Promise.all(Array.from({ length: ORD_CONCURRENCY }, worker));
  console.log(`[seed] ord resolve done: resolved=${out.size} missing=${missing}`);
  return out;
}

async function fetchOrdNumber(id) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${ORD_BASE}/inscription/${id}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'omb-gallery/seed' },
      signal: controller.signal,
    });
    if (res.status === 404) return { status: 'missing' };
    if (res.status === 429) {
      const retry = parseInt(res.headers.get('retry-after') ?? '30', 10);
      console.warn(`[seed] ord 429 — sleeping ${retry}s`);
      await sleep(retry * 1000);
      return fetchOrdNumber(id);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { status: 'error', error: `${res.status} ${res.statusText}: ${body.slice(0, 200)}` };
    }
    const json = await res.json();
    const number = typeof json?.number === 'number' ? Math.trunc(json.number) : null;
    if (number == null || !Number.isFinite(number)) {
      return { status: 'error', error: `unexpected ord shape (no number): ${JSON.stringify(json).slice(0, 200)}` };
    }
    return { status: 'ok', number };
  } catch (e) {
    return { status: 'error', error: e?.message ?? String(e) };
  } finally {
    clearTimeout(t);
  }
}

async function walkPaged(label, pathname, extraParams, seen) {
  let page = 1;
  let added = 0;
  let totalPages = 0;
  while (true) {
    const url = new URL(`${SATFLOW_BASE}${pathname}`);
    url.searchParams.set('collectionSlug', SATFLOW_SLUG);
    url.searchParams.set('page', String(page));
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    url.searchParams.set('sortDirection', 'desc');
    for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, String(v));

    const json = await fetchJson(url.toString());
    const items = extractItems(json, label);
    if (items.length === 0) break;

    let pageNew = 0;
    for (const it of items) {
      const id = pickInscriptionId(it);
      if (!id) continue;
      if (!seen.has(id)) {
        seen.add(id);
        pageNew++;
      }
    }
    added += pageNew;
    totalPages++;

    console.log(
      `[seed] ${label} page ${page}: rows=${items.length} new=${pageNew} cumulative_unique=${seen.size}`
    );

    if (items.length < PAGE_SIZE) break;
    page++;
  }
  console.log(`[seed] ${label} pages_walked=${totalPages} added=${added}`);
}

function extractItems(json, label) {
  if (!json || typeof json !== 'object') return [];
  const data = json.data;
  if (!data || typeof data !== 'object') return [];
  // Satflow uses different keys per endpoint — sales/listings/items are the
  // observed wrappers. Probe in order.
  const candidate = data[label] ?? data.items ?? data.listings ?? data.sales ?? data.results;
  if (!Array.isArray(candidate)) return [];
  return candidate.filter((x) => x && typeof x === 'object');
}

function pickInscriptionId(item) {
  // Walk the same key order satflow.ts uses for normalization, plus the
  // wrappers Satflow buries inscription_id under.
  const direct =
    pickString(item, ['inscription_id', 'inscriptionId']) ??
    pickFromOrder(item.ask) ??
    pickFromOrder(item.bid) ??
    pickFromOrder(item.order) ??
    pickFromInscription(item.inscription);
  return direct;
}

function pickFromOrder(o) {
  if (!o || typeof o !== 'object') return null;
  return pickString(o, ['inscription_id', 'inscriptionId']) ?? pickFromInscription(o.inscription);
}

function pickFromInscription(o) {
  if (!o || typeof o !== 'object') return null;
  return pickString(o, ['id', 'inscription_id', 'inscriptionId']);
}

function pickString(item, keys) {
  for (const k of keys) {
    const v = item?.[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'x-api-key': API_KEY },
      signal: controller.signal,
    });
    if (res.status === 429) {
      const retry = parseInt(res.headers.get('retry-after') ?? '60', 10);
      console.warn(`[seed] 429 rate limited — sleeping ${retry}s`);
      await sleep(retry * 1000);
      return fetchJson(url);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${res.status} ${res.statusText} from ${url}: ${body.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else out[a.slice(2)] = true;
    }
  }
  return out;
}

main().catch((e) => {
  console.error('[seed] FATAL:', e);
  process.exit(1);
});
