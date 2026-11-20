import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OrdnetWalletBinding } from '@/lib/ordnet';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-public-identity-'));
let store: typeof import('@/lib/publicIdentityStore');
let dbModule: typeof import('@/lib/db');
const previousDbPath = process.env.OMB_DB_PATH;
const wallet = 'bc1p-current';
const sibling = 'bc1p-sibling';
const profile = { id: 'alice', username: 'Alice', avatarUrl: 'https://example.com/alice.png' };

function binding(address = wallet, isPublic = true): OrdnetWalletBinding {
  return {
    walletBindingId: `binding-${address}`,
    label: 'Wallet',
    provider: 'xverse',
    ordinalsAddress: address,
    paymentAddress: 'bc1q-private-payment',
    isPublic,
  };
}

beforeAll(async () => {
  process.env.OMB_DB_PATH = path.join(tempDir, 'test.db');
  vi.resetModules();
  dbModule = await import('@/lib/db');
  store = await import('@/lib/publicIdentityStore');
});

beforeEach(() => {
  dbModule.getDb().exec(`
    DELETE FROM ordnet_public_wallets;
    DELETE FROM ordnet_public_profiles;
    DELETE FROM wallet_links;
    DELETE FROM matrica_users;
  `);
});

afterAll(() => {
  dbModule.getDb().close();
  if (previousDbPath === undefined) delete process.env.OMB_DB_PATH;
  else process.env.OMB_DB_PATH = previousDbPath;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('explicit ORD.NET identity publication', () => {
  it('creates v48 schema and publishes only the exact public ordinal wallet', () => {
    expect(dbModule.getDb().pragma('user_version', { simple: true })).toBe(49);
    store.shareOrdnetIdentity({
      walletAddress: wallet,
      profile,
      walletBindings: [binding(), binding(sibling), binding('bc1p-private', false)],
    });
    expect(store.getOrdnetIdentitySharing(wallet)).toMatchObject({
      provider: 'ordnet',
      profile_id: 'alice',
      username: 'Alice',
    });
    expect(store.getOrdnetIdentitySharing(sibling)).toBeNull();
    expect(store.getOrdnetIdentitySharing('bc1q-private-payment')).toBeNull();
    expect(dbModule.getDb().prepare('SELECT * FROM public_wallet_links').all()).toEqual([
      { wallet_addr: wallet, identity_id: 'ordnet:alice', checked_at: expect.any(Number) },
    ]);
  });

  it.each([false, 'false', 1, null])('rejects non-public binding flag %s', flag => {
    expect(() =>
      store.shareOrdnetIdentity({
        walletAddress: wallet,
        profile,
        walletBindings: [binding(wallet, flag as boolean)],
      })
    ).toThrow('Make this wallet public');
    expect(store.getOrdnetIdentitySharing(wallet)).toBeNull();
  });

  it('rejects payment-address and unrelated binding matches', () => {
    expect(() =>
      store.shareOrdnetIdentity({
        walletAddress: 'bc1q-private-payment',
        profile,
        walletBindings: [binding()],
      })
    ).toThrow();
    expect(() =>
      store.shareOrdnetIdentity({
        walletAddress: wallet,
        profile,
        walletBindings: [binding(sibling)],
      })
    ).toThrow();
  });

  it('keeps Matrica precedence without creating Matrica records for ORD.NET', () => {
    const db = dbModule.getDb();
    db.prepare(`INSERT INTO matrica_users VALUES (?, ?, ?, ?)`).run('m-user', 'Matrica', null, 1);
    db.prepare(`INSERT INTO wallet_links VALUES (?, ?, ?)`).run(wallet, 'm-user', 1);
    store.shareOrdnetIdentity({ walletAddress: wallet, profile, walletBindings: [binding()] });
    expect(
      db.prepare('SELECT identity_id FROM public_wallet_links WHERE wallet_addr = ?').get(wallet)
    ).toEqual({ identity_id: 'm-user' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM matrica_users').get()).toEqual({ n: 1 });
    expect(
      db.prepare('SELECT provider FROM public_profiles WHERE user_id = ?').get('ordnet:alice')
    ).toEqual({ provider: 'ordnet' });
  });

  it('lets an explicitly shared ORD.NET profile replace only an automatic Matrica shell', () => {
    const db = dbModule.getDb();
    const shellName = 'bc1p' + 'a'.repeat(55);
    db.prepare('INSERT INTO matrica_users VALUES (?, ?, ?, ?)').run('shell', shellName, null, 1);
    db.prepare('INSERT INTO wallet_links VALUES (?, ?, ?)').run(wallet, 'shell', 1);
    expect(
      db.prepare('SELECT identity_id FROM public_wallet_links WHERE wallet_addr = ?').get(wallet)
    ).toEqual({ identity_id: 'shell' });
    store.shareOrdnetIdentity({ walletAddress: wallet, profile, walletBindings: [binding()] });
    expect(
      db.prepare('SELECT identity_id FROM public_wallet_links WHERE wallet_addr = ?').get(wallet)
    ).toEqual({ identity_id: 'ordnet:alice' });
    // Provider truth and clustering calibration stay untouched.
    expect(
      db.prepare('SELECT matrica_user_id FROM wallet_links WHERE wallet_addr = ?').get(wallet)
    ).toEqual({ matrica_user_id: 'shell' });
    store.removeOrdnetIdentity(wallet);
    expect(
      db.prepare('SELECT identity_id FROM public_wallet_links WHERE wallet_addr = ?').get(wallet)
    ).toEqual({ identity_id: 'shell' });
  });

  it.each([null, '', 'Alice', 'a'.repeat(30)])(
    'preserves Matrica priority for non-shell username %j',
    name => {
      const db = dbModule.getDb();
      db.prepare('INSERT INTO matrica_users VALUES (?, ?, ?, ?)').run('real', name, null, 1);
      db.prepare('INSERT INTO wallet_links VALUES (?, ?, ?)').run(wallet, 'real', 1);
      store.shareOrdnetIdentity({ walletAddress: wallet, profile, walletBindings: [binding()] });
      expect(
        db.prepare('SELECT identity_id FROM public_wallet_links WHERE wallet_addr = ?').get(wallet)
      ).toEqual({ identity_id: 'real' });
    }
  );

  it('allows a freshly verified profile relink and removes abandoned metadata', () => {
    store.shareOrdnetIdentity({ walletAddress: wallet, profile, walletBindings: [binding()] });
    store.shareOrdnetIdentity({
      walletAddress: wallet,
      profile: { ...profile, id: 'bob', username: 'Bob' },
      walletBindings: [binding()],
    });
    expect(store.getOrdnetIdentitySharing(wallet)?.profile_id).toBe('bob');
    expect(dbModule.getDb().prepare('SELECT profile_id FROM ordnet_public_profiles').all()).toEqual(
      [{ profile_id: 'bob' }]
    );
  });

  it('withdraws only the connected wallet and clears metadata after the last removal', () => {
    store.shareOrdnetIdentity({ walletAddress: wallet, profile, walletBindings: [binding()] });
    store.shareOrdnetIdentity({
      walletAddress: sibling,
      profile,
      walletBindings: [binding(sibling)],
    });
    store.removeOrdnetIdentity(wallet);
    expect(store.getOrdnetIdentitySharing(wallet)).toBeNull();
    expect(store.getOrdnetIdentitySharing(sibling)?.profile_id).toBe('alice');
    store.removeOrdnetIdentity(sibling);
    expect(dbModule.getDb().prepare('SELECT * FROM ordnet_public_profiles').all()).toEqual([]);
  });

  it('sanitizes display metadata and discards unsafe avatar URLs', () => {
    store.shareOrdnetIdentity({
      walletAddress: wallet,
      profile: { ...profile, username: '\u0000 Alice\n', avatarUrl: 'javascript:alert(1)' },
      walletBindings: [binding()],
    });
    expect(store.getOrdnetIdentitySharing(wallet)).toMatchObject({
      username: 'Alice',
      avatar_url: null,
    });
  });

  it('upgrades a production v47 database without changing existing identity rows', async () => {
    const db = dbModule.getDb();
    db.prepare(`INSERT INTO matrica_users VALUES (?, ?, ?, ?)`).run(
      'existing',
      'Existing',
      null,
      1
    );
    db.prepare("UPDATE poll_state SET last_cursor = 'page:8' WHERE stream = 'satflow'").run();
    db.exec(`DROP VIEW public_wallet_links; DROP VIEW public_profiles;
      DROP TABLE ordnet_public_wallets; DROP TABLE ordnet_public_profiles; PRAGMA user_version = 47;`);
    db.close();
    vi.resetModules();
    dbModule = await import('@/lib/db');
    store = await import('@/lib/publicIdentityStore');
    expect(dbModule.getDb().pragma('user_version', { simple: true })).toBe(49);
    expect(
      dbModule
        .getDb()
        .prepare('SELECT username FROM matrica_users WHERE user_id = ?')
        .get('existing')
    ).toEqual({ username: 'Existing' });
    expect(store.getOrdnetIdentitySharing(wallet)).toBeNull();
    expect(
      dbModule.getStmts().getPollState.get({ stream: 'satflow', collection: 'omb' })
    ).toMatchObject({ last_cursor: 'page:8' });
  });
});
