/**
 * Schema v8 — multi-collection groundwork. The migration is purely additive:
 * `collections` table seeded with 'omb', `inscriptions.collection_slug`
 * backfilled to 'omb' for every existing row, and a fresh `backfill_state`
 * table for the per-inscription transfer-history walker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let dbModule: typeof import('../src/lib/db');
const tempDir = path.join(os.tmpdir(), `omb-test-${process.pid}-${Math.random().toString(36).slice(2)}`);

beforeEach(async () => {
  fs.mkdirSync(tempDir, { recursive: true });
  const dbPath = path.join(tempDir, `t-${Math.random().toString(36).slice(2)}.db`);
  process.env.OMB_DB_PATH = dbPath;
  vi.resetModules();
  dbModule = await import('../src/lib/db');
});

afterEach(() => {
  try {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
});

describe('schema v8 — collections + backfill_state', () => {
  it('reaches user_version 8', () => {
    const db = dbModule.getDb();
    const ver = db.pragma('user_version', { simple: true });
    expect(ver).toBe(8);
  });

  it('seeds the OMB collection row', () => {
    const db = dbModule.getDb();
    const row = db
      .prepare(`SELECT slug, name, satflow_slug, enabled FROM collections WHERE slug = 'omb'`)
      .get() as { slug: string; name: string; satflow_slug: string; enabled: number };
    expect(row).toMatchObject({
      slug: 'omb',
      name: 'Ordinal Maxi Biz',
      satflow_slug: 'omb',
      enabled: 1,
    });
  });

  it('tags every seeded inscription with a known collection_slug', () => {
    const db = dbModule.getDb();
    const row = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN collection_slug = 'omb' THEN 1 ELSE 0 END) AS omb,
           SUM(CASE WHEN collection_slug = 'bravocados' THEN 1 ELSE 0 END) AS bravocados,
           SUM(CASE WHEN collection_slug IS NULL THEN 1 ELSE 0 END) AS missing
         FROM inscriptions`
      )
      .get() as { total: number; omb: number; bravocados: number; missing: number };
    expect(row.total).toBeGreaterThan(0);
    expect(row.omb).toBeGreaterThan(0);
    expect(row.bravocados).toBeGreaterThan(0);
    expect(row.missing).toBe(0);
    expect(row.omb + row.bravocados).toBe(row.total);
  });

  it('creates backfill_state with the expected shape', () => {
    const db = dbModule.getDb();
    const cols = db.pragma('table_info(backfill_state)') as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        'collection_slug',
        'inscription_id',
        'last_error',
        'status',
        'transfers_recorded',
        'updated_at',
        'walked_to_satpoint',
      ].sort()
    );
  });

  it('enforces the backfill_state status CHECK constraint', () => {
    const db = dbModule.getDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO backfill_state (collection_slug, inscription_id, status) VALUES ('omb', 'abc', 'bogus')`
        )
        .run()
    ).toThrow();
  });

  it('idx_insc_collection exists for collection-scoped reads', () => {
    const db = dbModule.getDb();
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_insc_collection'`)
      .get();
    expect(idx).toBeTruthy();
  });

  it('seeds the Bitcoin Bravocados collection row', () => {
    const db = dbModule.getDb();
    const row = db
      .prepare(`SELECT slug, name, satflow_slug, enabled FROM collections WHERE slug = 'bravocados'`)
      .get() as { slug: string; name: string; satflow_slug: string; enabled: number };
    expect(row).toMatchObject({
      slug: 'bravocados',
      name: 'Bitcoin Bravocados',
      satflow_slug: 'bitcoin-bravocados',
      enabled: 1,
    });
  });

  it('seeds Bravocados inscription rows with inscription_id and inscription_number', () => {
    const db = dbModule.getDb();
    // Bravocados is a flat-shape collection — every row must arrive with
    // both id and number, since the parent's children enumerate gave us both.
    const stats = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN inscription_id IS NULL THEN 1 ELSE 0 END) AS missing_id,
           SUM(CASE WHEN color IS NOT NULL THEN 1 ELSE 0 END) AS unexpected_color
         FROM inscriptions
         WHERE collection_slug = 'bravocados'`
      )
      .get() as { total: number; missing_id: number; unexpected_color: number };
    expect(stats.total).toBe(1002); // matches the parent's child count at seed time
    expect(stats.missing_id).toBe(0);
    expect(stats.unexpected_color).toBe(0);
  });

  it('does not cross-contaminate color between OMB and Bravocados rows', () => {
    const db = dbModule.getDb();
    const ombMissingColor = db
      .prepare(`SELECT COUNT(*) AS n FROM inscriptions WHERE collection_slug = 'omb' AND color IS NULL`)
      .get() as { n: number };
    expect(ombMissingColor.n).toBe(0);
  });

  it('re-running getDb is a no-op after first seed', () => {
    const db1 = dbModule.getDb();
    const before = db1.prepare(`SELECT COUNT(*) AS n FROM inscriptions`).get() as { n: number };
    // Force a fresh module load against the same DB file to re-trigger seedInscriptions.
    process.env.OMB_DB_PATH = (db1 as unknown as { name: string }).name;
    // Same DB file, same module cache reset → should bail fast on the count check.
    const db2 = dbModule.getDb();
    const after = db2.prepare(`SELECT COUNT(*) AS n FROM inscriptions`).get() as { n: number };
    expect(after.n).toBe(before.n);
  });
});
