'use client';

import { useCallback, useState } from 'react';
import type { EventRow } from '@/lib/db';
import HolderEventRow from './HolderEventRow';

const PAGE_SIZE = 50;

type Props = {
  /** URL-segment address — the one the visitor navigated to. The API route
   * resolves this to the same wallet set the page used (Matrica fan-out). */
  address: string;
  /** Wallet set used for direction labelling (sent/received/internal) — must
   * match what the SSR page passed to the initial event rows. */
  wallets: string[];
  /** First page of events from SSR. */
  initialEvents: EventRow[];
  /** Cursor for fetching page 2, or null when SSR already covered everything. */
  initialCursor: string | null;
  /** Total event count across the wallet set. Used for the "showing N of M" label. */
  eventTotal: number;
};

export default function HolderActivityList({
  address,
  wallets,
  initialEvents,
  initialCursor,
  eventTotal,
}: Props) {
  const [events, setEvents] = useState<EventRow[]>(initialEvents);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMore = useCallback(async () => {
    if (loading || cursor == null) return;
    setLoading(true);
    setError(null);
    try {
      const url = new URL(
        `/api/holder/${encodeURIComponent(address)}/events`,
        window.location.origin
      );
      url.searchParams.set('cursor', cursor);
      url.searchParams.set('limit', String(PAGE_SIZE));
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: { events: EventRow[]; next_cursor: string | null } = await res.json();
      setEvents(prev => {
        // Defensive dedupe by id — the API already paginates by keyset so
        // overlap should not occur, but if a poll tick lands a new event at
        // exactly the cursor boundary we don't want a double-render.
        const seen = new Set(prev.map(e => e.id));
        const additions = data.events.filter(e => !seen.has(e.id));
        return [...prev, ...additions];
      });
      setCursor(data.next_cursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load');
    } finally {
      setLoading(false);
    }
  }, [address, cursor, loading]);

  const reachedEnd = cursor == null;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="font-mono text-xs tracking-[0.12em] uppercase text-bone">
          recent activity{' '}
          <span className="text-bone-dim tabular-nums">· {eventTotal.toLocaleString()}</span>
        </h2>
        {events.length < eventTotal && (
          <span className="font-mono text-[10px] tracking-[0.08em] uppercase text-bone-dim tabular-nums">
            showing {events.length.toLocaleString()} of {eventTotal.toLocaleString()}
          </span>
        )}
      </div>
      {events.length === 0 ? (
        <div className="font-mono text-xs tracking-[0.08em] uppercase text-bone-dim py-8 text-center border border-ink-2">
          no recorded activity yet
        </div>
      ) : (
        <>
          <div className="border border-ink-2 bg-ink-0">
            {events.map(ev => (
              <HolderEventRow key={ev.id} event={ev} wallets={wallets} />
            ))}
          </div>
          {!reachedEnd && (
            <div className="mt-3 flex flex-col items-center gap-2">
              <button
                type="button"
                onClick={loadMore}
                disabled={loading}
                className="font-mono text-[11px] tracking-[0.12em] uppercase border border-ink-2 hover:border-bone-dim disabled:border-ink-2 disabled:opacity-50 text-bone-dim hover:text-bone disabled:text-bone-dim px-4 py-2 transition-colors"
              >
                {loading ? 'loading…' : 'load more'}
              </button>
              {error && (
                <span className="font-mono text-[10px] tracking-[0.08em] uppercase text-accent-red">
                  {error} — try again
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
