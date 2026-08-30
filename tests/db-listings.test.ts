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
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_MARKETPLACE_ENABLED;
  delete process.env.SATFLOW_API_KEY;
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

describe('poll_state writer lease', () => {
  it('blocks overlap but clears immediately after a completed tick', () => {
    const stmts = dbModule.getStmts();
    expect(stmts.acquireLock.run({ stream: 'ord', collection: 'omb' }).changes).toBe(1);
    expect(stmts.acquireLock.run({ stream: 'ord', collection: 'omb' }).changes).toBe(0);
    stmts.setPollResult.run({
      stream: 'ord',
      collection: 'omb',
      status: 'ok',
      event_count: 0,
      cursor: null,
    });
    expect(stmts.acquireLock.run({ stream: 'ord', collection: 'omb' }).changes).toBe(1);
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

  it('source-scoped replacement preserves another marketplace snapshot', () => {
    const db = dbModule.getDb();
    const stmts = dbModule.getStmts();
    const row = db.prepare(`SELECT inscription_number FROM inscriptions LIMIT 1`).get() as {
      inscription_number: number;
    };
    const base = {
      inscription_number: row.inscription_number,
      inscription_id: 'e'.repeat(64) + 'i0',
      price_sats: 1_000_000,
      seller: 'bc1pseller',
      listed_at: 1700000000,
      refreshed_at: 100,
    };
    stmts.upsertActiveListing.run({ ...base, satflow_id: 'sat-1', marketplace: 'satflow' });
    stmts.upsertActiveListing.run({ ...base, satflow_id: 'ord-1', marketplace: 'ord.net' });

    stmts.deleteStaleListingsForMarketplace.run({
      cutoff: 101,
      collection: 'omb',
      marketplace: 'satflow',
    });
    const remaining = stmts.getActiveListings.all(row.inscription_number) as Array<{
      marketplace: string;
    }>;
    expect(remaining.map(r => r.marketplace)).toEqual(['ord.net']);
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

describe('ord.net staged snapshots and seller intents', () => {
  it('seeds an independent poll stream and stages a scan generation', () => {
    const db = dbModule.getDb();
    const stmts = dbModule.getStmts();
    expect(stmts.getPollState.get({ stream: 'ordnet_listings', collection: 'omb' })).toBeDefined();

    stmts.upsertListingSnapshotStage.run({
      stream: 'ordnet_listings',
      collection: 'omb',
      scan_id: 'scan-1',
      marketplace: 'ord.net',
      source_id: 'listing-1',
      inscription_id: 'f'.repeat(64) + 'i0',
      price_sats: 123_456,
      seller: 'bc1pseller',
      listed_at: 1700000000,
      raw_json: '{}',
    });
    expect(
      stmts.countListingSnapshotStage.get({
        stream: 'ordnet_listings',
        collection: 'omb',
        scan_id: 'scan-1',
      })
    ).toEqual({ n: 1 });
    stmts.setPollResultExactCursor.run({
      stream: 'ordnet_listings',
      collection: 'omb',
      status: 'staging',
      event_count: 1,
      cursor: JSON.stringify({ scan_id: 'scan-1', next_cursor: 'page-2' }),
    });
    expect(stmts.getPollState.get({ stream: 'ordnet_listings', collection: 'omb' })).toMatchObject({
      last_status: 'staging',
      last_event_count: 1,
    });
    stmts.setPollResultExactCursor.run({
      stream: 'ordnet_listings',
      collection: 'omb',
      status: 'ok',
      event_count: 1,
      cursor: null,
    });
    expect(stmts.getPollState.get({ stream: 'ordnet_listings', collection: 'omb' })).toMatchObject({
      last_status: 'ok',
      last_cursor: null,
    });
    stmts.clearListingSnapshotStage.run({ stream: 'ordnet_listings', collection: 'omb' });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM listing_snapshot_stage`).get()).toEqual({ n: 0 });
  });

  it('creates the durable listing_intents contract without signed PSBT storage', () => {
    const db = dbModule.getDb();
    const columns = db.pragma('table_info(listing_intents)') as Array<{ name: string }>;
    const names = columns.map(column => column.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'id',
        'seller_ord_addr',
        'seller_pay_addr',
        'inscription_id',
        'inscription_number',
        'current_output',
        'price_sats',
        'duration_days',
        'provider_id',
        'wallet_binding_id',
        'anchor_utxo_id',
        'preflight_json',
        'unsigned_psbt_hashes_json',
        'status',
        'listing_id',
        'claim_token',
        'claimed_at',
        'error',
        'created_at',
        'updated_at',
      ])
    );
    expect(names).not.toContain('signed_psbts_json');
  });

  it('blocks another preflight while an active or ambiguous intent exists', () => {
    const db = dbModule.getDb();
    const row = db.prepare(`SELECT inscription_number FROM inscriptions LIMIT 1`).get() as {
      inscription_number: number;
    };
    const insert = db.prepare(`
      INSERT INTO listing_intents (
        seller_ord_addr, seller_pay_addr, inscription_id, inscription_number,
        current_output, price_sats, duration_days, provider_id, wallet_binding_id,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 90, 'drey', ?, ?, unixepoch(), unixepoch())
    `);
    const inscriptionId = '9'.repeat(64) + 'i0';
    insert.run(
      'bc1pseller',
      'bc1qpayment',
      inscriptionId,
      row.inscription_number,
      'a'.repeat(64) + ':0',
      1_000_000,
      'binding-1',
      'active'
    );
    expect(() =>
      insert.run(
        'bc1pseller',
        'bc1qpayment',
        inscriptionId,
        row.inscription_number,
        'a'.repeat(64) + ':0',
        2_000_000,
        'binding-1',
        'created'
      )
    ).toThrow();

    db.prepare(`UPDATE listing_intents SET status = 'failed' WHERE inscription_id = ?`).run(
      inscriptionId
    );
    expect(() =>
      insert.run(
        'bc1pseller',
        'bc1qpayment',
        inscriptionId,
        row.inscription_number,
        'a'.repeat(64) + ':0',
        2_000_000,
        'binding-1',
        'ambiguous'
      )
    ).not.toThrow();
    expect(() =>
      insert.run(
        'bc1pseller',
        'bc1qpayment',
        inscriptionId,
        row.inscription_number,
        'a'.repeat(64) + ':0',
        3_000_000,
        'binding-1',
        'created'
      )
    ).toThrow();
  });

  it('lets a fresh preflight replace an abandoned unsigned intent', async () => {
    const db = dbModule.getDb();
    const row = db.prepare(`SELECT inscription_number FROM inscriptions LIMIT 1`).get() as {
      inscription_number: number;
    };
    const inscriptionId = '7'.repeat(64) + 'i0';
    db.prepare(
      `UPDATE inscriptions
       SET inscription_id = ?, current_owner = 'bc1pseller', current_output = ?
       WHERE inscription_number = ?`
    ).run(inscriptionId, 'a'.repeat(64) + ':0', row.inscription_number);
    const store = await import('../src/lib/marketplace/listingIntentsStore');
    const preflight = {
      v: 1 as const,
      collectionSlug: 'omb',
      request: {
        walletBindingId: 'binding-1',
        ordinalsPublicKey: '02'.padEnd(66, '1'),
        items: [{ inscriptionId, priceSats: 1_000_000 }],
      },
      response: {
        listings: [
          {
            inscriptionId,
            anchorUtxoId: 'anchor-1',
            psbts: [],
          },
        ],
        recoveryPsbt: { signerAddress: 'bc1pseller', inputsToSign: [], psbtBase64: 'recovery' },
      },
      durationDays: 90 as const,
      createdAt: 1_700_000_000,
    };
    const args = {
      sellerOrdAddr: 'bc1pseller',
      sellerPayAddr: 'bc1qpayment',
      inscriptionId,
      inscriptionNumber: row.inscription_number,
      currentOutput: 'a'.repeat(64) + ':0',
      priceSats: 1_000_000,
      durationDays: 90 as const,
      providerId: 'xverse' as const,
      walletBindingId: 'binding-1',
      preflight,
      unsignedPsbtHashes: ['one', 'two', 'three'],
    };
    const first = store.createListingIntent(args);
    expect(
      store.listSellerOmbs({ sellerOrdAddr: 'bc1pseller', limit: 100 }).items[0]
    ).toMatchObject({ listable: true, listing_intent_status: 'created' });
    const second = store.createListingIntent({ ...args, priceSats: 2_000_000 });
    expect(second).not.toBe(first);
    expect(
      db
        .prepare(
          `SELECT id, status, preflight_json, unsigned_psbt_hashes_json
         FROM listing_intents WHERE inscription_id = ? ORDER BY id`
        )
        .all(inscriptionId)
    ).toEqual([
      {
        id: first,
        status: 'stale',
        preflight_json: null,
        unsigned_psbt_hashes_json: null,
      },
      {
        id: second,
        status: 'created',
        preflight_json: JSON.stringify(preflight),
        unsigned_psbt_hashes_json: JSON.stringify(['one', 'two', 'three']),
      },
    ]);
  });

  it('terminalizes only absent, pre-scan intents after a complete snapshot', () => {
    const db = dbModule.getDb();
    const stmts = dbModule.getStmts();
    const row = db.prepare(`SELECT inscription_number FROM inscriptions LIMIT 1`).get() as {
      inscription_number: number;
    };
    const insert = db.prepare(`
      INSERT INTO listing_intents (
        seller_ord_addr, seller_pay_addr, inscription_id, inscription_number,
        current_output, price_sats, duration_days, provider_id, wallet_binding_id,
        status, listing_id, created_at, updated_at
      ) VALUES ('seller', 'payment', ?, ?, 'tx:0', 1000000, 90, 'drey',
                'binding', ?, ?, 1, ?)
    `);
    insert.run('present', row.inscription_number, 'active', 'listing-present', 1000);
    insert.run('gone', row.inscription_number, 'active', 'listing-gone', 1000);
    insert.run('ambiguous-old', row.inscription_number, 'ambiguous', null, 1000);
    insert.run('pending-fresh', row.inscription_number, 'pending_indexing', null, 1900);
    stmts.upsertListingSnapshotStage.run({
      stream: 'ordnet_listings',
      collection: 'omb',
      scan_id: 'reconcile-scan',
      marketplace: 'ord.net',
      source_id: 'listing-present',
      inscription_id: 'present',
      price_sats: 1_000_000,
      seller: 'seller',
      listed_at: 1,
      raw_json: '{}',
    });

    const result = stmts.reconcileListingIntentsAfterSnapshot.run({
      collection: 'omb',
      scan_id: 'reconcile-scan',
      scan_started_at: 2000,
    });
    expect(result.changes).toBe(2);
    expect(
      db.prepare(`SELECT inscription_id, status FROM listing_intents ORDER BY id`).all()
    ).toEqual([
      { inscription_id: 'present', status: 'active' },
      { inscription_id: 'gone', status: 'delisted' },
      { inscription_id: 'ambiguous-old', status: 'stale' },
      { inscription_id: 'pending-fresh', status: 'pending_indexing' },
    ]);
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
      price_sats: 1_915_000,
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
    expect(listing?.price_sats).toBe(1_915_000);
    expect(listing?.estimated_buyer_total_sats).toBe(1_943_725);
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
    expect(satflow?.estimated_buyer_total_sats).toBe(1_947_500);
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
      estimated_buyer_fee_sats: 28_500,
      estimated_buyer_total_sats: 1_928_500,
      buyer_fee_bps: 150,
    });
    expect(lite.filter(item => item.inscription_number === first.inscription_number)).toHaveLength(
      1
    );
  });

  it('sorts grouped listings by estimated buyer total', async () => {
    const db = dbModule.getDb();
    const stmts = dbModule.getStmts();
    const rows = db
      .prepare(`SELECT inscription_number FROM inscriptions WHERE collection_slug = 'omb' LIMIT 2`)
      .all() as Array<{ inscription_number: number }>;
    const [satflowRawLow, ordnetRawHigh] = rows;
    if (!satflowRawLow || !ordnetRawHigh) throw new Error('expected seeded inscriptions');

    stmts.upsertActiveListing.run({
      inscription_number: satflowRawLow.inscription_number,
      inscription_id: 'a'.repeat(64) + 'i0',
      satflow_id: 'sf-raw-low',
      price_sats: 1_000_000,
      seller: null,
      marketplace: 'satflow',
      listed_at: 1700000000,
      refreshed_at: 1700000100,
    });
    stmts.upsertActiveListing.run({
      inscription_number: ordnetRawHigh.inscription_number,
      inscription_id: 'b'.repeat(64) + 'i0',
      satflow_id: 'on-raw-high',
      price_sats: 1_005_000,
      seller: null,
      marketplace: 'ord.net',
      listed_at: 1700000001,
      refreshed_at: 1700000100,
    });

    const readModel = await import('../src/lib/marketplace/listings');
    expect(
      readModel.getMarketplaceListings({ sort: 'price-asc' }).map(row => row.inscription_number)
    ).toEqual([ordnetRawHigh.inscription_number, satflowRawLow.inscription_number]);
    expect(
      readModel.getMarketplaceListings({ sort: 'price-desc' }).map(row => row.inscription_number)
    ).toEqual([satflowRawLow.inscription_number, ordnetRawHigh.inscription_number]);
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

  it('returns exact Satflow quote fields when the buy API exposes them in an error', async () => {
    process.env.NEXT_PUBLIC_MARKETPLACE_ENABLED = 'true';
    process.env.SATFLOW_API_KEY = 'test-key';
    const db = dbModule.getDb();
    const stmts = dbModule.getStmts();
    const row = db
      .prepare(`SELECT inscription_number FROM inscriptions WHERE collection_slug = 'omb' LIMIT 1`)
      .get() as { inscription_number: number };
    stmts.upsertActiveListing.run({
      inscription_number: row.inscription_number,
      inscription_id: 'a'.repeat(64) + 'i0',
      satflow_id: 'sf-active',
      price_sats: 1_750_000,
      seller: null,
      marketplace: 'satflow',
      listed_at: 1700000000,
      refreshed_at: 1700000100,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            success: false,
            error:
              'Not enough spendable funds.\n\nSpendable funds: 0.01187687 BTC\nNetwork fees: 0.00000428 BTC\nTotal required: 0.01796465 BTC',
          }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        );
      })
    );

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
        marketplace: 'satflow',
        listing_id: 'sf-active',
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      quote: {
        marketplace: 'satflow',
        spendable_funds_sats: 1_187_687,
        network_fee_sats: 428,
        total_required_sats: 1_796_465,
      },
    });
  });
});

describe('buy_intents schema', () => {
  it('upgrades v44 claims, leases, and the legacy active-sale lock', async () => {
    const db = dbModule.getDb();
    const inscription = db.prepare(`SELECT inscription_number FROM inscriptions LIMIT 1`).get() as {
      inscription_number: number;
    };
    db.prepare(
      `INSERT INTO community_campaigns (
         id, inscription_number, inscription_id, current_outpoint, source, ownership_mode,
         eligibility_mode, creator_owner_id, status, terms_version, landed_cost_sats,
         max_landed_cost_sats, source_fingerprint, opened_at, expires_at, cap_table_version,
         created_at, updated_at
       ) VALUES (
         'migration-campaign', ?, 'migration-inscription', 'migration:0', 'creator-fronted',
         'open', 'anyone', 'creator', 'held', 'terms', 1000, 1000, 'fingerprint',
         1, 9999999999, 1, 1, 1
       )`
    ).run(inscription.inscription_number);
    db.prepare(
      `INSERT INTO community_sales (
         campaign_id, offer_digest, plan_json, preflight_json, signing_psbt_hex,
         status, expires_at_ms, created_at, updated_at
       ) VALUES ('migration-campaign', 'migration-offer', '{}', '{}', '00', 'signing',
                 9999999999000, 1, 1)`
    ).run();
    db.exec(`
      ALTER TABLE buy_intents DROP COLUMN broadcast_claim_token;
      ALTER TABLE buy_intents DROP COLUMN broadcast_claimed_at;
      ALTER TABLE poll_state DROP COLUMN lock_until;
    `);
    db.pragma('user_version = 44');
    db.close();

    vi.resetModules();
    dbModule = await import('../src/lib/db');
    const upgraded = dbModule.getDb();
    expect(upgraded.pragma('user_version', { simple: true })).toBe(46);
    expect(
      (upgraded.prepare(`PRAGMA table_info(buy_intents)`).all() as Array<{ name: string }>).map(
        column => column.name
      )
    ).toEqual(expect.arrayContaining(['broadcast_claim_token', 'broadcast_claimed_at']));
    expect(
      (upgraded.prepare(`PRAGMA table_info(poll_state)`).all() as Array<{ name: string }>).map(
        column => column.name
      )
    ).toContain('lock_until');
    expect(
      upgraded
        .prepare(
          `SELECT active_operation_kind, active_operation_id
           FROM community_campaigns WHERE id = 'migration-campaign'`
        )
        .get()
    ).toEqual({ active_operation_kind: 'sale', active_operation_id: 'migration-campaign' });
  });

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

  it('allows only one broadcast claim and makes completion token-aware', async () => {
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

    expect(store.claimIntentBroadcast(id, 'claim-a')).toBe(true);
    expect(store.claimIntentBroadcast(id, 'claim-b')).toBe(false);
    expect(store.completeIntentBroadcast(id, 'claim-b', 'wrong-tx')).toBe(false);
    expect(store.completeIntentBroadcast(id, 'claim-a', 'real-tx')).toBe(true);
    expect(store.getBuyIntent(id)).toMatchObject({
      status: 'broadcast',
      txid: 'real-tx',
      broadcast_claim_token: null,
    });
  });

  it('reclaims a stale broadcast claim without letting the old owner finish', async () => {
    const row = dbModule.getDb().prepare(`SELECT * FROM inscriptions LIMIT 1`).get() as {
      inscription_number: number;
      inscription_id: string | null;
    };
    const store = await import('../src/lib/marketplace/buyIntentsStore');
    const id = store.createBuyIntent({
      inscription_id: row.inscription_id ?? `unknown-${row.inscription_number}`,
      inscription_number: row.inscription_number,
      buyer_ord_addr: 'bc1pbuyer',
      buyer_pay_addr: null,
      marketplace: 'satflow',
      price_sats: 1_000_000,
      is_mock: false,
    });
    expect(store.claimIntentBroadcast(id, 'old-claim')).toBe(true);
    dbModule
      .getDb()
      .prepare(`UPDATE buy_intents SET broadcast_claimed_at = unixepoch() - 999 WHERE id = ?`)
      .run(id);
    expect(store.claimIntentBroadcast(id, 'new-claim')).toBe(true);
    expect(store.completeIntentBroadcast(id, 'old-claim', 'old-tx')).toBe(false);
    expect(store.completeIntentBroadcast(id, 'new-claim', 'new-tx')).toBe(true);
    expect(store.getBuyIntent(id)?.txid).toBe('new-tx');
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
