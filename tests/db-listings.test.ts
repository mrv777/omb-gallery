/**
 * Integration tests for the active_listings table — the snapshot-replace
 * pattern, source-listing identity, and FK cascade behavior.
 *
 * Each test gets a fresh SQLite file and a fresh module load (via
 * vi.resetModules) because db.ts caches the connection at module level.
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

describe('poll_state v7 — backfill_unresolved_seen', () => {
  it('initializes the column at zero on fresh DB', () => {
    const db = dbModule.getDb();
    const ver = db.pragma('user_version', { simple: true });
    expect(ver).toBeGreaterThanOrEqual(7);
    const row = db
      .prepare(
        `SELECT backfill_unresolved_seen AS n FROM poll_state
         WHERE stream = 'satflow' AND collection_slug = 'omb'`
      )
      .get() as { n: number };
    expect(row.n).toBe(0);
  });

  it('persists across reads via setBackfillUnresolvedSeen', () => {
    const stmts = dbModule.getStmts();
    stmts.setBackfillUnresolvedSeen.run({ stream: 'satflow', collection: 'omb', count: 7 });
    const row1 = stmts.getPollState.get({
      stream: 'satflow',
      collection: 'omb',
    }) as { backfill_unresolved_seen: number };
    expect(row1.backfill_unresolved_seen).toBe(7);
    stmts.setBackfillUnresolvedSeen.run({ stream: 'satflow', collection: 'omb', count: 0 });
    const row2 = stmts.getPollState.get({
      stream: 'satflow',
      collection: 'omb',
    }) as { backfill_unresolved_seen: number };
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

  it('upserts by source listing identity and allows multiple markets per inscription', () => {
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

    stmts.upsertActiveListing.run({
      ...base,
      satflow_id: 'ord-1',
      marketplace: 'ord.net',
      price_sats: 1_900_000,
      refreshed_at: 1700000300,
    });
    const rows = stmts.getActiveListings.all(row.inscription_number) as Array<{
      marketplace: string;
      price_sats: number;
    }>;
    expect(rows.map(r => [r.marketplace, r.price_sats])).toEqual([
      ['ord.net', 1_900_000],
      ['satflow', 2_000_000],
    ]);
    expect((stmts.countActiveListings.get([]) as { n: number }).n).toBe(2);
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

    stmts.deleteStaleListings.run({ cutoff: 1700000102, collection: 'omb' });
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

describe('marketplace listing read model', () => {
  it('groups multi-market rows into one listing with sorted options', async () => {
    const db = dbModule.getDb();
    const stmts = dbModule.getStmts();
    const row = db
      .prepare(`SELECT inscription_number FROM inscriptions WHERE collection_slug = 'omb' LIMIT 1`)
      .get() as { inscription_number: number };

    const base = {
      inscription_number: row.inscription_number,
      inscription_id: 'c'.repeat(64) + 'i0',
      price_sats: 1_900_000,
      seller: 'bc1pseller',
      listed_at: 1700000000,
      refreshed_at: 1700000100,
    };
    stmts.upsertActiveListing.run({
      ...base,
      satflow_id: 'sf-1',
      marketplace: 'satflow',
    });
    stmts.upsertActiveListing.run({
      ...base,
      satflow_id: 'on-1',
      marketplace: 'ord.net',
      listed_at: 1700000050,
    });

    const readModel = await import('../src/lib/marketplace/listings');
    for (const sort of ['price-asc', 'price-desc', 'recent'] as const) {
      const list = readModel.getMarketplaceListings({ sort });
      expect(list.filter(item => item.inscription_number === row.inscription_number)).toHaveLength(
        1
      );
      expect(
        list.find(item => item.inscription_number === row.inscription_number)?.options
      ).toHaveLength(2);
    }

    const listing = readModel.getMarketplaceListing(row.inscription_number);
    expect(listing?.inscription_number).toBe(row.inscription_number);
    expect(listing?.marketplace).toBe('ord.net');
    expect(listing?.listing_id).toBe('on-1');
    expect(listing?.options.map(option => [option.marketplace, option.listing_id])).toEqual([
      ['ord.net', 'on-1'],
      ['satflow', 'sf-1'],
    ]);

    const satflow = readModel.getMarketplaceListing(row.inscription_number, {
      marketplace: 'satflow',
      listingId: 'sf-1',
    });
    expect(satflow?.marketplace).toBe('satflow');
    expect(satflow?.listing_id).toBe('sf-1');
    expect(
      readModel.getMarketplaceListing(row.inscription_number, {
        marketplace: 'satflow',
        listingId: 'missing',
      })
    ).toBeNull();
  });

  it('counts floor/listed stats by inscription and lite rows by grouped listing', async () => {
    const db = dbModule.getDb();
    const stmts = dbModule.getStmts();
    const rows = db
      .prepare(`SELECT inscription_number FROM inscriptions WHERE collection_slug = 'omb' LIMIT 2`)
      .all() as Array<{ inscription_number: number }>;
    const [first, second] = rows;
    if (!first || !second) throw new Error('expected seeded inscriptions');

    stmts.upsertActiveListing.run({
      inscription_number: first.inscription_number,
      inscription_id: 'd'.repeat(64) + 'i0',
      satflow_id: 'sf-first',
      price_sats: 2_000_000,
      seller: null,
      marketplace: 'satflow',
      listed_at: 1700000000,
      refreshed_at: 1700000100,
    });
    stmts.upsertActiveListing.run({
      inscription_number: first.inscription_number,
      inscription_id: 'd'.repeat(64) + 'i0',
      satflow_id: 'on-first',
      price_sats: 1_900_000,
      seller: null,
      marketplace: 'ord.net',
      listed_at: 1700000001,
      refreshed_at: 1700000200,
    });
    stmts.upsertActiveListing.run({
      inscription_number: second.inscription_number,
      inscription_id: 'e'.repeat(64) + 'i0',
      satflow_id: 'sf-second',
      price_sats: 2_200_000,
      seller: null,
      marketplace: 'satflow',
      listed_at: 1700000002,
      refreshed_at: 1700000300,
    });

    const readModel = await import('../src/lib/marketplace/listings');
    expect(readModel.getMarketplaceStats()).toMatchObject({
      floor_sats: 1_900_000,
      listed_count: 2,
      refreshed_at: 1700000300,
    });
    const lite = readModel.getMarketplaceLiteListings();
    const firstLite = lite.find(item => item.inscription_number === first.inscription_number);
    expect(firstLite).toMatchObject({
      price_sats: 1_900_000,
      marketplace: 'ord.net',
      marketplaces: ['ord.net', 'satflow'],
      listing_count: 2,
      refreshed_at: 1700000200,
    });
    expect(lite.filter(item => item.inscription_number === first.inscription_number)).toHaveLength(
      1
    );
  });
});

describe('marketplace intent source validation', () => {
  it('rejects a requested marketplace/listing_id that is not active', async () => {
    process.env.NEXT_PUBLIC_MARKETPLACE_ENABLED = 'true';
    const db = dbModule.getDb();
    const stmts = dbModule.getStmts();
    const row = db
      .prepare(`SELECT inscription_number FROM inscriptions WHERE collection_slug = 'omb' LIMIT 1`)
      .get() as { inscription_number: number };
    stmts.upsertActiveListing.run({
      inscription_number: row.inscription_number,
      inscription_id: 'f'.repeat(64) + 'i0',
      satflow_id: 'sf-active',
      price_sats: 2_000_000,
      seller: null,
      marketplace: 'satflow',
      listed_at: 1700000000,
      refreshed_at: 1700000100,
    });

    const { BUYER_COOKIE_NAME, mintBuyerSession } = await import('../src/lib/buyerSession');
    const { POST } = await import('../src/app/api/marketplace/intent/route');
    const cookie = mintBuyerSession({
      ord_addr: 'bc1pordbuyer',
      pay_addr: 'bc1qpaybuyer',
      ord_pubkey: '02'.padEnd(66, '0'),
      pay_pubkey: '03'.padEnd(66, '0'),
      accepted_terms_at: 1700000200,
    });
    if (!cookie) throw new Error('expected buyer session cookie');

    const { NextRequest } = await import('next/server');
    const req = new NextRequest('http://localhost/api/marketplace/intent', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${BUYER_COOKIE_NAME}=${cookie}`,
      },
      body: JSON.stringify({
        inscription_number: row.inscription_number,
        marketplace: 'ord.net',
        listing_id: 'missing-ord-source',
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: 'listing-stale',
    });
  });
});

describe('buy_intents schema', () => {
  it('creates buy_intents with buyer and tx indexes', () => {
    const db = dbModule.getDb();
    const tbl = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='buy_intents'`)
      .get();
    expect(tbl).toBeDefined();
    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='buy_intents'`)
      .all() as Array<{ name: string }>;
    expect(indexes.map(i => i.name)).toEqual(
      expect.arrayContaining(['idx_buy_intents_buyer', 'idx_buy_intents_txid'])
    );
  });

  it('records and updates a mock buy intent', async () => {
    const row = dbModule.getDb().prepare(`SELECT * FROM inscriptions LIMIT 1`).get() as {
      inscription_number: number;
      inscription_id: string | null;
    };
    const store = await import('../src/lib/marketplace/buyIntentsStore');
    const id = store.createBuyIntent({
      inscription_id: row.inscription_id ?? `unknown-${row.inscription_number}`,
      inscription_number: row.inscription_number,
      buyer_ord_addr: 'bc1pbuyer',
      buyer_pay_addr: 'bc1qbuyer',
      marketplace: 'satflow',
      price_sats: 1_000_000,
      is_mock: true,
    });

    store.markIntentBroadcast(id, 'mock-txid');
    const intent = store.getBuyIntent(id);
    expect(intent?.status).toBe('broadcast');
    expect(intent?.txid).toBe('mock-txid');
    expect(intent?.is_mock).toBe(1);
  });

  it('does not downgrade a broadcast intent after a late failure', async () => {
    const row = dbModule.getDb().prepare(`SELECT * FROM inscriptions LIMIT 1`).get() as {
      inscription_number: number;
      inscription_id: string | null;
    };
    const store = await import('../src/lib/marketplace/buyIntentsStore');
    const id = store.createBuyIntent({
      inscription_id: row.inscription_id ?? `unknown-${row.inscription_number}`,
      inscription_number: row.inscription_number,
      buyer_ord_addr: 'bc1pbuyer',
      buyer_pay_addr: 'bc1qbuyer',
      marketplace: 'satflow',
      price_sats: 1_000_000,
      is_mock: false,
    });

    store.markIntentSigned(id);
    store.markIntentBroadcast(id, 'real-txid');
    store.markIntentFailed(id, 'late duplicate request failed');

    const intent = store.getBuyIntent(id);
    expect(intent?.status).toBe('broadcast');
    expect(intent?.txid).toBe('real-txid');
    expect(intent?.fail_reason).toBeNull();
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
