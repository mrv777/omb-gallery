'use client';

import { useEffect, useRef } from 'react';
import { useActivityFeed } from './useActivityFeed';
import ActivityCard from './ActivityCard';
import { formatRelTime } from '@/lib/format';

export default function ActivityFeed() {
  const { events, totals, poll, loading, error, reachedEnd, loadMore } = useActivityFeed();
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Infinite scroll
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
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
    <section className="px-4 sm:px-6 pb-16">
      <div className="font-mono text-[11px] tracking-[0.08em] uppercase text-bone-dim mb-4 flex flex-wrap items-center gap-x-4 gap-y-1">
        {totals && (
          <span>
            <span className="text-bone tabular-nums">{totals.events.toLocaleString()}</span> events
          </span>
        )}
        {totals && totals.holders > 0 && (
          <span>
            <span className="text-bone tabular-nums">{totals.holders.toLocaleString()}</span> holders
          </span>
        )}
        {poll && poll.last_run_at && (
          <span>
            last poll{' '}
            <span className="text-bone normal-case tracking-normal">
              {formatRelTime(poll.last_run_at)}
            </span>
          </span>
        )}
        {poll?.is_backfilling && (
          <span className="text-accent-orange">· backfilling history</span>
        )}
        {poll && poll.last_status && poll.last_status !== 'ok' && (
          <span className="text-accent-red normal-case tracking-normal text-[10px]">
            poll error: {poll.last_status.slice(0, 80)}
          </span>
        )}
      </div>

      {events.length === 0 && !loading && !error && (
        <EmptyState />
      )}

      {error && events.length === 0 && (
        <div className="font-mono text-xs text-accent-red">failed to load: {error}</div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
        {events.map((ev) => (
          <ActivityCard key={ev.id} event={ev} />
        ))}
      </div>

      <div ref={sentinelRef} className="h-px w-full mt-12" aria-hidden />
      {loading && events.length > 0 && (
        <div className="font-mono text-[11px] tracking-[0.08em] uppercase text-bone-dim mt-6">
          loading…
        </div>
      )}
      {reachedEnd && events.length > 0 && (
        <div className="font-mono text-[11px] tracking-[0.08em] uppercase text-bone-dim mt-6">
          end of feed
        </div>
      )}
    </section>
  );
}

function EmptyState() {
  return (
    <div className="font-mono text-xs tracking-[0.08em] uppercase text-bone-dim py-12 text-center">
      no activity yet · indexer warming up
    </div>
  );
}
