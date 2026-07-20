#!/usr/bin/env node
/* eslint-disable no-console */
// One-shot fetch of Bravocado art into public/bravocado-images/.
//
// Reads src/data/collections/bravocados/inscriptions.json and downloads each
// piece's on-chain content (36×36 PNG, ~1.2 KB) from ordinals.com, saving it
// as public/bravocado-images/<inscription_number>.png. Outputs are committed —
// this runs at authoring time, like scripts/optimize-images.js.
//
// Idempotent: existing files are skipped, so a partial run can be resumed by
// re-running. Verifies content is really a PNG (magic bytes) and fails loudly
// listing any offenders.
//
// Usage:
//   node scripts/fetch-bravocado-images.mjs [--ord-base-url=<override>]  # default: https://ordinals.com

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const ARGS = parseArgs(process.argv.slice(2));
const ORD_BASE = (ARGS['ord-base-url'] ?? 'https://ordinals.com').replace(/\/+$/, '');
const OUT_DIR = path.join(REPO_ROOT, 'public', 'bravocado-images');
const DATA_PATH = path.join(
  REPO_ROOT,
  'src',
  'data',
  'collections',
  'bravocados',
  'inscriptions.json'
);

const CONCURRENCY = 5;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 3;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function main() {
  const entries = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(
    `[bravocado-images] ${entries.length} entries, base=${ORD_BASE}, out=${path.relative(REPO_ROOT, OUT_DIR)}/`
  );

  let fetched = 0;
  let skipped = 0;
  const failed = [];
  let cursor = 0;

  async function worker() {
    while (cursor < entries.length) {
      const entry = entries[cursor++];
      const { inscription_id: id, inscription_number: num } = entry;
      if (!id || !Number.isFinite(num)) {
        failed.push({ id, num, reason: 'bad entry' });
        continue;
      }
      const dest = path.join(OUT_DIR, `${num}.png`);
      if (fs.existsSync(dest)) {
        skipped++;
        continue;
      }
      try {
        const buf = await fetchContent(`${ORD_BASE}/content/${id}`);
        if (!buf.subarray(0, 8).equals(PNG_MAGIC)) {
          throw new Error('not a PNG (magic byte mismatch)');
        }
        // Write via temp file so an interrupted run never leaves a truncated
        // file that a resume would then skip.
        const tmp = `${dest}.tmp`;
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, dest);
        fetched++;
        if (fetched % 100 === 0)
          console.log(`[bravocado-images] fetched=${fetched} skipped=${skipped}`);
      } catch (e) {
        failed.push({ id, num, reason: e?.message ?? String(e) });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log(
    `[bravocado-images] DONE — fetched=${fetched} skipped=${skipped} failed=${failed.length}`
  );
  if (failed.length > 0) {
    for (const f of failed) console.error(`  FAILED #${f.num} (${f.id}): ${f.reason}`);
    process.exit(1);
  }
}

async function fetchContent(url, attempt = 1) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'omb-gallery/fetch-bravocado-images' },
      signal: controller.signal,
    });
    if (res.status === 429) {
      const retry = parseInt(res.headers.get('retry-after') ?? '30', 10);
      console.warn(`[bravocado-images] 429 rate limited — sleeping ${retry}s`);
      await sleep(retry * 1000);
      return fetchContent(url, attempt);
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    if (attempt < MAX_RETRIES) {
      await sleep(1000 * attempt);
      return fetchContent(url, attempt + 1);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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

main().catch(e => {
  console.error('[bravocado-images] FATAL:', e);
  process.exit(1);
});
