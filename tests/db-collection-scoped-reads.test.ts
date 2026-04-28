/**
 * Reader queries scope to a collection via the `@collection` named param.
 * These tests pre-populate events + inscription state for both OMB and
 * Bravocados, then verify each prepared statement returns ONLY rows from
 * the requested collection.
 *
 * Why this matters: once ord finishes IBD, transfer events for both
 * collections will land in the shared `events` table. The unified UI feeds
 * (/api/activity, /api/explorer/*, /api/holders) must not leak Bravocados
 * data into the OMB UI before Phase 5 wires per-collection routes.
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

/** Pick one OMB and one Bravocados inscription_number from the seeded DB,
 *  enrich both with a synthetic transfer event + owner so the leaderboards
 *  and feeds have something to return. */
function seedFixtureRows(db: ReturnType<typeof dbModule.getDb>) {
  const omb = db
    .prepare(`SELECT inscription_number FROM inscriptions WHERE collection_slug = 'omb' LIMIT 1`)
    .get() as { inscription_number: number };
  const bra = db
    .prepare(`SELECT inscription_number FROM inscriptions WHERE collection_slug = 'bravocados' LIMIT 1`)
    .get() as { inscription_number: number };

  const insertEvent = db.prepare(`
    INSERT INTO events (
      inscription_id, inscription_number, event_type, block_height, block_timestamp,
      txid
    ) VALUES (@id, @num, 'transferred', 1, 1700000000, @txid)
  `);
  insertEvent.run({ id: 'omb-id-1', num: omb.inscription_number, txid: 'a'.repeat(64) });
  insertEvent.run({ id: 'bra-id-1', num: bra.inscription_number, txid: 'b'.repeat(64) });

  // Set current_owner + transfer_count so leaderboards and holders queries
  // include them.
  const update = db.prepare(`
    UPDATE inscriptions
    SET current_owner = @owner, transfer_count = 5, last_movement_at = 1700000000
    WHERE inscription_number = @num
  `);
  update.run({ owner: 'owner-omb', num: omb.inscription_number });
  update.run({ owner: 'owner-bra', num: bra.inscription_number });

  return { omb: omb.inscription_number, bra: bra.inscription_number };
}

describe('reader stmts scope to @collection', () => {
  it('getRecentEvents only returns events for the requested collection', () => {
    const db = dbModule.getDb();
    seedFixtureRows(db);
    const stmts = dbModule.getStmts();

    const omb = stmts.getRecentEvents.all({ limit: 50, collection: 'omb' }) as Array<{
      inscription_id: string;
    }>;
    const bra = stmts.getRecentEvents.all({ limit: 50, collection: 'bravocados' }) as Array<{
      inscription_id: string;
    }>;

    expect(omb.every((e) => e.inscription_id === 'omb-id-1')).toBe(true);
    expect(bra.every((e) => e.inscription_id === 'bra-id-1')).toBe(true);
    expect(omb.length).toBe(1);
    expect(bra.length).toBe(1);
  });

  it('countEvents and countHolders are collection-scoped', () => {
    const db = dbModule.getDb();
    seedFixtureRows(db);
    const stmts = dbModule.getStmts();

    expect((stmts.countEvents.get({ collection: 'omb' }) as { n: number }).n).toBe(1);
    expect((stmts.countEvents.get({ collection: 'bravocados' }) as { n: number }).n).toBe(1);
    expect((stmts.countHolders.get({ collection: 'omb' }) as { n: number }).n).toBe(1);
    expect((stmts.countHolders.get({ collection: 'bravocados' }) as { n: number }).n).toBe(1);
  });

  it('topByTransfers and topHolders only see rows from the requested collection', () => {
    const db = dbModule.getDb();
    seedFixtureRows(db);
    const stmts = dbModule.getStmts();

    const ombTop = stmts.topByTransfers.all({ limit: 10, collection: 'omb' }) as Array<{
      collection_slug: string;
    }>;
    const braTop = stmts.topByTransfers.all({ limit: 10, collection: 'bravocados' }) as Array<{
      collection_slug: string;
    }>;
    expect(ombTop.length).toBe(1);
    expect(braTop.length).toBe(1);
    expect(ombTop[0].collection_slug).toBe('omb');
    expect(braTop[0].collection_slug).toBe('bravocados');

    const ombHolders = stmts.topHolders.all({ limit: 10, collection: 'omb' }) as Array<{
      wallet_addr: string;
    }>;
    expect(ombHolders.map((h) => h.wallet_addr)).toEqual(['owner-omb']);
  });

  it('getInscription returns null when collection mismatches', () => {
    const db = dbModule.getDb();
    const { omb, bra } = seedFixtureRows(db);
    const stmts = dbModule.getStmts();

    const ombInOmb = stmts.getInscription.get({
      inscription_number: omb,
      collection: 'omb',
    });
    const braInOmb = stmts.getInscription.get({
      inscription_number: bra,
      collection: 'omb',
    });
    const braInBra = stmts.getInscription.get({
      inscription_number: bra,
      collection: 'bravocados',
    });

    expect(ombInOmb).toBeTruthy();
    expect(braInOmb).toBeUndefined();
    expect(braInBra).toBeTruthy();
  });

  it('an unknown collection slug returns empty results without erroring', () => {
    const db = dbModule.getDb();
    seedFixtureRows(db);
    const stmts = dbModule.getStmts();

    expect(stmts.getRecentEvents.all({ limit: 50, collection: 'unknown' }).length).toBe(0);
    expect((stmts.countEvents.get({ collection: 'unknown' }) as { n: number }).n).toBe(0);
    expect(stmts.topByTransfers.all({ limit: 10, collection: 'unknown' }).length).toBe(0);
  });
});
