#!/usr/bin/env node
/* eslint-disable no-console */
// Materialize a collection inventory from a parent inscription's children.
//
// Walks `/r/children/<parent>/inscriptions/<page>` (a recursive endpoint
// any ord HTTP server exposes — including ordinals.com publicly), dedupes by
// inscription id, and writes a static JSON inventory to
// `src/data/collections/<slug>/`.
//
// This is the most reliable seed path for parent/child collections (e.g.
// Bitcoin Bravocados). No Satflow API key required, doesn't depend on the
// local ord finishing IBD — ordinals.com is the default base URL.
//
// Usage:
//   node scripts/enumerate-children-from-ord.mjs \
//     --parent=<parent_inscription_id> \
//     --slug=<our-slug> \
//     [--name="..."] [--satflow-slug=<satflow-slug>] \
//     [--ord-base-url=<override>]   # default: https://ordinals.com
//
// Output:
//   src/data/collections/<slug>/manifest.json
//   src/data/collections/<slug>/inscriptions.json   # [{inscription_id, inscription_number}, ...]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const ARGS = parseArgs(process.argv.slice(2));
if (!ARGS.parent || !ARGS.slug) {
  console.error(
    'Usage: node scripts/enumerate-children-from-ord.mjs --parent=<inscription_id> --slug=<our-slug> [--name="..."] [--satflow-slug=<...>] [--ord-base-url=<...>]'
  );
  process.exit(1);
}

const ORD_BASE = (ARGS['ord-base-url'] ?? process.env.ORD_BASE_URL ?? 'https://ordinals.com').replace(
  /\/+$/,
  ''
);
const PARENT = ARGS.parent;
const SLUG = ARGS.slug;
const NAME = ARGS.name ?? SLUG;
const SATFLOW_SLUG = ARGS['satflow-slug'] ?? null;
const OUT_DIR = path.join(REPO_ROOT, 'src', 'data', 'collections', SLUG);
const REQUEST_TIMEOUT_MS = 20_000;

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(
    `[children] parent=${PARENT}\n` +
      `           ord_base=${ORD_BASE}\n` +
      `           out=${path.relative(REPO_ROOT, OUT_DIR)}/`
  );

  const seen = new Map(); // inscription_id → number
  let page = 0;
  while (true) {
    const url = `${ORD_BASE}/r/children/${PARENT}/inscriptions/${page}`;
    const json = await fetchJson(url);
    const children = Array.isArray(json?.children) ? json.children : [];
    let added = 0;
    for (const c of children) {
      const id = pickString(c, ['id', 'inscription_id']);
      if (!id) continue;
      if (!seen.has(id)) {
        const number = pickInt(c, ['number', 'inscription_number']);
        seen.set(id, number);
        added++;
      }
    }
    console.log(
      `[children] page ${page}: rows=${children.length} new=${added} cumulative=${seen.size} more=${json?.more === true}`
    );
    if (json?.more !== true) break;
    page++;
  }

  // Sort by inscription_number when available (lower = earlier mint), else by id
  // — gives stable, human-meaningful output ordering.
  const inscriptions = [...seen.entries()]
    .map(([inscription_id, inscription_number]) => ({ inscription_id, inscription_number }))
    .sort((a, b) => {
      if (a.inscription_number != null && b.inscription_number != null) {
        return a.inscription_number - b.inscription_number;
      }
      return a.inscription_id.localeCompare(b.inscription_id);
    });

  const manifest = {
    slug: SLUG,
    name: NAME,
    satflow_slug: SATFLOW_SLUG,
    parent_inscription_id: PARENT,
    shape: 'flat',
    total: inscriptions.length,
    generated_at: new Date().toISOString(),
    source: `ord recursive /r/children/${PARENT}/inscriptions/* (base: ${ORD_BASE})`,
  };

  fs.writeFileSync(
    path.join(OUT_DIR, 'inscriptions.json'),
    JSON.stringify(inscriptions, null, 2) + '\n'
  );
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log(`[children] DONE — wrote ${inscriptions.length} children to ${path.relative(REPO_ROOT, OUT_DIR)}/`);
}

function pickString(item, keys) {
  for (const k of keys) {
    const v = item?.[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function pickInt(item, keys) {
  for (const k of keys) {
    const v = item?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  }
  return null;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'omb-gallery/seed' },
      signal: controller.signal,
    });
    if (res.status === 429) {
      const retry = parseInt(res.headers.get('retry-after') ?? '30', 10);
      console.warn(`[children] 429 rate limited — sleeping ${retry}s`);
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
  console.error('[children] FATAL:', e);
  process.exit(1);
});
