'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useActivityFeed, type FeedFilter } from './useActivityFeed';
import ActivityRow from './ActivityRow';
import { formatRelTime } from '@/lib/format';

const FILTERS: { key: FeedFilter; label: string }[] = [
  { key: 'all', label: 'all' },
  { key: 'sales', label: 'sales' },
  { key: 'transfers', label: 'transfers' },
];

export default function ActivityFeed() {
  const [filter, setFilter] = useState<FeedFilter>('all');
  const { events, totals, poll, loading, error, reachedEnd, loadMore } = useActivityFeed(filter);
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

  // Pre-compute "is grouped with previous row" flags so each row knows whether
  // to dim its thumbnail (consecutive events on the same inscription).
  const grouped = useMemo(() => {
    const flags = new Array<boolean>(events.length);
    for (let i = 0; i < events.length; i++) {
      flags[i] = i > 0 && events[i - 1].inscription_number === events[i].inscription_number;
    }
    return flags;
  }, [events]);

  return (
    <section className="px-4 sm:px-6 pb-16">
      {/* Stats + filter bar */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 mb-4">
        <div className="font-mono text-[11px] tracking-[0.08em] uppercase text-bone-dim flex flex-wrap items-center gap-x-4 gap-y-1">
          {totals && (
            <span>
              <span className="text-bone tabular-nums">{totals.events.toLocaleString()}</span>{' '}
              events
            </span>
          )}
          {totals && totals.holders > 0 && (
            <span>
              <span className="text-bone tabular-nums">{totals.holders.toLocaleString()}</span>{' '}
              holders
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
            (() => {
              // 404 on a specific inscription means ord hasn't reached its
              // reveal block yet — expected during IBD, not an error.
              const isIbd404 = /^404 from ord :: inscription/.test(poll.last_status);
              return (
                <span
                  className={`normal-case tracking-normal text-[10px] ${
                    isIbd404 ? 'text-accent-orange' : 'text-accent-red'
                  }`}
                >
                  {isIbd404
                    ? 'ord catching up — recent events may be delayed'
                    : `poll error: ${poll.last_status.slice(0, 80)}`}
                </span>
              );
            })()
          )}
        </div>

        <div
          role="group"
          aria-label="Filter activity"
          className="flex items-center gap-1 font-mono text-[11px] tracking-[0.12em] uppercase"
        >
          {FILTERS.map((f) => {
            const active = filter === f.key;
            return (
              <button
                key={f.key}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(f.key)}
                className={`px-2 py-1 border transition-colors ${
                  active
                    ? 'bg-bone text-ink-0 border-bone'
                    : 'border-ink-2 text-bone-dim hover:text-bone hover:border-bone-dim'
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      {events.length === 0 && !loading && !error && <EmptyState filter={filter} />}

      {error && events.length === 0 && (
        <div className="font-mono text-xs text-accent-red">failed to load: {error}</div>
      )}

      {events.length > 0 && (
        <div className="border border-ink-2 bg-ink-0">
          {events.map((ev, i) => (
            <ActivityRow key={ev.id} event={ev} groupedWithPrev={grouped[i]} />
          ))}
        </div>
      )}

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

function EmptyState({ filter }: { filter: FeedFilter }) {
  const msg =
    filter === 'sales'
      ? 'no sales yet · satflow not wired'
      : filter === 'transfers'
        ? 'no transfers yet · ord still indexing'
        : 'no activity yet · indexer warming up';
  return (
    <div className="font-mono text-xs tracking-[0.08em] uppercase text-bone-dim py-12 text-center">
      {msg}
    </div>
  );
}
