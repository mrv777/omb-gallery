import type { Metadata } from 'next';
import Link from 'next/link';
import SubpageShell from '@/components/SubpageShell';
import SafeImg from '@/components/SafeImg';
import { ROLES, COLOR_EMOJI, type EyeColor } from '@/lib/roles';
import {
  getRoleHolderCounts,
  getHoldersForRole,
  getLinkageStats,
  type LinkageStats,
  type RoleHolderRow as RoleHolderRowData,
} from '@/lib/rolesStore';
import { truncateAddr } from '@/lib/format';
import { lookupWalletLabel } from '@/lib/walletLabels';
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
  const linkage = getLinkageStats();

  const sections = ROLES.map((role) => ({
    role,
    holders: getHoldersForRole(role.id, HOLDERS_PER_ROLE),
    count: counts[role.id] ?? 0,
  }));

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

        <LinkageStatsStrip stats={linkage} />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {sections.map(({ role, holders, count }) => (
            <div key={role.id} className="border border-ink-2 bg-ink-1">
              <div className="px-4 py-3 border-b border-ink-2">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="inline-flex items-center text-[16px] leading-none">
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
                    <RoleHolderRow key={h.user_id} row={h} rank={i + 1} />
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

function RoleHolderRow({ row, rank }: { row: RoleHolderRowData; rank: number }) {
  // Deep-link to the first known wallet — the holder page aggregates across
  // all the user's wallets server-side.
  const wallet = row.first_wallet ?? row.user_id;
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
        <span
          className={`font-mono text-xs truncate ${manual ? 'text-accent-orange' : 'text-bone'}`}
        >
          {displayName}
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

const COLOR_BAR_BG: Record<EyeColor, string> = {
  red: 'bg-accent-red',
  blue: 'bg-accent-blue',
  green: 'bg-accent-green',
  orange: 'bg-accent-orange',
  black: 'bg-accent-black',
};

function LinkageStatsStrip({ stats }: { stats: LinkageStats }) {
  const supplyPct =
    stats.totalSupply > 0 ? Math.round((stats.linkedSupply / stats.totalSupply) * 1000) / 10 : 0;

  return (
    <div className="border border-ink-2 bg-ink-1 mb-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-ink-2">
        <Stat
          label="Linked Matrica users"
          value={stats.linkedUsers.toLocaleString()}
          sub="Matrica-linked holders with at least 1 OMB"
        />
        <Stat
          label="Supply linked"
          value={`${stats.linkedSupply.toLocaleString()} / ${stats.totalSupply.toLocaleString()}`}
          sub={`${supplyPct.toFixed(1)}% of OMBs held by linked users`}
        />
      </div>
      <div className="border-t border-ink-2 px-4 py-3">
        <div className="font-mono text-[10px] tracking-[0.12em] uppercase text-bone-dim mb-2">
          By eye color
        </div>
        <ul className="space-y-1.5">
          {stats.byColor.map((row) => (
            <ColorRow key={row.color} row={row} />
          ))}
        </ul>
        <p className="font-mono text-[10px] text-bone-dim/70 normal-case mt-3">
          Protocol wallets (mint, treasury) excluded from totals. &ldquo;Unlinked&rdquo; includes
          wallets the Matrica poller hasn&rsquo;t classified yet (cycles ~hourly).
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="px-4 py-3">
      <div className="font-mono text-[10px] tracking-[0.12em] uppercase text-bone-dim">{label}</div>
      <div className="font-mono text-xl text-bone tabular-nums mt-1">{value}</div>
      <div className="font-mono text-[10px] text-bone-dim normal-case mt-1">{sub}</div>
    </div>
  );
}

function ColorRow({ row }: { row: { color: EyeColor; total: number; linked: number } }) {
  const pct = row.total > 0 ? (row.linked / row.total) * 100 : 0;
  const pctLabel = row.total > 0 ? `${Math.round(pct)}%` : '—';
  return (
    <li className="grid grid-cols-[1.5rem_1fr_auto] items-center gap-3">
      <span className="text-[14px] leading-none" aria-label={row.color}>
        {COLOR_EMOJI[row.color]}
      </span>
      <span
        className="relative h-2 bg-ink-2 rounded-sm overflow-hidden"
        title={`${row.linked.toLocaleString()} linked / ${row.total.toLocaleString()} total ${row.color}`}
      >
        <span
          className={`absolute left-0 top-0 h-full ${COLOR_BAR_BG[row.color]}`}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="font-mono text-[11px] text-bone tabular-nums whitespace-nowrap">
        {row.linked.toLocaleString()}
        <span className="text-bone-dim">
          {' / '}
          {row.total.toLocaleString()}
        </span>
        <span className="text-bone-dim ml-2">{pctLabel}</span>
      </span>
    </li>
  );
}
