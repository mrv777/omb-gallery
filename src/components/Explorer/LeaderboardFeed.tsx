'use client';

import { useEffect, useRef } from 'react';
import type { ApiHolder, ApiInscription } from '@/components/Activity/types';
import type { ColorFilter } from '@/lib/types';
import { LEADERBOARDS, type LeaderboardKey } from './types';
import { HolderRow, InscriptionRow } from './Leaderboard';
import {
  useLeaderboardFeed,
  type InitialLeaderboard,
  type LeaderboardItem,
} from './useLeaderboardFeed';

type Props = {
  type: LeaderboardKey;
  color: ColorFilter;
  initial: InitialLeaderboard<LeaderboardItem>;
};

export default function LeaderboardFeed({ type, color, initial }: Props) {
  const meta = LEADERBOARDS[type];
  const isHolders = type === 'top-holders';

  const { items, loading, error, reachedEnd, capped, loadMore } = useLeaderboardFeed(
    type,
    color,
    initial
  );

  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) loadMore();
        }
      },
      { rootMargin: '600px 0px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  return (
    <div className="border border-ink-2 bg-ink-1">
      <div className="px-4 py-3 border-b border-ink-2">
        <h2 className="font-mono text-xs tracking-[0.12em] uppercase text-bone">{meta.title}</h2>
        <p className="font-mono text-[10px] tracking-[0.04em] text-bone-dim mt-1 normal-case">
          {meta.blurb}
        </p>
      </div>
      {items.length === 0 && !loading && !error && (
        <div className="px-4 py-3 font-mono text-[11px] uppercase tracking-[0.08em] text-bone-dim">
          no data yet
        </div>
      )}
      {/* 2-column responsive grid: on md+, splits the list left/right so a
          1000-row leaderboard renders as 500 visual lines that fill the
          viewport. On mobile, single column with horizontal dividers
          (matches the overview's row treatment). */}
      <ol className="grid grid-cols-1 md:grid-cols-2 md:gap-x-4 md:divide-y-0 divide-y divide-ink-2">
        {items.map((item, i) =>
          isHolders ? (
            <HolderRow
              key={(item as ApiHolder).group_key}
              row={item as ApiHolder}
              rank={i + 1}
            />
          ) : (
            <InscriptionRow
              key={(item as ApiInscription).inscription_number}
              row={item as ApiInscription}
              rank={i + 1}
              type={type}
            />
          )
        )}
      </ol>
      {error && (
        <div
          role="alert"
          className="px-4 py-3 font-mono text-[11px] uppercase tracking-[0.08em] text-accent-red border-t border-ink-2"
        >
          load failed: {error}
        </div>
      )}
      {loading && items.length > 0 && (
        <div className="px-4 py-3 font-mono text-[11px] uppercase tracking-[0.08em] text-bone-dim border-t border-ink-2">
          loading…
        </div>
      )}
      {reachedEnd && items.length > 0 && (
        <div className="px-4 py-3 font-mono text-[11px] uppercase tracking-[0.08em] text-bone-dim border-t border-ink-2">
          {capped
            ? `showing top ${items.length.toLocaleString()} — refine by color to see more`
            : `end of leaderboard · ${items.length.toLocaleString()} ${isHolders ? 'holders' : 'inscriptions'}`}
        </div>
      )}
      {/* Sentinel sits below the list; IntersectionObserver fires loadMore
          when it enters the viewport (with 600px lead). */}
      <div ref={sentinelRef} className="h-px w-full" aria-hidden />
    </div>
  );
}
