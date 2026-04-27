/**
 * Integration tests for the active_listings table — the snapshot-replace
 * pattern, dedupe by inscription_number, and FK cascade behavior.
 *
 * Each test gets a fresh SQLite file and a fresh module load (via
 * vi.resetModules) because db.ts caches the connection at module level.
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

describe('poll_state v7 — backfill_unresolved_seen', () => {
  it('initializes the column at zero on fresh DB', () => {
    const db = dbModule.getDb();
    const ver = db.pragma('user_version', { simple: true });
    expect(ver).toBeGreaterThanOrEqual(7);
    const row = db
      .prepare(`SELECT backfill_unresolved_seen AS n FROM poll_state WHERE stream = 'satflow'`)
      .get() as { n: number };
    expect(row.n).toBe(0);
  });

  it('persists across reads via setBackfillUnresolvedSeen', () => {
    const stmts = dbModule.getStmts();
    stmts.setBackfillUnresolvedSeen.run({ stream: 'satflow', count: 7 });
    const row1 = stmts.getPollState.get('satflow') as { backfill_unresolved_seen: number };
    expect(row1.backfill_unresolved_seen).toBe(7);
    stmts.setBackfillUnresolvedSeen.run({ stream: 'satflow', count: 0 });
    const row2 = stmts.getPollState.get('satflow') as { backfill_unresolved_seen: number };
    expect(row2.backfill_unresolved_seen).toBe(0);
  });
});

describe('setInscriptionOwnerIfNewer — recency guard', () => {
  it('sets owner when last_movement_at is NULL (cold start)', () => {
    const db = dbModule.getDb();
    const stmts = dbModule.getStmts();
    const row = db.prepare(`SELECT inscription_number FROM inscriptions LIMIT 1`).get() as {
      inscription_number: number;
    };
    stmts.setInscriptionOwnerIfNewer.run({
      inscription_number: row.inscription_number,
      new_owner: 'bc1pbuyer',
      block_timestamp: 1700000100,
    });
    const after = db
      .prepare(`SELECT current_owner FROM inscriptions WHERE inscription_number = ?`)
      .get(row.inscription_number) as { current_owner: string | null };
    expect(after.current_owner).toBe('bc1pbuyer');
  });

  it('does NOT overwrite when sale is older than last_movement_at', () => {
    const db = dbModule.getDb();
    const stmts = dbModule.getStmts();
    const row = db.prepare(`SELECT inscription_number FROM inscriptions LIMIT 1`).get() as {
      inscription_number: number;
    };
    db.prepare(
      `UPDATE inscriptions SET current_owner = 'bc1precent', last_movement_at = 1700000200 WHERE inscription_number = ?`
    ).run(row.inscription_number);
    stmts.setInscriptionOwnerIfNewer.run({
      inscription_number: row.inscription_number,
      new_owner: 'bc1pancient',
      block_timestamp: 1700000100, // older than last_movement_at
    });
    const after = db
      .prepare(`SELECT current_owner FROM inscriptions WHERE inscription_number = ?`)
      .get(row.inscription_number) as { current_owner: string };
    expect(after.current_owner).toBe('bc1precent');
  });

  it('overwrites when sale is at or after last_movement_at', () => {
    const db = dbModule.getDb();
    const stmts = dbModule.getStmts();
    const row = db.prepare(`SELECT inscription_number FROM inscriptions LIMIT 1`).get() as {
      inscription_number: number;
    };
    db.prepare(
      `UPDATE inscriptions SET current_owner = 'bc1pold', last_movement_at = 1700000200 WHERE inscription_number = ?`
    ).run(row.inscription_number);
    stmts.setInscriptionOwnerIfNewer.run({
      inscription_number: row.inscription_number,
      new_owner: 'bc1pnewest',
      block_timestamp: 1700000300,
    });
    const after = db
      .prepare(`SELECT current_owner FROM inscriptions WHERE inscription_number = ?`)
      .get(row.inscription_number) as { current_owner: string };
    expect(after.current_owner).toBe('bc1pnewest');
  });

  it('skips when new_owner is null (defensive)', () => {
    const db = dbModule.getDb();
    const stmts = dbModule.getStmts();
    const row = db.prepare(`SELECT inscription_number FROM inscriptions LIMIT 1`).get() as {
      inscription_number: number;
    };
    db.prepare(
      `UPDATE inscriptions SET current_owner = 'bc1pkeep' WHERE inscription_number = ?`
    ).run(row.inscription_number);
    stmts.setInscriptionOwnerIfNewer.run({
      inscription_number: row.inscription_number,
      new_owner: null,
      block_timestamp: 1700000999,
    });
    const after = db
      .prepare(`SELECT current_owner FROM inscriptions WHERE inscription_number = ?`)
      .get(row.inscription_number) as { current_owner: string };
    expect(after.current_owner).toBe('bc1pkeep');
  });
});

describe('active_listings schema + statements', () => {
  it('creates the active_listings table at v6 or higher', () => {
    const db = dbModule.getDb();
    const ver = db.pragma('user_version', { simple: true });
    expect(ver).toBeGreaterThanOrEqual(6);
    const tbl = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='active_listings'`)
      .get();
    expect(tbl).toBeDefined();
  });

  it('upserts and replaces by inscription_number PK', () => {
    const db = dbModule.getDb();
    const stmts = dbModule.getStmts();
    const row = db.prepare(`SELECT inscription_number FROM inscriptions LIMIT 1`).get() as {
      inscription_number: number;
    };

    const base = {
      inscription_number: row.inscription_number,
      inscription_id: 'a'.repeat(64) + 'i0',
      satflow_id: 'sat-1',
      price_sats: 1_000_000,
      seller: 'bc1pseller',
      marketplace: 'satflow',
      listed_at: 1700000000,
      refreshed_at: 1700000100,
    };
    stmts.upsertActiveListing.run(base);
    expect((stmts.countActiveListings.get([]) as { n: number }).n).toBe(1);

    stmts.upsertActiveListing.run({ ...base, price_sats: 2_000_000, refreshed_at: 1700000200 });
    const row2 = stmts.getActiveListing.get(row.inscription_number) as {
      price_sats: number;
      refreshed_at: number;
    };
    expect(row2.price_sats).toBe(2_000_000);
    expect(row2.refreshed_at).toBe(1700000200);
    expect((stmts.countActiveListings.get([]) as { n: number }).n).toBe(1);
  });

  it('deleteStaleListings removes rows older than the cutoff', () => {
    const db = dbModule.getDb();
    const stmts = dbModule.getStmts();
    const rows = db.prepare(`SELECT inscription_number FROM inscriptions LIMIT 3`).all() as Array<{
      inscription_number: number;
    }>;

    rows.forEach((r, i) => {
      stmts.upsertActiveListing.run({
        inscription_number: r.inscription_number,
        inscription_id: String(i).repeat(64) + 'i0',
        satflow_id: `sat-${i}`,
        price_sats: 1_000_000 + i,
        seller: null,
        marketplace: 'satflow',
        listed_at: 1700000000,
        refreshed_at: 1700000100 + i,
      });
    });
    expect((stmts.countActiveListings.get([]) as { n: number }).n).toBe(3);

    stmts.deleteStaleListings.run({ cutoff: 1700000102 });
    expect((stmts.countActiveListings.get([]) as { n: number }).n).toBe(1);
  });

  it('cascades delete when the parent inscription is removed', () => {
    const db = dbModule.getDb();
    const stmts = dbModule.getStmts();
    const row = db.prepare(`SELECT inscription_number FROM inscriptions LIMIT 1`).get() as {
      inscription_number: number;
    };

    stmts.upsertActiveListing.run({
      inscription_number: row.inscription_number,
      inscription_id: 'b'.repeat(64) + 'i0',
      satflow_id: 'sat-x',
      price_sats: 1_000_000,
      seller: null,
      marketplace: 'satflow',
      listed_at: 1700000000,
      refreshed_at: 1700000100,
    });
    expect((stmts.countActiveListings.get([]) as { n: number }).n).toBe(1);

    db.prepare(`DELETE FROM inscriptions WHERE inscription_number = ?`).run(row.inscription_number);
    expect((stmts.countActiveListings.get([]) as { n: number }).n).toBe(0);
  });
});

describe('satflow_call_budget', () => {
  it('starts at zero and increments per bump', () => {
    const stmts = dbModule.getStmts();
    const initial = stmts.getSatflowCallBudget.get([]) as { call_count: number };
    expect(initial.call_count).toBe(0);
    stmts.bumpSatflowCallCount.run([]);
    stmts.bumpSatflowCallCount.run([]);
    stmts.bumpSatflowCallCount.run([]);
    const after = stmts.getSatflowCallBudget.get([]) as { call_count: number };
    expect(after.call_count).toBe(3);
  });

  it('resets to zero with a fresh window_start', () => {
    const stmts = dbModule.getStmts();
    stmts.bumpSatflowCallCount.run([]);
    const before = stmts.getSatflowCallBudget.get([]) as {
      window_start: number;
      call_count: number;
    };
    stmts.resetSatflowCallBudget.run([]);
    const after = stmts.getSatflowCallBudget.get([]) as {
      window_start: number;
      call_count: number;
    };
    expect(after.call_count).toBe(0);
    expect(after.window_start).toBeGreaterThanOrEqual(before.window_start);
  });
});
