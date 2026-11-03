import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  BRAVOCADO_DISPENSARY_ADDRESS as DISPENSARY,
  BRAVOCADO_RESERVE_ADDRESS as RESERVE,
  GREEN_MINT_ADDRESS,
  lookupWalletLabel,
} from '@/lib/walletLabels';

const rpc = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/bitcoind', () => ({
  bitcoindConfigured: () => true,
  getRawTransaction: rpc.get,
}));

const RECIPIENT = 'bc1par35npz8zw22c6ncyzqyhc74kufwavrvhdxn59auk8gk8n3mu8mq6v56rl';
const USER = '06727c41-ea57-4f23-98b2-cf779742e00a';
let dir: string;
let dbModule: typeof import('@/lib/db');
let clusters: typeof import('@/lib/clusterStore');
let staging: typeof import('@/lib/listingStagingStore');
let holders: typeof import('@/lib/holderEvents');

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'omb-distribution-identity-'));
  vi.stubEnv('OMB_DB_PATH', path.join(dir, 'test.db'));
  vi.resetModules();
  rpc.get.mockReset();
  dbModule = await import('@/lib/db');
  clusters = await import('@/lib/clusterStore');
  staging = await import('@/lib/listingStagingStore');
  holders = await import('@/lib/holderEvents');
  const db = dbModule.getDb();
  db.prepare('INSERT INTO matrica_users (user_id, username, updated_at) VALUES (?, ?, 0)').run(
    USER,
    'jimmyphage69'
  );
  db.prepare(
    'INSERT INTO wallet_links (wallet_addr, matrica_user_id, checked_at) VALUES (?, ?, 0)'
  ).run(RECIPIENT, USER);
});

