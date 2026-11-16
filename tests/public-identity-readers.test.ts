import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let dbModule: typeof import('../src/lib/db');
let identities: typeof import('../src/lib/publicIdentityStore');
let holders: typeof import('../src/lib/holderEvents');
let roles: typeof import('../src/lib/rolesStore');
let overlay: typeof import('../src/lib/matricaOverlay');
let tempDir: string;
const WALLET_A = 'bc1p-public-a';
const WALLET_B = 'bc1p-public-b';
const WALLET_C = 'bc1p-public-c';

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-public-readers-'));
  vi.stubEnv('OMB_DB_PATH', path.join(tempDir, 'app.db'));
  vi.resetModules();
  dbModule = await import('../src/lib/db');
  identities = await import('../src/lib/publicIdentityStore');
  holders = await import('../src/lib/holderEvents');
  roles = await import('../src/lib/rolesStore');
  overlay = await import('../src/lib/matricaOverlay');
  const db = dbModule.getDb();
  db.prepare(`UPDATE inscriptions SET current_owner = NULL, effective_owner = NULL`).run();
  const insert =
    db.prepare(`INSERT INTO inscriptions (inscription_number, color, current_owner, effective_owner, collection_slug)
    VALUES (?, ?, ?, ?, 'omb')`);
  insert.run(-1, 'red', WALLET_A, WALLET_A);
  insert.run(-2, 'blue', WALLET_B, WALLET_B);
  insert.run(-3, 'green', WALLET_C, WALLET_C);
});

