'use client';

import Link from 'next/link';
import { useLeaderboard } from './useLeaderboard';
import { LEADERBOARDS, type LeaderboardKey } from './types';
import { lookupInscription } from '@/lib/inscriptionLookup';
import { addressLink, formatBtc, formatRelTime, truncateAddr } from '@/lib/format';
import type { ApiHolder, ApiInscription } from '@/components/Activity/types';

type Props = {
  type: LeaderboardKey;
  limit: number;
  showSeeAll?: boolean;
};

export default function Leaderboard({ type, limit, showSeeAll }: Props) {
  const meta = LEADERBOARDS[type];
  const { data, loading, error } = useLeaderboard(type, limit);

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
        {loading && (
          <li className="px-4 py-3 font-mono text-[11px] uppercase tracking-[0.08em] text-bone-dim">
            loading…
          </li>
        )}
        {error && (
          <li className="px-4 py-3 font-mono text-[11px] uppercase tracking-[0.08em] text-accent-red">
            {error}
          </li>
        )}
        {!loading && data && data.items.length === 0 && (
          <li className="px-4 py-3 font-mono text-[11px] uppercase tracking-[0.08em] text-bone-dim">
            no data yet
          </li>
        )}
        {data && data.kind === 'inscriptions' &&
          data.items.map((row, i) => (
            <InscriptionRow key={row.inscription_number} row={row} rank={i + 1} type={type} />
          ))}
        {data && data.kind === 'holders' &&
          data.items.map((row, i) => <HolderRow key={row.wallet_addr} row={row} rank={i + 1} />)}
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
  return (
    <li className="grid grid-cols-[1.5rem_1fr_auto] items-center gap-3 px-4 py-2">
      <span className="font-mono text-[11px] text-bone-dim tabular-nums">{rank}</span>
      <a
        href={addressLink(row.wallet_addr)}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-xs text-bone truncate hover:text-accent-orange"
        title={row.wallet_addr}
      >
        {truncateAddr(row.wallet_addr, 8, 6)}
      </a>
      <span className="font-mono text-xs text-bone tabular-nums whitespace-nowrap">
        {row.inscription_count.toLocaleString()}
      </span>
    </li>
  );
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
