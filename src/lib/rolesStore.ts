import 'server-only';
import type { Statement } from 'better-sqlite3';
import { getDb } from './db';
import {
  ROLES,
  type ColorCounts,
  type EyeColor,
  emptyCounts,
  evaluateRoles,
  rankOf,
} from './roles';

let cached: {
  selectColorCountsForLinkedUsers: Statement;
  selectAllEarned: Statement;
  insertEarned: Statement;
  deleteEarned: Statement;
  selectEarnedForUser: Statement;
  selectColorsForUser: Statement;
  selectHolderCountsByRole: Statement;
  selectHoldersForRole: Statement;
} | null = null;

function stmts() {
  if (cached) return cached;
  const db = getDb();
  cached = {
    // For every Matrica-linked user, count inscriptions per color (effective_owner).
    selectColorCountsForLinkedUsers: db.prepare(`
      SELECT wl.matrica_user_id AS user_id, i.color AS color, COUNT(*) AS n
      FROM wallet_links wl
      JOIN inscriptions  i ON i.effective_owner = wl.wallet_addr
      WHERE wl.matrica_user_id IS NOT NULL
        AND i.color IS NOT NULL
      GROUP BY wl.matrica_user_id, i.color
    `),

    selectAllEarned: db.prepare(`
      SELECT matrica_user_id AS user_id, role_id, earned_at FROM roles_earned
    `),

    insertEarned: db.prepare(`
      INSERT OR REPLACE INTO roles_earned (matrica_user_id, role_id, rank, earned_at)
      VALUES (@user_id, @role_id, @rank, @earned_at)
    `),

    deleteEarned: db.prepare(`
      DELETE FROM roles_earned WHERE matrica_user_id = @user_id AND role_id = @role_id
    `),

    selectEarnedForUser: db.prepare(`
      SELECT role_id FROM roles_earned WHERE matrica_user_id = @user_id ORDER BY rank ASC
    `),

    selectColorsForUser: db.prepare(`
      SELECT i.color AS color, COUNT(*) AS n
      FROM inscriptions i
      JOIN wallet_links wl ON wl.wallet_addr = i.effective_owner
      WHERE wl.matrica_user_id = @user_id
        AND i.color IS NOT NULL
      GROUP BY i.color
    `),

    selectHolderCountsByRole: db.prepare(`
      SELECT role_id, COUNT(*) AS n FROM roles_earned GROUP BY role_id
    `),

    // Holders for a single role, ordered by their total inscription count desc.
    selectHoldersForRole: db.prepare(`
      SELECT
        re.matrica_user_id AS user_id,
        mu.username        AS username,
        mu.avatar_url      AS avatar_url,
        (
          SELECT COUNT(*) FROM inscriptions i
          JOIN wallet_links wl ON wl.wallet_addr = i.effective_owner
          WHERE wl.matrica_user_id = re.matrica_user_id
        ) AS inscription_count,
        (
          SELECT wallet_addr FROM wallet_links
          WHERE matrica_user_id = re.matrica_user_id
          ORDER BY wallet_addr ASC LIMIT 1
        ) AS first_wallet
      FROM roles_earned re
      LEFT JOIN matrica_users mu ON mu.user_id = re.matrica_user_id
      WHERE re.role_id = @role_id
      ORDER BY inscription_count DESC, re.matrica_user_id ASC
      LIMIT @limit
    `),
  };
  return cached;
}

export type RolesTickResult = {
  users: number;
  earned: number;
  removed: number;
  durationMs: number;
};

export function runRolesTick(): RolesTickResult {
  const start = Date.now();
  const s = stmts();
  const db = getDb();

  const colorRows = s.selectColorCountsForLinkedUsers.all() as Array<{
    user_id: string;
    color: string;
    n: number;
  }>;
  // Bucket counts per user.
  const countsByUser: Map<string, ColorCounts> = new Map();
  for (const r of colorRows) {
    if (r.color !== 'black' && r.color !== 'orange' && r.color !== 'green' && r.color !== 'blue' && r.color !== 'red') {
      continue;
    }
    let c = countsByUser.get(r.user_id);
    if (!c) {
      c = emptyCounts();
      countsByUser.set(r.user_id, c);
    }
    c[r.color as EyeColor] = r.n;
  }

  // Existing earned set keyed by user_id → Map<role_id, earned_at>.
  const existing: Map<string, Map<string, number>> = new Map();
  for (const r of s.selectAllEarned.all() as Array<{
    user_id: string;
    role_id: string;
    earned_at: number;
  }>) {
    let m = existing.get(r.user_id);
    if (!m) {
      m = new Map();
      existing.set(r.user_id, m);
    }
    m.set(r.role_id, r.earned_at);
  }

  // Walk every user that holds any inscriptions OR previously had a role row.
  // (A user who used to hold but doesn't now should have their roles dropped.)
  const allUserIds = new Set<string>();
  countsByUser.forEach((_v, k) => allUserIds.add(k));
  existing.forEach((_v, k) => allUserIds.add(k));
  const now = Math.floor(Date.now() / 1000);

  let earnedCount = 0;
  let removedCount = 0;

  const tx = db.transaction(() => {
    Array.from(allUserIds).forEach((userId) => {
      const counts = countsByUser.get(userId) ?? emptyCounts();
      const earnedNow: Set<string> = new Set(evaluateRoles(counts));
      const had: Map<string, number> = existing.get(userId) ?? new Map();

      // Insert / preserve.
      Array.from(earnedNow).forEach((roleId) => {
        const prevEarnedAt = had.get(roleId);
        if (prevEarnedAt === undefined) {
          s.insertEarned.run({
            user_id: userId,
            role_id: roleId,
            rank: rankOf(roleId),
            earned_at: now,
          });
          earnedCount++;
        }
        // If previously held, leave the row alone — earned_at is preserved.
      });

      // Remove rows no longer earned.
      Array.from(had.keys()).forEach((roleId) => {
        if (!earnedNow.has(roleId)) {
          s.deleteEarned.run({ user_id: userId, role_id: roleId });
          removedCount++;
        }
      });
    });
  });
  tx();

  return {
    users: countsByUser.size,
    earned: earnedCount,
    removed: removedCount,
    durationMs: Date.now() - start,
  };
}

// ---------------- Readers ----------------

export function getRolesForUser(userId: string): string[] {
  const rows = stmts().selectEarnedForUser.all({ user_id: userId }) as Array<{ role_id: string }>;
  return rows.map((r) => r.role_id);
}

export function getColorCountsForUser(userId: string): ColorCounts {
  const counts = emptyCounts();
  const rows = stmts().selectColorsForUser.all({ user_id: userId }) as Array<{
    color: string;
    n: number;
  }>;
  for (const r of rows) {
    if (r.color === 'black' || r.color === 'orange' || r.color === 'green' || r.color === 'blue' || r.color === 'red') {
      counts[r.color as EyeColor] = r.n;
    }
  }
  return counts;
}

export function getRoleHolderCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const role of ROLES) out[role.id] = 0;
  const rows = stmts().selectHolderCountsByRole.all() as Array<{ role_id: string; n: number }>;
  for (const r of rows) out[r.role_id] = r.n;
  return out;
}

export type RoleHolderRow = {
  user_id: string;
  username: string | null;
  avatar_url: string | null;
  inscription_count: number;
  first_wallet: string | null;
};

export function getHoldersForRole(roleId: string, limit: number): RoleHolderRow[] {
  return stmts().selectHoldersForRole.all({ role_id: roleId, limit }) as RoleHolderRow[];
}
