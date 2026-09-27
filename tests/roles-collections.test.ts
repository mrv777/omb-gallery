import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let dbModule: typeof import('../src/lib/db');
let rolesStore: typeof import('../src/lib/rolesStore');
const tempDir = path.join(
  os.tmpdir(),
  `omb-roles-collections-${process.pid}-${Math.random().toString(36).slice(2)}`
);

beforeEach(async () => {
  fs.mkdirSync(tempDir, { recursive: true });
  process.env.OMB_DB_PATH = path.join(tempDir, `t-${Math.random().toString(36).slice(2)}.db`);
  vi.resetModules();
  dbModule = await import('../src/lib/db');
  rolesStore = await import('../src/lib/rolesStore');
});

afterEach(() => {
  delete process.env.OMB_DB_PATH;
  if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('roles collection scope', () => {
  it('bases earned roles, profile counts, and role-holder size on OMB only', () => {
    const db = dbModule.getDb();
    const userId = 'roles-collection-test-user';
    const wallet = 'bc1qrolescollectiontestwallet';
    db.prepare(
      `INSERT INTO matrica_users (user_id, username, avatar_url, updated_at) VALUES (?, ?, NULL, 1)`
    ).run(userId, 'test-user');
    db.prepare(
      `INSERT INTO wallet_links (wallet_addr, matrica_user_id, checked_at) VALUES (?, ?, 1)`
    ).run(wallet, userId);

    const omb = db
      .prepare(`SELECT inscription_number FROM inscriptions WHERE collection_slug='omb' LIMIT 1`)
      .get() as { inscription_number: number };
    const bravo = db
      .prepare(
        `SELECT inscription_number FROM inscriptions WHERE collection_slug='bravocados' LIMIT 1`
      )
      .get() as { inscription_number: number };
    db.prepare(
      `UPDATE inscriptions SET effective_owner=?, current_owner=?, color='red' WHERE inscription_number=?`
    ).run(wallet, wallet, omb.inscription_number);
    db.prepare(
      `UPDATE inscriptions SET effective_owner=?, current_owner=?, color='orange' WHERE inscription_number=?`
    ).run(wallet, wallet, bravo.inscription_number);

    rolesStore.runRolesTick();

    expect(rolesStore.getRolesForUser(userId)).toContain('red-1');
    expect(rolesStore.getRolesForUser(userId)).not.toContain('orange-1');
    expect(rolesStore.getColorCountsForUser(userId)).toMatchObject({ red: 1, orange: 0 });

    expect(rolesStore.getHoldersForRole('red-1', 10)).toContainEqual(
      expect.objectContaining({ user_id: userId, inscription_count: 1, first_wallet: wallet })
    );
  });

  it('does not let a colored non-OMB inscription change OMB linkage statistics', () => {
    const db = dbModule.getDb();
    const before = rolesStore.getLinkageStats();
    const bravo = db
      .prepare(
        `SELECT inscription_number FROM inscriptions WHERE collection_slug='bravocados' LIMIT 1`
      )
      .get() as { inscription_number: number };
    db.prepare(
      `UPDATE inscriptions SET color='orange', effective_owner='bc1qroleslinkstatstest', current_owner='bc1qroleslinkstatstest' WHERE inscription_number=?`
    ).run(bravo.inscription_number);

    expect(rolesStore.getLinkageStats()).toEqual(before);
  });
});
