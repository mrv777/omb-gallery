/**
 * Schema v39 — inscriptions.sat column + raster.art link plumbing.
 * The migration is purely additive (a nullable INTEGER column). sat is
 * populated once by scripts/backfill-sats.js (from ordinals.com); the app only
 * reads it. rasterInscriptionLink builds the sat-keyed raster.art URL (raster
 * rejects inscription id/number — sat only).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { rasterInscriptionLink } from '../src/lib/format';

let dbModule: typeof import('../src/lib/db');
const tempDir = path.join(
  os.tmpdir(),
  `omb-test-${process.pid}-${Math.random().toString(36).slice(2)}`
);

beforeEach(async () => {
  fs.mkdirSync(tempDir, { recursive: true });
  const dbPath = path.join(tempDir, `t-${Math.random().toString(36).slice(2)}.db`);
  process.env.OMB_DB_PATH = dbPath;
  vi.resetModules();
  dbModule = await import('../src/lib/db');
});

afterEach(() => {
  try {
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('schema v39 — inscriptions.sat', () => {
  it('reaches at least user_version 39', () => {
    const db = dbModule.getDb();
    const ver = db.pragma('user_version', { simple: true }) as number;
    expect(ver).toBeGreaterThanOrEqual(39);
  });

  it('adds a nullable sat column to inscriptions', () => {
    const db = dbModule.getDb();
    const cols = db.pragma('table_info(inscriptions)') as Array<{ name: string; notnull: number }>;
    const sat = cols.find(c => c.name === 'sat');
    expect(sat).toBeDefined();
    expect(sat!.notnull).toBe(0); // nullable — NULL until backfilled
  });

  it('getInscription surfaces the sat column (incl. 64-bit values)', () => {
    const db = dbModule.getDb();
    const stmts = dbModule.getStmts();
    const row = db
      .prepare(`SELECT inscription_number FROM inscriptions WHERE collection_slug='omb' LIMIT 1`)
      .get() as { inscription_number: number };
    // Write via raw SQL, exactly as scripts/backfill-sats.js does. A large sat
    // near the ordinal ceiling confirms 64-bit integers survive the round-trip.
    const sat = 2_099_999_997_689_999;
    db.prepare(`UPDATE inscriptions SET sat = ? WHERE inscription_number = ?`).run(
      sat,
      row.inscription_number
    );
    const insc = stmts.getInscription.get({
      inscription_number: row.inscription_number,
      collection: 'omb',
    }) as { sat: number | null };
    expect(insc.sat).toBe(sat);
  });

  it('sat defaults to NULL for un-backfilled rows', () => {
    const db = dbModule.getDb();
    const stmts = dbModule.getStmts();
    const row = db
      .prepare(`SELECT inscription_number FROM inscriptions WHERE collection_slug='omb' LIMIT 1`)
      .get() as { inscription_number: number };
    const insc = stmts.getInscription.get({
      inscription_number: row.inscription_number,
      collection: 'omb',
    }) as { sat: number | null };
    expect(insc.sat).toBeNull();
  });
});

describe('rasterInscriptionLink', () => {
  it('builds the sat-keyed raster.art token URL', () => {
    expect(rasterInscriptionLink(45015195336)).toBe(
      'https://www.raster.art/token/bitcoin/ordinals/45015195336'
    );
  });

  it('returns empty string when sat is unknown', () => {
    expect(rasterInscriptionLink(null)).toBe('');
    expect(rasterInscriptionLink(undefined)).toBe('');
  });

  it('accepts sat 0 (genesis sat is a valid ordinal)', () => {
    expect(rasterInscriptionLink(0)).toBe('https://www.raster.art/token/bitcoin/ordinals/0');
  });
});
