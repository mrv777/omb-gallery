import { NextRequest, NextResponse } from 'next/server';
import { getDb, getStmts, type EventRow, type PollStateRow } from '@/lib/db';
import { matricaProfilesForEvents } from '@/lib/matricaOverlay';
import { colorParamForSql, parseColorParam } from '@/lib/colorFilter';
import { SQL_EXCLUDED_OWNERS_LIST } from '@/lib/walletLabels';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_REVALIDATE_IDS = 200;

let eventsByIdsStatement: ReturnType<ReturnType<typeof getDb>['prepare']> | null = null;

function getEventsByIdsStatement() {
  if (eventsByIdsStatement) return eventsByIdsStatement;
  eventsByIdsStatement = getDb().prepare(`
  SELECT e.* FROM json_each(@ids_json) requested
  JOIN events e ON e.id = CAST(requested.value AS INTEGER)
  JOIN inscriptions i ON i.inscription_number = e.inscription_number
  WHERE i.collection_slug = @collection
    AND (@color IS NULL OR i.color = @color)
    AND (i.current_owner IS NULL OR i.current_owner NOT IN (${SQL_EXCLUDED_OWNERS_LIST}))
    AND e.event_type != 'listed'
    AND (
      (@mode = 'all')
      OR (@mode = 'sales' AND e.event_type = 'sold')
      OR (@mode = 'transfers' AND e.event_type = 'transferred')
      OR (@mode = 'loans' AND e.event_type IN ('loan-originated','loan-defaulted','loan-repaid','loan-unlocked'))
    )
`);
  return eventsByIdsStatement;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const limit = clamp(
    parseInt(url.searchParams.get('limit') ?? '', 10) || DEFAULT_LIMIT,
    1,
    MAX_LIMIT
  );
  // Cursor format: "<block_timestamp>:<id>" (composite keyset). Older single-int
  // cursors (legacy clients) are silently dropped — they'd order by id and
  // produce wrong results against the new (block_timestamp, id) ordering.
  const cursorStr = url.searchParams.get('cursor');
  const cursorMatch = cursorStr ? /^(\d+):(\d+)$/.exec(cursorStr) : null;
  const cursor = cursorMatch ? { ts: Number(cursorMatch[1]), id: Number(cursorMatch[2]) } : null;
  if (cursor != null && (!Number.isSafeInteger(cursor.ts) || !Number.isSafeInteger(cursor.id))) {
    return NextResponse.json({ error: 'invalid cursor' }, { status: 400 });
  }
  // `||` not `??` so an empty `?collection=` falls back to default rather than
  // querying with an empty string (which would match nothing).
  const collection = url.searchParams.get('collection') || 'omb';
  const color = colorParamForSql(parseColorParam(url.searchParams.get('color')));

  const typeParam = url.searchParams.get('type');
  const eventType =
    typeParam === 'sales' ? 'sold' : typeParam === 'transfers' ? 'transferred' : null;
  const loanOnly = typeParam === 'loans';

  // Exact-ID revalidation lets a client reconcile already-loaded pages without
  // downloading the entire feed again. Missing IDs are authoritative: they
  // were deleted or no longer match the active feed predicates.
  if (url.searchParams.has('ids')) {
    const rawIds = url.searchParams.get('ids') ?? '';
    const pieces = rawIds.split(',');
    if (
      pieces.length === 0 ||
      pieces.length > MAX_REVALIDATE_IDS ||
      pieces.some(piece => !/^\d+$/.test(piece))
    ) {
      return NextResponse.json(
        { error: `ids must contain 1-${MAX_REVALIDATE_IDS} positive integers` },
        { status: 400 }
      );
    }
    const ids = [...new Set(pieces.map(Number))];
    if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
      return NextResponse.json({ error: 'invalid event id' }, { status: 400 });
    }
    const events = getEventsByIdsStatement().all({
      ids_json: JSON.stringify(ids),
      collection,
      color,
      mode: loanOnly
        ? 'loans'
        : typeParam === 'sales'
          ? 'sales'
          : typeParam === 'transfers'
            ? 'transfers'
            : 'all',
    }) as EventRow[];
    return NextResponse.json(
      { events, matrica: matricaProfilesForEvents(events, { includeInferred: true }) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const stmts = getStmts();
  const events = (
    loanOnly
      ? cursor != null
        ? stmts.getRecentLoanEventsAfter.all({
            cursor_ts: cursor.ts,
            cursor_id: cursor.id,
            limit,
            collection,
            color,
          })
        : stmts.getRecentLoanEvents.all({ limit, collection, color })
      : eventType
        ? cursor != null
          ? stmts.getRecentEventsByTypeAfter.all({
              cursor_ts: cursor.ts,
              cursor_id: cursor.id,
              limit,
              event_type: eventType,
              collection,
              color,
            })
          : stmts.getRecentEventsByType.all({ limit, event_type: eventType, collection, color })
        : cursor != null
          ? stmts.getRecentEventsAfter.all({
              cursor_ts: cursor.ts,
              cursor_id: cursor.id,
              limit,
              collection,
              color,
            })
          : stmts.getRecentEvents.all({ limit, collection, color })
  ) as EventRow[];

  const next_cursor =
    events.length === limit
      ? `${events[events.length - 1].block_timestamp}:${events[events.length - 1].id}`
      : null;

  // Totals only change when the poller writes — recomputing them on every
  // paginated request is wasted work. Compute them only on first-page (cursor
  // == null) requests, which covers initial mount, filter change, and the
  // 60s head-refresh in useActivityFeed.
  const totals =
    cursor == null
      ? {
          events: (stmts.countEvents.get({ collection, color }) as { n: number }).n,
          holders: (stmts.countHolders.get({ collection, color }) as { n: number }).n,
        }
      : null;
  // ord bookkeeping lives under a single ('ord','omb') row — Phase 4 keeps
  // it collection-agnostic since one batch poll covers every collection.
  const poll = stmts.getPollState.get({
    stream: 'ord',
    collection: 'omb',
  }) as PollStateRow | undefined;

  // Only the first-page (cursor==null) response is worth caching — every
  // cursor is unique, so caching paginated pages just bloats CF storage.
  // 30s + SWR matches the cron cadence (data only changes every 5 min) and
  // the 60s client refreshHead window.
  const headers =
    cursor == null
      ? { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=300' }
      : undefined;

  return NextResponse.json(
    {
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
      matrica: matricaProfilesForEvents(events, { includeInferred: true }),
    },
    headers ? { headers } : undefined
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
