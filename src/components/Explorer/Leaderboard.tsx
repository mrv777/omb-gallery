import Link from 'next/link';
import { LEADERBOARDS, type LeaderboardKey } from './types';
import { lookupInscription } from '@/lib/inscriptionLookup';
import { formatBtc, formatRelTime, truncateAddr } from '@/lib/format';
import type { ApiHolder, ApiInscription } from '@/components/Activity/types';

type Props = {
  type: LeaderboardKey;
  showSeeAll?: boolean;
  items: ApiInscription[] | ApiHolder[];
};

export default function Leaderboard({ type, items, showSeeAll }: Props) {
  const meta = LEADERBOARDS[type];
  const isHolders = type === 'top-holders';

  return (
    <div className="border border-ink-2 bg-ink-1">
      <div className="px-4 py-3 border-b border-ink-2">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-mono text-xs tracking-[0.12em] uppercase text-bone">{meta.title}</h2>
          {showSeeAll && type !== 'top-holders' && (
            <Link
              href={`/explorer/${type}`}
              className="font-mono text-[10px] tracking-[0.12em] uppercase text-bone-dim hover:text-bone transition-colors"
            >
              see all →
            </Link>
          )}
        </div>
        <p className="font-mono text-[10px] tracking-[0.04em] text-bone-dim mt-1 normal-case">
          {meta.blurb}
        </p>
      </div>
      <ol className="divide-y divide-ink-2">
        {items.length === 0 && (
          <li className="px-4 py-3 font-mono text-[11px] uppercase tracking-[0.08em] text-bone-dim">
            no data yet
          </li>
        )}
        {!isHolders &&
          (items as ApiInscription[]).map((row, i) => (
            <InscriptionRow key={row.inscription_number} row={row} rank={i + 1} type={type} />
          ))}
        {isHolders &&
          (items as ApiHolder[]).map((row, i) => (
            <HolderRow key={row.group_key} row={row} rank={i + 1} />
          ))}
      </ol>
    </div>
  );
}

function InscriptionRow({
  row,
  rank,
  type,
}: {
  row: ApiInscription;
  rank: number;
  type: LeaderboardKey;
}) {
  const hit = lookupInscription(row.inscription_number);
  const link = `/inscription/${row.inscription_number}`;
  const metric = renderInscriptionMetric(row, type);
  return (
    <li>
      <Link
        href={link}
        prefetch={false}
        className="grid grid-cols-[1.5rem_2.5rem_1fr_auto] items-center gap-3 px-4 py-2 hover:bg-ink-2 transition-colors"
      >
        <span className="font-mono text-[11px] text-bone-dim tabular-nums">{rank}</span>
        <span className="block w-10 h-10 bg-ink-2 overflow-hidden">
          {hit && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={hit.thumbnail}
              alt={`Inscription ${row.inscription_number}`}
              loading="lazy"
              className="w-full h-full object-cover"
            />
          )}
        </span>
        <span className="font-mono text-xs text-bone tabular-nums truncate">
          #{row.inscription_number}
        </span>
        <span className="font-mono text-xs text-bone tabular-nums whitespace-nowrap">{metric}</span>
      </Link>
    </li>
  );
}

function HolderRow({ row, rank }: { row: ApiHolder; rank: number }) {
  // Linked Matrica user: deep-link to the first wallet (which then aggregates
  // across all linked wallets server-side). Unlinked wallet: link to itself.
  const primaryWallet = row.wallets[0] ?? row.group_key;
  const showsUsername = row.is_user && row.username && !looksLikeAddress(row.username);
  const tooltip = row.is_user
    ? `Matrica: ${row.username ?? row.group_key} (${row.wallets.length} wallet${row.wallets.length === 1 ? '' : 's'})`
    : row.group_key;
  return (
    <li>
      <Link
        href={`/holder/${primaryWallet}`}
        prefetch={false}
        className="grid grid-cols-[1.5rem_1.25rem_1fr_auto] items-center gap-3 px-4 py-2 hover:bg-ink-2 transition-colors"
      >
        <span className="font-mono text-[11px] text-bone-dim tabular-nums">{rank}</span>
        <span className="block w-5 h-5 bg-ink-2 overflow-hidden rounded-sm">
          {row.is_user && row.avatar_url && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={row.avatar_url}
              alt=""
              loading="lazy"
              className="w-full h-full object-cover"
            />
          )}
        </span>
        <span className="font-mono text-xs text-bone truncate" title={tooltip}>
          {showsUsername ? row.username : truncateAddr(primaryWallet, 8, 6)}
          {row.is_user && row.wallets.length > 1 && (
            <span className="ml-1.5 text-[10px] text-bone-dim">×{row.wallets.length}</span>
          )}
        </span>
        <span className="font-mono text-xs text-bone tabular-nums whitespace-nowrap">
          {row.inscription_count.toLocaleString()}
        </span>
      </Link>
    </li>
  );
}

/** A few users on Matrica have their wallet address as their username
 * (the default when no display name is set). Treat those as "no username"
 * so we render the truncated address instead of a long unwieldy string. */
function looksLikeAddress(s: string): boolean {
  return /^bc1[a-z0-9]{30,}$/i.test(s) || /^0x[a-f0-9]{40}$/i.test(s) || s.length > 30;
}

function renderInscriptionMetric(row: ApiInscription, type: LeaderboardKey): string {
  switch (type) {
    case 'most-transferred':
      return `${(row.transfer_count + row.sale_count).toLocaleString()}`;
    case 'longest-unmoved':
      return row.last_movement_at ? formatRelTime(row.last_movement_at) : 'never';
    case 'top-volume':
      return formatBtc(row.total_volume_sats) || '—';
    case 'highest-sale':
      return formatBtc(row.highest_sale_sats) || '—';
    case 'top-holders':
      return '';
  }
}
