/**
 * Schema v39 — inscriptions.sat column + raster.art link plumbing.
 * The migration is purely additive (a nullable INTEGER column). setInscriptionSat
 * writes the sat once and never overwrites it; rasterInscriptionLink builds the
 * sat-keyed raster.art URL (raster rejects inscription id/number — sat only).
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
    expect(sat!.notnull).toBe(0); // nullable — NULL until resolved
  });

  it('setInscriptionSat writes once and never overwrites', () => {
    const db = dbModule.getDb();
    const stmts = dbModule.getStmts();
    const row = db
      .prepare(`SELECT inscription_number FROM inscriptions WHERE collection_slug='omb' LIMIT 1`)
      .get() as { inscription_number: number };
    const num = row.inscription_number;

    // Large sat near the ceiling to confirm 64-bit integers survive the round-trip.
    const sat = 2_099_999_997_689_999;
    stmts.setInscriptionSat.run({ inscription_number: num, sat });
    let stored = db.prepare(`SELECT sat FROM inscriptions WHERE inscription_number=?`).get(num) as {
      sat: number | null;
    };
    expect(stored.sat).toBe(sat);

    // A later call with a different sat must NOT clobber it (sat is immutable).
    stmts.setInscriptionSat.run({ inscription_number: num, sat: 123 });
    stored = db.prepare(`SELECT sat FROM inscriptions WHERE inscription_number=?`).get(num) as {
      sat: number | null;
    };
    expect(stored.sat).toBe(sat);
  });

  it('setInscriptionSat no-ops when sat is null', () => {
    const db = dbModule.getDb();
    const stmts = dbModule.getStmts();
    const row = db
      .prepare(`SELECT inscription_number FROM inscriptions WHERE collection_slug='omb' LIMIT 1`)
      .get() as { inscription_number: number };
    const num = row.inscription_number;
    stmts.setInscriptionSat.run({ inscription_number: num, sat: null });
    const stored = db
      .prepare(`SELECT sat FROM inscriptions WHERE inscription_number=?`)
      .get(num) as { sat: number | null };
    expect(stored.sat).toBeNull();
  });

  it('getInscription surfaces the sat column', () => {
    const db = dbModule.getDb();
    const stmts = dbModule.getStmts();
    const row = db
      .prepare(`SELECT inscription_number FROM inscriptions WHERE collection_slug='omb' LIMIT 1`)
      .get() as { inscription_number: number };
    stmts.setInscriptionSat.run({ inscription_number: row.inscription_number, sat: 45015195336 });
    const insc = stmts.getInscription.get({
      inscription_number: row.inscription_number,
      collection: 'omb',
    }) as { sat: number | null };
    expect(insc.sat).toBe(45015195336);
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
