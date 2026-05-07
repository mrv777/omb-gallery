import type { Metadata } from 'next';
import Link from 'next/link';
import SubpageShell from '@/components/SubpageShell';
import SafeImg from '@/components/SafeImg';
import { ROLES, sortRoleIds } from '@/lib/roles';
import {
  getRoleHolderCounts,
  getHoldersForRole,
  getRolesForUsers,
  type RoleHolderRow as RoleHolderRowData,
} from '@/lib/rolesStore';
import { truncateAddr } from '@/lib/format';
import { lookupWalletLabel } from '@/lib/walletLabels';
import RoleBadges from '@/components/RoleBadges';
import { SITE_NAME, buildSocial } from '@/lib/metadata';

export const dynamic = 'force-dynamic';

const HOLDERS_PER_ROLE = 25;

export async function generateMetadata(): Promise<Metadata> {
  const title = 'Roles';
  const description =
    'Holder roles earned by Matrica-linked OMB holders, ranked by rarity. Each role corresponds to a configuration of colored eyes held.';
  return {
    title,
    description,
    ...buildSocial({ title: `${title} · ${SITE_NAME}`, description }),
  };
}

export default function RolesPage() {
  const counts = getRoleHolderCounts();

  // For each role: the top N holders, plus their full earned-role list (so the
  // row's badge cluster shows everything they've earned, not just the role
  // we're under). One bulk query per role keeps things simple — at ~10 roles
  // x 25 holders, total rows are bounded.
  const sections = ROLES.map((role) => {
    const holders = getHoldersForRole(role.id, HOLDERS_PER_ROLE);
    const userIds = holders.map((h) => h.user_id);
    const roles = getRolesForUsers(userIds);
    return { role, holders, count: counts[role.id] ?? 0, roles };
  });

  return (
    <SubpageShell active="explorer">
      <section className="px-4 sm:px-6 pb-16 max-w-6xl mx-auto">
        <Link
          href="/explorer"
          className="inline-block font-mono text-[11px] tracking-[0.08em] uppercase text-bone-dim hover:text-bone mb-6"
        >
          ← back to explorer
        </Link>
        <header className="mb-8">
          <h1 className="font-mono text-sm tracking-[0.12em] uppercase text-bone mb-2">Roles</h1>
          <p className="font-mono text-[11px] text-bone-dim normal-case max-w-2xl">
            Earned by Matrica-linked OMB holders based on the colored eyes they hold. Order is
            curated — rarest / hardest-earned first. Loaned-out OMBs still count for the original
            holder.
          </p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {sections.map(({ role, holders, count, roles }) => (
            <div key={role.id} className="border border-ink-2 bg-ink-1">
              <div className="px-4 py-3 border-b border-ink-2">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`inline-flex items-center text-[16px] leading-none ${role.combo ? 'border border-bone-dim/30 rounded-full px-2 py-0.5' : ''}`}
                    >
                      {role.emoji.join('')}
                    </span>
                    <h2 className="font-mono text-[12px] tracking-[0.04em] text-bone normal-case truncate">
                      {role.label}
                    </h2>
                  </div>
                  <span className="font-mono text-[11px] text-bone-dim tabular-nums shrink-0">
                    {count.toLocaleString()} holder{count === 1 ? '' : 's'}
                  </span>
                </div>
              </div>
              {holders.length === 0 ? (
                <div className="px-4 py-6 font-mono text-[11px] uppercase tracking-[0.08em] text-bone-dim text-center">
                  no holders yet
                </div>
              ) : (
                <ol className="divide-y divide-ink-2">
                  {holders.map((h, i) => (
                    <RoleHolderRow
                      key={h.user_id}
                      row={h}
                      rank={i + 1}
                      earnedRoles={roles.get(h.user_id) ?? []}
                    />
                  ))}
                </ol>
              )}
            </div>
          ))}
        </div>
      </section>
    </SubpageShell>
  );
}

function RoleHolderRow({
  row,
  rank,
  earnedRoles,
}: {
  row: RoleHolderRowData;
  rank: number;
  earnedRoles: string[];
}) {
  // Deep-link to the first known wallet — the holder page aggregates across
  // all the user's wallets server-side.
  const wallet = row.first_wallet ?? row.user_id;
  const ordered = sortRoleIds(earnedRoles);
  const manual = lookupWalletLabel(wallet);
  const displayName =
    manual?.name ??
    (row.username && !looksLikeAddress(row.username) ? row.username : truncateAddr(wallet, 8, 6));

  return (
    <li>
      <Link
        href={`/holder/${wallet}`}
        prefetch={false}
        className="grid grid-cols-[1.5rem_1.25rem_1fr_auto] items-center gap-3 px-4 py-2 hover:bg-ink-2 transition-colors"
      >
        <span className="font-mono text-[11px] text-bone-dim tabular-nums">{rank}</span>
        <span className="block w-5 h-5 bg-ink-2 overflow-hidden rounded-sm">
          {!manual && row.avatar_url && (
            <SafeImg
              src={row.avatar_url}
              alt=""
              loading="lazy"
              className="w-full h-full object-cover"
            />
          )}
        </span>
        <span className="flex items-center gap-2 min-w-0">
          <span
            className={`font-mono text-xs truncate ${manual ? 'text-accent-orange' : 'text-bone'}`}
          >
            {displayName}
          </span>
          {ordered.length > 0 && (
            <span className="hidden sm:inline-flex shrink-0">
              <RoleBadges roleIds={ordered} max={4} dense />
            </span>
          )}
        </span>
        <span className="font-mono text-[11px] text-bone-dim tabular-nums whitespace-nowrap">
          {row.inscription_count.toLocaleString()}
        </span>
      </Link>
    </li>
  );
}

function looksLikeAddress(s: string): boolean {
  return /^bc1[a-z0-9]{30,}$/i.test(s) || /^0x[a-f0-9]{40}$/i.test(s) || s.length > 30;
}
