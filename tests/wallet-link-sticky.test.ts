/**
 * `upsertWalletLink` re-link policy.
 *
 * An existing link is defended against exactly two weaker answers — NULL
 * ("no profile") and a Matrica auto-shell user — and yields to any real,
 * claimed user, including a *different* real user.
 *
 * The regression this guards: the original rule kept the first non-null
 * user_id forever, which stranded wallets that had genuinely moved between
 * Matrica accounts. They were re-probed daily and the correct answer thrown
 * away every time, so no amount of polling could heal them.
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

const WALLET = 'bc1p073cey7adccsqmqkyqap6h90mqu3v8r07jlu0t3790yl9mskrwnqqrc6jp';
const USER_A = 'fd548af4-1929-47d0-a55a-0e837fefa1a5';
const USER_B = '745b2988-86f2-4917-a5ca-2cce0fa63aae';
const SHELL = 'ad9fc3cb-d60c-4cc2-a398-e41da70df2aa';

beforeEach(async () => {
  fs.mkdirSync(tempDir, { recursive: true });
  process.env.OMB_DB_PATH = path.join(tempDir, `t-${Math.random().toString(36).slice(2)}.db`);
  vi.resetModules();
  dbModule = await import('../src/lib/db');
  // matrica_user_id carries an FK to matrica_users, so seed the users first.
  const stmts = dbModule.getStmts();
  for (const [id, name] of [
    [USER_A, 'blz'],
    [USER_B, 'Christguru'],
    [SHELL, `${WALLET}L61W8tQm`],
  ]) {
    stmts.upsertMatricaUser.run({
      user_id: id,
      username: name,
      avatar_url: null,
      updated_at: 1,
    });
  }
});

afterEach(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function link(matrica_user_id: string | null, is_shell: 0 | 1) {
  dbModule.getStmts().upsertWalletLink.run({
    wallet_addr: WALLET,
    matrica_user_id,
    checked_at: 1,
    is_shell,
  });
}

function stored(): string | null {
  const row = dbModule.getStmts().getWalletLink.get({ wallet_addr: WALLET }) as
    | { matrica_user_id: string | null }
    | undefined;
  return row?.matrica_user_id ?? null;
}

describe('upsertWalletLink — re-link policy', () => {
  it('accepts the first real user', () => {
    link(USER_A, 0);
    expect(stored()).toBe(USER_A);
  });

  it('lets a different real user take over an existing link', () => {
    link(USER_A, 0);
    link(USER_B, 0);
    expect(stored()).toBe(USER_B);
  });

  it('lets a real user take over from an auto-shell', () => {
    link(SHELL, 1);
    link(USER_B, 0);
    expect(stored()).toBe(USER_B);
  });

  it('does not let an auto-shell displace a real user', () => {
    link(USER_A, 0);
    link(SHELL, 1);
    expect(stored()).toBe(USER_A);
  });

  it('does not let a NULL response displace a real user', () => {
    link(USER_A, 0);
    link(null, 0);
    expect(stored()).toBe(USER_A);
  });

  it('still records checked_at when the link itself is defended', () => {
    link(USER_A, 0);
    dbModule.getStmts().upsertWalletLink.run({
      wallet_addr: WALLET,
      matrica_user_id: null,
      checked_at: 999,
      is_shell: 0,
    });
    const row = dbModule.getStmts().getWalletLink.get({ wallet_addr: WALLET }) as {
      matrica_user_id: string | null;
      checked_at: number;
    };
    expect(row.matrica_user_id).toBe(USER_A);
    // Staleness must still advance, or a defended wallet would be re-probed
    // on every single tick forever.
    expect(row.checked_at).toBe(999);
  });

  it('accepts a shell onto a wallet with no link yet', () => {
    link(SHELL, 1);
    expect(stored()).toBe(SHELL);
  });
});
