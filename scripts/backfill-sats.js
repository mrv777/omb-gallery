#!/usr/bin/env node
/* eslint-disable */
// One-shot backfill: populate inscriptions.sat (the ordinal/sat number each
// inscription sits on) for OMB rows that have an inscription_id but no sat yet.
// Powers raster.art links, whose token URL keys off the sat number.
//
// SOURCE: ordinals.com's recursive endpoint /r/inscription/<id>, which returns
// `sat` as clean JSON. We CANNOT use our own ord node for this — it runs with
// sat indexing OFF (index_addresses=true, sats/runes off), so it ships
// `sat: null` for every inscription. ordinals.com runs a sat-indexed ord.
//
// Idempotent + resumable: the WHERE clause only selects rows still missing sat,
// so re-running after an interruption (or a rate-limit stall) picks up where it
// left off. Scoped to collection 'omb' — raster links are OMB-only.
//
// Required env: none (defaults below work against prod).
// Optional:
//   OMB_DB_PATH           default ./tmp/dev.db
//   ORDINALS_BASE_URL     default https://ordinals.com
//   BACKFILL_CONCURRENCY  default 8 (be polite to ordinals.com)
//   BACKFILL_LIMIT        debug: only process the first N missing rows
//
// Max sat (~2.1e15) is well within Number.MAX_SAFE_INTEGER, so plain JS
// numbers are safe here (no BigInt needed).

const path = require('node:path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.OMB_DB_PATH ?? path.resolve(__dirname, '..', 'tmp', 'dev.db');
const ORDINALS_BASE = (process.env.ORDINALS_BASE_URL ?? 'https://ordinals.com').replace(/\/+$/, '');
const CONCURRENCY = parseInt(process.env.BACKFILL_CONCURRENCY ?? '8', 10);
const LIMIT = process.env.BACKFILL_LIMIT ? parseInt(process.env.BACKFILL_LIMIT, 10) : null;
const TIMEOUT_MS = 15_000;
const MAX_RETRIES = 4;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Fetch sat for one inscription_id, retrying on 429 / 5xx / network with
// exponential backoff. Returns { sat } (sat may be null = unbound) or { error }.
async function fetchSat(inscriptionId) {
  let lastErr = 'unknown';
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${ORDINALS_BASE}/r/inscription/${inscriptionId}`, {
        headers: { Accept: 'application/json' },
        signal: ctl.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = `HTTP ${res.status}`;
        clearTimeout(t);
        await sleep(Math.min(500 * 2 ** attempt, 8000) * (0.75 + Math.random() * 0.5));
        continue;
      }
      if (!res.ok) {
        clearTimeout(t);
        return { error: `HTTP ${res.status}` };
      }
      const j = await res.json();
      clearTimeout(t);
      // ordinals.com ships `sat: null` for unbound inscriptions — treat as none.
      const sat = typeof j.sat === 'number' && Number.isFinite(j.sat) ? Math.trunc(j.sat) : null;
      return { sat };
    } catch (e) {
      lastErr = e.message ?? String(e);
      clearTimeout(t);
      await sleep(Math.min(500 * 2 ** attempt, 8000) * (0.75 + Math.random() * 0.5));
    }
  }
  return { error: lastErr };
}

async function main() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  // Guard: the sat column must exist (schema v39). Start the app once against
  // this DB to run migrations if it doesn't.
  const cols = db.pragma('table_info(inscriptions)');
  if (!cols.some(c => c.name === 'sat')) {
    console.error(
      '[backfill-sats] inscriptions.sat column missing — migrate this DB to v39 first, then re-run'
    );
    process.exit(1);
  }

  let rows = db
    .prepare(
      `SELECT inscription_number, inscription_id
       FROM inscriptions
       WHERE collection_slug = 'omb' AND inscription_id IS NOT NULL AND sat IS NULL
       ORDER BY inscription_number`
    )
    .all();
  if (LIMIT != null) rows = rows.slice(0, LIMIT);

  console.log(
    `[backfill-sats] src=${ORDINALS_BASE} db=${DB_PATH} missing(omb)=${rows.length} concurrency=${CONCURRENCY}`
  );
  if (rows.length === 0) {
    console.log('[backfill-sats] nothing to do');
    db.close();
    return;
  }

  const update = db.prepare(
    `UPDATE inscriptions SET sat = COALESCE(sat, ?) WHERE inscription_number = ? AND ? IS NOT NULL`
  );
  const flush = db.transaction(items => {
    for (const it of items) {
      if (it.error || it.sat == null) continue;
      update.run(it.sat, it.num, it.sat);
    }
  });

  let next = 0;
  let done = 0;
  let ok = 0;
  let unbound = 0;
  let err = 0;
  const buffer = [];
  const FLUSH_EVERY = 100;
  const startedAt = Date.now();

  async function worker() {
    while (next < rows.length) {
      const i = next++;
      const row = rows[i];
      const r = await fetchSat(row.inscription_id);
      buffer.push({ num: row.inscription_number, sat: r.sat ?? null, error: r.error });
      done++;
      if (r.error) err++;
      else if (r.sat == null) unbound++;
      else ok++;
      if (buffer.length >= FLUSH_EVERY) flush(buffer.splice(0));
      if (done % 500 === 0) {
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = done / elapsed;
        const eta = Math.round((rows.length - done) / rate);
        console.log(
          `[backfill-sats] ${done}/${rows.length} ok=${ok} unbound=${unbound} err=${err} ${rate.toFixed(1)}/s eta=${eta}s`
        );
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (buffer.length) flush(buffer);

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[backfill-sats] DONE in ${elapsed}s — ok=${ok} unbound=${unbound} err=${err}`);

  const counts = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM inscriptions WHERE collection_slug='omb')                        AS omb_total,
        (SELECT COUNT(*) FROM inscriptions WHERE collection_slug='omb' AND inscription_id IS NOT NULL) AS omb_with_id,
        (SELECT COUNT(*) FROM inscriptions WHERE collection_slug='omb' AND sat IS NOT NULL)     AS omb_with_sat`
    )
    .get();
  console.log('[backfill-sats] counts:', counts);
  if (err > 0) {
    console.log('[backfill-sats] NOTE: err>0 — re-run to retry the failures (resumable).');
  }

  db.close();
}

main().catch(e => {
  console.error('[backfill-sats] FATAL:', e);
  process.exit(1);
});
