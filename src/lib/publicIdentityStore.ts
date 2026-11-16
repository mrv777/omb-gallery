import 'server-only';

import { getDb } from '@/lib/db';
import type { OrdnetWalletBinding } from '@/lib/ordnet';

export type SharedOrdnetIdentity = {
  provider: 'ordnet';
  profile_id: string;
  username: string | null;
  avatar_url: string | null;
  verified_at: number;
};

type Profile = { id: string; username: string | null; avatarUrl: string | null };

export function getOrdnetIdentitySharing(walletAddress: string): SharedOrdnetIdentity | null {
  const row = getDb()
    .prepare(
      `SELECT 'ordnet' AS provider, p.profile_id, p.username, p.avatar_url, w.verified_at
       FROM ordnet_public_wallets w
       JOIN ordnet_public_profiles p ON p.profile_id = w.profile_id
       WHERE w.wallet_addr = ?`
    )
    .get(walletAddress) as SharedOrdnetIdentity | undefined;
  return row ?? null;
}

/** Call only after fresh upstream authentication and explicit publication consent.
 * The API's metadata is authoritative; never pass profile fields from a request body.
 * Every additional wallet must complete this flow separately. */
export function shareOrdnetIdentity(args: {
  walletAddress: string;
  profile: Profile;
  walletBindings: OrdnetWalletBinding[];
}): SharedOrdnetIdentity {
  const { walletAddress, profile, walletBindings } = args;
  if (!walletAddress || !profile.id || profile.id.length > 200) {
    throw new Error('ORD.NET returned an invalid profile.');
  }
  // Strict true matters: a string such as "false" must never publish a wallet.
  if (
    !walletBindings.some(
      binding => binding.ordinalsAddress === walletAddress && binding.isPublic === true
    )
  ) {
    throw new Error('Make this wallet public on ORD.NET before sharing it here.');
  }
  const username = cleanUsername(profile.username);
  const avatarUrl = cleanAvatarUrl(profile.avatarUrl);
  const db = getDb();
  db.transaction(() => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO ordnet_public_profiles (profile_id, username, avatar_url, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(profile_id) DO UPDATE SET
         username = excluded.username, avatar_url = excluded.avatar_url,
         updated_at = excluded.updated_at`
    ).run(profile.id, username, avatarUrl, now);
    // A freshly verified wallet can legitimately move to another ORD.NET profile.
    db.prepare(
      `INSERT INTO ordnet_public_wallets (wallet_addr, profile_id, verified_at)
       VALUES (?, ?, ?)
       ON CONFLICT(wallet_addr) DO UPDATE SET
         profile_id = excluded.profile_id, verified_at = excluded.verified_at`
    ).run(walletAddress, profile.id, now);
    removeUnsharedProfiles();
  })();
  return getOrdnetIdentitySharing(walletAddress)!;
}

/** Removing one publication never removes a separately published sibling wallet. */
export function removeOrdnetIdentity(walletAddress: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM ordnet_public_wallets WHERE wallet_addr = ?').run(walletAddress);
    removeUnsharedProfiles();
  })();
}

function removeUnsharedProfiles(): void {
  getDb()
    .prepare(
      `DELETE FROM ordnet_public_profiles
       WHERE NOT EXISTS (
         SELECT 1 FROM ordnet_public_wallets w
         WHERE w.profile_id = ordnet_public_profiles.profile_id
       )`
    )
    .run();
}

function cleanUsername(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 100);
  return clean || null;
}

function cleanAvatarUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}
