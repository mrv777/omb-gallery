import type { Metadata } from 'next';
import ActivityFeed from '@/components/Activity/ActivityFeed';
import SubpageShell from '@/components/SubpageShell';
import HeaderColorSwatches from '@/components/HeaderColorSwatches';
import { getStmts, type EventRow, type PollStateRow } from '@/lib/db';
import { matricaProfilesForEvents } from '@/lib/matricaOverlay';
import type { InitialActivity } from '@/components/Activity/useActivityFeed';
import type { ColorFilter } from '@/lib/types';
import { colorParamForSql, parseColorParam } from '@/lib/colorFilter';

export const metadata: Metadata = {
  title: 'Activity · OMB Archive',
  description: 'On-chain activity for Ordinal Maxi Biz: transfers, sales, and inscriptions.',
};

// Skip build-time pre-rendering — DB lives at /data/app.db, not present in
// the build container. Per-request SSR is fast and the client refreshHead
// still polls /api/activity (which IS cached at the CF edge) for live updates.
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 60;
const COLLECTION = 'omb';

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ color?: string }>;
}) {
  const sp = await searchParams;
  const color = parseColorParam(sp.color);
  const initial = loadInitialActivity(color);
  return (
    <SubpageShell active="activity" color={color} headerControls={<HeaderColorSwatches />}>
      <ActivityFeed initial={initial} />
    </SubpageShell>
  );
}

function loadInitialActivity(color: ColorFilter): InitialActivity {
  const stmts = getStmts();
  const colorParam = colorParamForSql(color);
  const events = stmts.getRecentEvents.all({
    limit: PAGE_SIZE,
    collection: COLLECTION,
    color: colorParam,
  }) as EventRow[];
  const totals = {
    events: (stmts.countEvents.get({ collection: COLLECTION, color: colorParam }) as { n: number })
      .n,
    holders: (
      stmts.countHolders.get({ collection: COLLECTION, color: colorParam }) as { n: number }
    ).n,
  };
  const pollRow = stmts.getPollState.get({ stream: 'ord', collection: 'omb' }) as
    | PollStateRow
    | undefined;
  const next_cursor =
    events.length === PAGE_SIZE
      ? `${events[events.length - 1].block_timestamp}:${events[events.length - 1].id}`
      : null;
  return {
    events,
    next_cursor,
    totals,
    poll: pollRow
      ? {
          last_run_at: pollRow.last_run_at,
          last_status: pollRow.last_status,
          last_event_count: pollRow.last_event_count,
          is_backfilling: pollRow.is_backfilling === 1,
        }
      : null,
    matrica: matricaProfilesForEvents(events),
  };
}
