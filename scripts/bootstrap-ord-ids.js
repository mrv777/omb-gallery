#!/usr/bin/env node
/* eslint-disable */
// One-shot bootstrap: query ord for inscription_id + current_output + current_owner
// for every inscriptions row where inscription_id IS NULL, then bulk-update SQLite.
// Uses native fetch + a concurrency limiter; talks to better-sqlite3 directly.

const path = require('node:path');
const Database = require('better-sqlite3');

const ORD_BASE = (process.env.ORD_BASE_URL ?? '').replace(/\/+$/, '');
const DB_PATH = process.env.OMB_DB_PATH ?? path.resolve(__dirname, '..', 'tmp', 'dev.db');
const CONCURRENCY = parseInt(process.env.BOOTSTRAP_CONCURRENCY ?? '20', 10);
const TIMEOUT_MS = 10_000;

if (!ORD_BASE) {
  console.error('[bootstrap] ORD_BASE_URL is required');
  process.exit(2);
}

function stripVoutFromSatpoint(s) {
  if (!s) return null;
  const parts = s.split(':');
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : s;
}

async function fetchOne(num) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${ORD_BASE}/inscription/${num}`, {
      headers: { Accept: 'application/json' },
      signal: ctl.signal,
    });
    if (!res.ok) return { num, error: `HTTP ${res.status}` };
    const j = await res.json();
    return {
      num,
      id: j.id ?? null,
      output: stripVoutFromSatpoint(j.satpoint ?? j.output ?? null),
      address: j.address ?? null,
    };
  } catch (e) {
    return { num, error: e.message ?? String(e) };
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  const total = db.prepare('SELECT COUNT(*) AS n FROM inscriptions').get().n;
  if (total === 0) {
    console.error('[bootstrap] inscriptions table is empty — start the app once to seed from images.json, then re-run');
    process.exit(1);
  }

  const missing = db.prepare(
    'SELECT inscription_number FROM inscriptions WHERE inscription_id IS NULL ORDER BY inscription_number'
  ).all().map(r => r.inscription_number);

  console.log(`[bootstrap] ord=${ORD_BASE} db=${DB_PATH} missing=${missing.length} concurrency=${CONCURRENCY}`);
  if (missing.length === 0) {
    console.log('[bootstrap] nothing to do');
    return;
  }

  const update = db.prepare(`
    UPDATE inscriptions
    SET inscription_id = COALESCE(?, inscription_id),
        current_output = COALESCE(?, current_output),
        current_owner  = COALESCE(?, current_owner)
    WHERE inscription_number = ?
  `);
  const flush = db.transaction((rows) => {
    for (const r of rows) {
      if (r.error || !r.id) continue;
      update.run(r.id, r.output, r.address, r.num);
    }
  });

  let next = 0;
  let done = 0;
  let ok = 0;
  let err = 0;
  const buffer = [];
  const FLUSH_EVERY = 100;
  const startedAt = Date.now();

  async function worker() {
    while (next < missing.length) {
      const i = next++;
      const r = await fetchOne(missing[i]);
      buffer.push(r);
      done++;
      if (r.error || !r.id) err++;
      else ok++;
      if (buffer.length >= FLUSH_EVERY) {
        flush(buffer.splice(0));
      }
      if (done % 200 === 0) {
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = done / elapsed;
        const eta = Math.round((missing.length - done) / rate);
        console.log(`[bootstrap] ${done}/${missing.length} ok=${ok} err=${err} ${rate.toFixed(1)}/s eta=${eta}s`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (buffer.length) flush(buffer);

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[bootstrap] DONE in ${elapsed}s — ok=${ok} err=${err}`);

  // Final sanity counts
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM inscriptions)                                  AS total,
      (SELECT COUNT(*) FROM inscriptions WHERE inscription_id IS NOT NULL) AS with_id,
      (SELECT COUNT(*) FROM inscriptions WHERE current_output IS NOT NULL) AS with_output,
      (SELECT COUNT(*) FROM inscriptions WHERE current_owner IS NOT NULL)  AS with_owner
  `).get();
  console.log('[bootstrap] counts:', counts);

  db.close();
}

main().catch(e => { console.error('[bootstrap] FATAL:', e); process.exit(1); });
