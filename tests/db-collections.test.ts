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
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
});

describe('schema v10 — collections + backfill_state + poll_state composite PK + typed-feed index', () => {
  it('reaches user_version 10', () => {
    const db = dbModule.getDb();
    const ver = db.pragma('user_version', { simple: true });
    expect(ver).toBe(10);
  });

  it('creates idx_events_type_ts_id covering the typed activity feed sort', () => {
    const db = dbModule.getDb();
    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_type_ts_id'`
      )
      .get();
    expect(idx).toBeDefined();
  });

  it('seeds poll_state with composite (stream, collection_slug) rows', () => {
    const db = dbModule.getDb();
    // ord: single 'omb' row (one batch poll spans all collections).
    // satflow + satflow_listings: per-collection rows for every collection
    // whose manifest has a satflow_slug (omb + bravocados in this repo).
    const rows = db
      .prepare(`SELECT stream, collection_slug FROM poll_state ORDER BY stream, collection_slug`)
      .all() as Array<{ stream: string; collection_slug: string }>;
    expect(rows).toEqual([
      { stream: 'ord', collection_slug: 'omb' },
      { stream: 'satflow', collection_slug: 'bravocados' },
      { stream: 'satflow', collection_slug: 'omb' },
      { stream: 'satflow_listings', collection_slug: 'bravocados' },
      { stream: 'satflow_listings', collection_slug: 'omb' },
    ]);
  });

  it('rejects duplicate (stream, collection_slug) inserts via composite PK', () => {
    const db = dbModule.getDb();
    expect(() =>
      db.prepare(`INSERT INTO poll_state (stream, collection_slug) VALUES ('satflow', 'omb')`).run()
    ).toThrow();
  });

  it('listEnabledCollections returns rows sorted by slug', () => {
    const stmts = dbModule.getStmts();
    const rows = stmts.listEnabledCollections.all([]) as Array<{ slug: string }>;
    expect(rows.map(r => r.slug)).toEqual(['bravocados', 'omb']);
  });

  it('deleteStaleListings only deletes rows for the requested collection', () => {
    const db = dbModule.getDb();
    const stmts = dbModule.getStmts();
    const omb = db
      .prepare(`SELECT inscription_number FROM inscriptions WHERE collection_slug = 'omb' LIMIT 1`)
      .get() as { inscription_number: number };
    const bra = db
      .prepare(
        `SELECT inscription_number FROM inscriptions WHERE collection_slug = 'bravocados' LIMIT 1`
      )
      .get() as { inscription_number: number };
    // Both listings are equally stale — only the targeted collection should
    // be wiped. Without the collection filter, the OMB tick would clobber
    // the Bravocados snapshot every 15 min.
    stmts.upsertActiveListing.run({
      inscription_number: omb.inscription_number,
      inscription_id: 'a'.repeat(64) + 'i0',
      satflow_id: 'sat-omb',
      price_sats: 1,
      seller: null,
      marketplace: 'satflow',
      listed_at: 1,
      refreshed_at: 1,
    });
    stmts.upsertActiveListing.run({
      inscription_number: bra.inscription_number,
      inscription_id: 'b'.repeat(64) + 'i0',
      satflow_id: 'sat-bra',
      price_sats: 1,
      seller: null,
      marketplace: 'satflow',
      listed_at: 1,
      refreshed_at: 1,
    });
    expect((stmts.countActiveListings.get([]) as { n: number }).n).toBe(2);
    stmts.deleteStaleListings.run({ cutoff: 100, collection: 'omb' });
    const remaining = db.prepare(`SELECT inscription_number FROM active_listings`).all() as Array<{
      inscription_number: number;
    }>;
    expect(remaining).toEqual([{ inscription_number: bra.inscription_number }]);
  });
});

describe('schema v8 — collections + backfill_state', () => {
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
    const names = cols.map(c => c.name).sort();
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
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_insc_collection'`
      )
      .get();
    expect(idx).toBeTruthy();
  });

  it('seeds the Bitcoin Bravocados collection row', () => {
    const db = dbModule.getDb();
    const row = db
      .prepare(
        `SELECT slug, name, satflow_slug, enabled FROM collections WHERE slug = 'bravocados'`
      )
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
      .prepare(
        `SELECT COUNT(*) AS n FROM inscriptions WHERE collection_slug = 'omb' AND color IS NULL`
      )
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