afterEach(() => {
  dbModule.getDb().close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function share(walletAddress: string, username: string | null = 'nexus-holder') {
  identities.shareOrdnetIdentity({
    walletAddress,
    profile: { id: 'ord-profile', username, avatarUrl: null },
    walletBindings: [
      {
        walletBindingId: 'binding',
        label: 'wallet',
        provider: 'xverse',
        ordinalsAddress: walletAddress,
        paymentAddress: 'private-payment',
        isPublic: true,
      },
    ],
  });
}

function matrica(walletAddress: string, id = 'matrica-holder') {
  const stmts = dbModule.getStmts();
  stmts.upsertMatricaUser.run({
    user_id: id,
    username: 'matrica-name',
    avatar_url: null,
    updated_at: 1,
  });
  stmts.upsertWalletLink.run({
    wallet_addr: walletAddress,
    matrica_user_id: id,
    checked_at: 1,
    is_shell: 0,
  });
}

function leaderboard() {
  return dbModule
    .getStmts()
    .topHoldersGrouped.all({ collection: 'omb', color: null, limit: 100 }) as Array<{
    group_key: string;
    inscription_count: number;
    username: string | null;
  }>;
}

describe('public identity readers', () => {
  it('aggregates only individually shared wallets, with matching stats, search, and role counts', () => {
    share(WALLET_A);
    share(WALLET_B);
    const aggregate = holders.resolveAggregatedWallets(WALLET_A);
    expect(aggregate.wallets.sort()).toEqual([WALLET_A, WALLET_B]);
    expect(aggregate.link).toMatchObject({ identity_id: 'ordnet:ord-profile', provider: 'ordnet' });
    expect(leaderboard()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group_key: 'ordnet:ord-profile', inscription_count: 2 }),
        expect.objectContaining({ group_key: WALLET_C, inscription_count: 1 }),
      ])
    );
    expect(
      dbModule.getStmts().countHolderIdentities.get({ collection: 'omb', color: null })
    ).toEqual({ n: 2 });
    expect(
      dbModule.getStmts().holderDistributionBuckets.all({ collection: 'omb', color: null })
    ).toEqual(
      expect.arrayContaining([
        { bucket: '1', wallet_count: 1 },
        { bucket: '2', wallet_count: 1 },
      ])
    );
    expect(dbModule.getStmts().searchUsersByName.all({ q: 'nexus' })).toEqual([
      expect.objectContaining({
        user_id: 'ordnet:ord-profile',
        provider: 'ordnet',
        wallet_count: 2,
      }),
    ]);
    roles.runRolesTick();
    expect(roles.getRolesForUser('ordnet:ord-profile')).toEqual(['rnb', 'red-1', 'blue-1']);
    expect(roles.getHoldersForRole('rnb', 10)).toEqual([
      expect.objectContaining({
        user_id: 'ordnet:ord-profile',
        first_wallet: WALLET_A,
        inscription_count: 2,
      }),
    ]);
    expect(overlay.matricaProfilesForAddrs([WALLET_A, WALLET_B, WALLET_C])).toEqual({
      [WALLET_A]: expect.objectContaining({ user_id: 'ordnet:ord-profile', provider: 'ordnet' }),
      [WALLET_B]: expect.objectContaining({ user_id: 'ordnet:ord-profile', provider: 'ordnet' }),
    });
    expect(dbModule.getStmts().getWalletLink.get({ wallet_addr: WALLET_A })).toBeUndefined();
    expect(holders.resolveCanonicalHolderAddress(WALLET_A)).toBeNull();
  });

  it('preserves Matrica precedence without merging provider identities or changing calibration data', () => {
    share(WALLET_A);
    share(WALLET_B);
    matrica(WALLET_A);
    const aggregate = holders.resolveAggregatedWallets(WALLET_A);
    expect(aggregate.wallets).toEqual([WALLET_A]);
    expect(aggregate.link).toMatchObject({ identity_id: 'matrica-holder', provider: 'matrica' });
    expect(holders.resolveAggregatedWallets(WALLET_B).wallets).toEqual([WALLET_B]);
    expect(leaderboard()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group_key: 'matrica-holder', inscription_count: 1 }),
        expect.objectContaining({ group_key: 'ordnet:ord-profile', inscription_count: 1 }),
      ])
    );
    expect(dbModule.getDb().prepare('SELECT COUNT(*) AS n FROM matrica_users').get()).toEqual({
      n: 1,
    });
    expect(dbModule.getDb().prepare('SELECT COUNT(*) AS n FROM wallet_links').get()).toEqual({
      n: 1,
    });
  });

  it('never folds heuristic siblings into explicitly shared ORD.NET identities or vice versa', () => {
    matrica(WALLET_C);
    share(WALLET_A, null);
    const db = dbModule.getDb();
    const insert =
      db.prepare(`INSERT INTO cluster_anchors (wallet_addr, anchor_id, matrica_user_id, cluster_size, computed_at)
      VALUES (?, ?, ?, 3, 1)`);
    insert.run(WALLET_A, 'matrica-holder', 'matrica-holder');
    insert.run(WALLET_B, 'matrica-holder', 'matrica-holder');
    insert.run(WALLET_C, 'matrica-holder', 'matrica-holder');
    expect(holders.resolveAggregatedWallets(WALLET_A).wallets).toEqual([WALLET_A]);
    expect(holders.resolveAggregatedWallets(WALLET_C).wallets.sort()).toEqual([WALLET_B, WALLET_C]);
    expect(holders.resolveAggregatedWallets(WALLET_B).wallets.sort()).toEqual([WALLET_B, WALLET_C]);
    expect(
      overlay.matricaProfilesForAddrs([WALLET_A], { includeInferred: true })[WALLET_A]
    ).toEqual({
      user_id: 'ordnet:ord-profile',
      username: null,
      avatar_url: null,
      provider: 'ordnet',
    });
    expect(leaderboard()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          group_key: 'ordnet:ord-profile',
          inscription_count: 1,
          username: null,
        }),
        expect.objectContaining({
          group_key: 'matrica-holder',
          inscription_count: 2,
          username: 'matrica-name',
        }),
      ])
    );
  });

  it('keeps an unanchored cluster separate when its old anchor shares an ORD.NET profile', () => {
    const db = dbModule.getDb();
    const insert = db.prepare(`INSERT INTO cluster_anchors
      (wallet_addr, anchor_id, matrica_user_id, cluster_size, computed_at)
      VALUES (?, ?, NULL, 3, 1)`);
    for (const wallet of [WALLET_A, WALLET_B, WALLET_C]) insert.run(wallet, WALLET_A);
    share(WALLET_A);
    const rows = dbModule.getStmts().topHoldersGrouped.all({
      collection: 'omb',
      color: null,
      limit: 100,
    }) as Array<{ group_key: string; wallets_csv: string; inscription_count: number }>;
    expect(new Set(rows.map(row => row.group_key)).size).toBe(2);
    expect(rows.map(row => row.inscription_count).sort()).toEqual([1, 2]);
    const linkedRow = rows.find(row => row.group_key === 'ordnet:ord-profile')!;
    const inferredRow = rows.find(row => row.group_key !== 'ordnet:ord-profile')!;
    expect(linkedRow.wallets_csv).toBe(WALLET_A);
    expect(inferredRow.wallets_csv.split(',').sort()).toEqual([WALLET_B, WALLET_C]);
    expect(rows.map(row => row.wallets_csv.split(',')[0])).toEqual(
      expect.arrayContaining([WALLET_A, expect.stringMatching(/public-[bc]$/)])
    );
    expect(holders.resolveCanonicalHolderAddress(WALLET_A)).toBeNull();
    expect(holders.resolveCanonicalHolderAddress(WALLET_B)).toBeNull();
    expect(holders.resolveCanonicalHolderAddress(WALLET_C)).toBe(WALLET_B);
    expect(holders.resolveAggregatedWallets(WALLET_A).wallets).toEqual([WALLET_A]);
    for (const wallet of [WALLET_B, WALLET_C]) {
      expect(holders.resolveAggregatedWallets(wallet).wallets.sort()).toEqual([WALLET_B, WALLET_C]);
    }
    expect(
      dbModule.getStmts().countHolderIdentities.get({ collection: 'omb', color: null })
    ).toEqual({ n: 2 });
  });

  it('withdraws a publication from search, totals, names, and badges without removing siblings', () => {
    share(WALLET_A);
    share(WALLET_B);
    roles.runRolesTick();
    identities.removeOrdnetIdentity(WALLET_A);
    roles.runRolesTick();
    expect(holders.resolveAggregatedWallets(WALLET_A).wallets).toEqual([WALLET_A]);
    expect(overlay.matricaProfilesForAddrs([WALLET_A])).toEqual({});
    expect(roles.getRolesForUser('ordnet:ord-profile')).toEqual(['blue-1']);
    expect(dbModule.getStmts().searchUsersByName.all({ q: 'nexus' })).toEqual([
      expect.objectContaining({ first_wallet: WALLET_B, wallet_count: 1 }),
    ]);
    identities.removeOrdnetIdentity(WALLET_B);
    roles.runRolesTick();
    expect(dbModule.getStmts().searchUsersByName.all({ q: 'nexus' })).toEqual([]);
    expect(roles.getRolesForUser('ordnet:ord-profile')).toEqual([]);
  });
});