afterEach(() => {
  dbModule.getDb().close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

// The two confirmed dispensary distributions and subsequent listing times.
function seedQuickListings(source: string, seller = RECIPIENT) {
  const db = dbModule.getDb();
  const insert = db.prepare(`
    INSERT INTO events (inscription_id, inscription_number, event_type, txid,
      old_owner, new_owner, block_timestamp, marketplace)
    VALUES (@id, @number, @type, @txid, @old, @new, @ts, @marketplace)
  `);
  for (const [number, ts, gap, txid] of [
    [
      64631640,
      1781954275,
      8375,
      '5fa64e789d53273103f8ead2d0b7cf700ec44e59d59bc8c69c193790885be71c',
    ],
    [
      64631655,
      1784366501,
      1859,
      '4ff7b75e25473ed83387635f9740963c7bc7af2fc0f8608b16faa860fe8ac6b3',
    ],
  ] as const) {
    const { inscription_id: id } = db
      .prepare('SELECT inscription_id FROM inscriptions WHERE inscription_number = ?')
      .get(number) as { inscription_id: string };
    insert.run({
      id,
      number,
      type: 'transferred',
      txid,
      old: source,
      new: seller,
      ts,
      marketplace: null,
    });
    insert.run({
      id,
      number,
      type: 'listed',
      txid: `listed:${number}`,
      old: seller,
      new: null,
      ts: ts + gap,
      marketplace: 'satflow',
    });
  }
}

function insertClusterEdge(a: string, b: string) {
  const [first, second] = [a, b].sort();
  dbModule
    .getDb()
    .prepare(
      `
    INSERT INTO wallet_cluster_edges (addr_a, addr_b, confidence, cih_count,
      first_seen_at, last_seen_at) VALUES (?, ?, 9900, 5, 0, 0)
  `
    )
    .run(first, second);
}

function ownedCount(address: string) {
  const { wallets } = holders.resolveAggregatedWallets(address);
  return wallets.reduce(
    (n, owner) =>
      n +
      dbModule.getStmts().getInscriptionsByOwner.all({
        owner,
        collection: 'bravocados',
      }).length,
    0
  );
}

describe('distribution wallets cannot become inferred identities', () => {
  it('keeps the recipient at 1 Bravocado and the dispensary at 21 after the reported quick listings', () => {
    const db = dbModule.getDb();
    const numbers = db
      .prepare(
        `SELECT inscription_number FROM inscriptions
      WHERE collection_slug = 'bravocados' ORDER BY inscription_number LIMIT 22`
      )
      .all() as Array<{ inscription_number: number }>;
    const update = db.prepare(`UPDATE inscriptions SET current_owner = ?, effective_owner = ?
      WHERE inscription_number = ?`);
    numbers.forEach(({ inscription_number }, i) => {
      const owner = i === 0 ? RECIPIENT : DISPENSARY;
      update.run(owner, owner, inscription_number);
    });
    seedQuickListings(DISPENSARY);
    const result = staging.runListingStagingRecompute();
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ eligible_edges: 0, suppressed_blacklist: 1 });
    expect(ownedCount(RECIPIENT)).toBe(1);
    expect(ownedCount(DISPENSARY)).toBe(21);
    expect(holders.resolveCanonicalHolderAddress(DISPENSARY)).toBeNull();
    expect(holders.resolveAggregatedWallets(RECIPIENT).wallets).toEqual([RECIPIENT]);
    expect(staging.getListingStagingLinksForWallets([RECIPIENT])).toEqual([]);
  });

  it.each([DISPENSARY, RESERVE, GREEN_MINT_ADDRESS])(
    'suppresses quick-listing evidence with distribution endpoint %s in either direction',
    wallet => {
      seedQuickListings(wallet);
      expect(staging.runListingStagingRecompute()).toMatchObject({
        eligible_edges: 0,
        suppressed_blacklist: 1,
      });
      dbModule.getDb().exec(`DELETE FROM events; UPDATE poll_state SET last_run_at = 0
        WHERE stream = 'listing_staging'`);
      seedQuickListings('ordinary-source', wallet);
      expect(staging.runListingStagingRecompute()).toMatchObject({
        eligible_edges: 0,
        suppressed_blacklist: 1,
      });
    }
  );

  it('still folds ordinary repeated listing-staging links and preserves confirmed Matrica siblings', () => {
    dbModule
      .getDb()
      .prepare(
        `INSERT INTO wallet_links
      (wallet_addr, matrica_user_id, checked_at) VALUES ('confirmed-sibling', ?, 0)`
      )
      .run(USER);
    seedQuickListings('ordinary-source');
    expect(staging.runListingStagingRecompute()).toMatchObject({ eligible_edges: 1 });
    expect(holders.resolveAggregatedWallets(RECIPIENT)).toMatchObject({
      wallets: expect.arrayContaining([RECIPIENT, 'confirmed-sibling', 'ordinary-source']),
      inferredWallets: ['ordinary-source'],
    });
  });

  it('removes stale staging merges and prevents strong edges from bridging people through distribution wallets', () => {
    seedQuickListings(DISPENSARY);
    staging.runListingStagingRecompute();
    // Simulate the pre-fix persisted eligible edge and materialized identity.
    dbModule.getDb().exec(`UPDATE wallet_staging_edges SET eligible_for_fold = 1,
      suppression_reason = NULL`);
    for (const wallet of [RECIPIENT, DISPENSARY]) {
      dbModule
        .getDb()
        .prepare(
          `INSERT OR REPLACE INTO cluster_anchors
        (wallet_addr, anchor_id, matrica_user_id, cluster_size) VALUES (?, ?, ?, 2)`
        )
        .run(wallet, USER, USER);
    }
    insertClusterEdge(RECIPIENT, RESERVE);
    insertClusterEdge(RESERVE, 'unrelated-holder');
    insertClusterEdge(RECIPIENT, GREEN_MINT_ADDRESS);
    insertClusterEdge('ordinary-a', 'ordinary-b');
    expect(clusters.recomputeClusterAnchors()).toMatchObject({ components: 1, members: 2 });
    expect(holders.resolveAggregatedWallets(RECIPIENT).wallets).toEqual([RECIPIENT]);
    expect(holders.resolveCanonicalHolderAddress(DISPENSARY)).toBeNull();
    expect(clusters.getClusterMembersForAddress(RESERVE)).toEqual([RESERVE]);
    expect(clusters.getClusterMembersForAddress('ordinary-a')).toEqual([
      'ordinary-a',
      'ordinary-b',
    ]);
  });

  it('does not infer shared control from co-spending a dispensary input during the live tick', async () => {
    seedQuickListings(DISPENSARY);
    dbModule.getDb().exec(`UPDATE events SET created_at = 0;
      UPDATE poll_state SET last_cursor = '0' WHERE stream = 'cluster'`);
    rpc.get.mockResolvedValue({
      txid: 'fixture',
      vin: [DISPENSARY, 'payment-wallet'].map(address => ({
        prevout: { scriptPubKey: { address } },
      })),
      vout: [],
    });
    expect(await clusters.runClusterTick()).toMatchObject({ scanned: 2, edges_touched: 0 });
    expect(rpc.get).toHaveBeenCalled();
    expect(dbModule.getDb().prepare('SELECT * FROM wallet_cluster_edges').all()).toEqual([]);
  });

  it('does not link unrelated recipients via a distribution parent in the global recompute', () => {
    const db = dbModule.getDb();
    seedQuickListings(DISPENSARY);
    db.prepare(
      `UPDATE events SET new_owner = 'another-recipient'
      WHERE inscription_number = 64631655 AND event_type = 'transferred'`
    ).run();
    expect(clusters.runClusterRecompute()).toMatchObject({ cp_bumps: 0, edges_written: 0 });
    // Same topology for an ordinary parent still supplies co-parent evidence.
    db.prepare(
      `UPDATE events SET old_owner = 'ordinary-parent'
      WHERE event_type = 'transferred'`
    ).run();
    expect(clusters.runClusterRecompute()).toMatchObject({ cp_bumps: 1, edges_written: 1 });
  });

  it('keeps the host-side backfill from restoring stale distribution merges', () => {
    seedQuickListings(DISPENSARY);
    staging.runListingStagingRecompute();
    dbModule.getDb().exec(`UPDATE wallet_staging_edges SET eligible_for_fold = 1,
      suppression_reason = NULL`);
    insertClusterEdge(RESERVE, RECIPIENT);
    insertClusterEdge('ordinary-a', 'ordinary-b');
    execFileSync(
      process.execPath,
      [path.resolve('scripts/backfill-cluster.js'), `--cache-dir=${dir}`],
      { env: { ...process.env }, stdio: 'pipe' }
    );
    expect(holders.resolveAggregatedWallets(RECIPIENT).wallets).toEqual([RECIPIENT]);
    expect(holders.resolveCanonicalHolderAddress(DISPENSARY)).toBeNull();
    expect(clusters.getClusterMembersForAddress(RESERVE)).toEqual([RESERVE]);
    expect(clusters.getClusterMembersForAddress('ordinary-a')).toEqual([
      'ordinary-a',
      'ordinary-b',
    ]);
  });

  it('retains the confirmed dispensary and reserve labels', () => {
    expect(lookupWalletLabel(DISPENSARY)).toEqual({
      name: 'Bravocados Dispensary',
      subtitle: 'Parasite pool rewards',
    });
    expect(lookupWalletLabel(RESERVE)).toEqual({ name: 'Bravocados Reserve' });
  });
});
