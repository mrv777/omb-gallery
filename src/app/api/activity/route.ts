import { NextRequest, NextResponse } from 'next/server';
import { getStmts, type EventRow, type PollStateRow } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const limit = clamp(parseInt(url.searchParams.get('limit') ?? '', 10) || DEFAULT_LIMIT, 1, MAX_LIMIT);
  const cursorStr = url.searchParams.get('cursor');
  const cursor = cursorStr && /^\d+$/.test(cursorStr) ? parseInt(cursorStr, 10) : null;
  // `||` not `??` so an empty `?collection=` falls back to default rather than
  // querying with an empty string (which would match nothing).
  const collection = url.searchParams.get('collection') || 'omb';

  const typeParam = url.searchParams.get('type');
  const eventType =
    typeParam === 'sales' ? 'sold' : typeParam === 'transfers' ? 'transferred' : null;

  const stmts = getStmts();
  const events = (
    eventType
      ? cursor != null
        ? stmts.getRecentEventsByTypeAfter.all({ cursor, limit, event_type: eventType, collection })
        : stmts.getRecentEventsByType.all({ limit, event_type: eventType, collection })
      : cursor != null
        ? stmts.getRecentEventsAfter.all({ cursor, limit, collection })
        : stmts.getRecentEvents.all({ limit, collection })
  ) as EventRow[];

  const next_cursor = events.length === limit ? events[events.length - 1].id : null;

  // Totals only change when the poller writes — recomputing them on every
  // paginated request is wasted work. Compute them only on first-page (cursor
  // == null) requests, which covers initial mount, filter change, and the
  // 60s head-refresh in useActivityFeed.
  const totals =
    cursor == null
      ? {
          events: (stmts.countEvents.get({ collection }) as { n: number }).n,
          holders: (stmts.countHolders.get({ collection }) as { n: number }).n,
        }
      : null;
  const poll = stmts.getPollState.get('ord') as PollStateRow | undefined;

  return NextResponse.json({
    events,
    next_cursor,
    totals,
    poll: poll
      ? {
          last_run_at: poll.last_run_at,
          last_status: poll.last_status,
          last_event_count: poll.last_event_count,
          is_backfilling: poll.is_backfilling === 1,
        }
      : null,
  });
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
