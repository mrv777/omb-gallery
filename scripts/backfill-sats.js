#!/usr/bin/env node
/* eslint-disable */
// One-shot backfill: populate inscriptions.sat (the ordinal/sat number each
// inscription sits on) for every row that already has an inscription_id but no
// sat yet. Reads ord's /inscription/<id> `sat` field. Powers raster.art links,
// whose token URL keys off the sat number, not the inscription id/number.
//
// Idempotent + resumable: the WHERE clause only selects rows still missing sat,
// so re-running after an interruption picks up where it left off. New
// inscriptions get their sat during the live ord bootstrap pass (poll route);
// this script is only for rows reconciled BEFORE the v39 column existed.
//
// Required env:
//   ORD_BASE_URL          e.g. http://127.0.0.1:4000
// Optional:
//   OMB_DB_PATH           default ./tmp/dev.db
//   BACKFILL_CONCURRENCY  default 20 (be polite to your ord node)
//   BACKFILL_LIMIT        debug: only process the first N missing rows
//
// Max sat (~2.1e15) is well within Number.MAX_SAFE_INTEGER, so plain JS
// numbers are safe here (no BigInt needed).

const path = require('node:path');
const Database = require('better-sqlite3');

const ORD_BASE = (process.env.ORD_BASE_URL ?? '').replace(/\/+$/, '');
const DB_PATH = process.env.OMB_DB_PATH ?? path.resolve(__dirname, '..', 'tmp', 'dev.db');
const CONCURRENCY = parseInt(process.env.BACKFILL_CONCURRENCY ?? '20', 10);
const LIMIT = process.env.BACKFILL_LIMIT ? parseInt(process.env.BACKFILL_LIMIT, 10) : null;
const TIMEOUT_MS = 10_000;

if (!ORD_BASE) {
  console.error('[backfill-sats] ORD_BASE_URL is required');
  process.exit(2);
}

async function fetchSat(inscriptionId) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${ORD_BASE}/inscription/${inscriptionId}`, {
      headers: { Accept: 'application/json' },
      signal: ctl.signal,
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const j = await res.json();
    // ord ships `sat: null` for unbound inscriptions — treat as "no sat".
    const sat = typeof j.sat === 'number' && Number.isFinite(j.sat) ? Math.trunc(j.sat) : null;
    return { sat };
  } catch (e) {
    return { error: e.message ?? String(e) };
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  // Guard: the sat column must exist (v39). Start the app once against this DB
  // to run migrations if it doesn't.
  const cols = db.pragma('table_info(inscriptions)');
  if (!cols.some(c => c.name === 'sat')) {
    console.error(
      '[backfill-sats] inscriptions.sat column missing — start the app once against this DB to migrate to v39, then re-run'
    );
    process.exit(1);
  }

  let rows = db
    .prepare(
      `SELECT inscription_number, inscription_id
       FROM inscriptions
       WHERE inscription_id IS NOT NULL AND sat IS NULL
       ORDER BY inscription_number`
    )
    .all();
  if (LIMIT != null) rows = rows.slice(0, LIMIT);

  console.log(
    `[backfill-sats] ord=${ORD_BASE} db=${DB_PATH} missing=${rows.length} concurrency=${CONCURRENCY}`
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
        (SELECT COUNT(*) FROM inscriptions)                                  AS total,
        (SELECT COUNT(*) FROM inscriptions WHERE inscription_id IS NOT NULL) AS with_id,
        (SELECT COUNT(*) FROM inscriptions WHERE sat IS NOT NULL)            AS with_sat`
    )
    .get();
  console.log('[backfill-sats] counts:', counts);

  db.close();
}

main().catch(e => {
  console.error('[backfill-sats] FATAL:', e);
  process.exit(1);
});
