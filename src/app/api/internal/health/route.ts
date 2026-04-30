import { NextResponse } from 'next/server';
import { getDb, getOrdState, type PollStateRow } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Stream-specific staleness thresholds (seconds). These are 2x the natural
// cadence: cron polls ord+satflow every 5min (=> stale > 10min), the listings
// tick has a 15min interval (=> stale > 30min), matrica runs daily
// (=> stale > 2 days), and notify rides the 5min auto tick (=> stale > 15min,
// 3x the cron with slack).
const STALE_THRESHOLD_SEC: Record<string, number> = {
  ord: 600,
  satflow: 600,
  satflow_listings: 1800,
  matrica: 2 * 24 * 60 * 60,
  notify: 900,
};
const DEFAULT_STALE_SEC = 600;

// ord-vs-bitcoind index lag thresholds (in blocks). Lag > 50 (~8h drift) is
// worth a warn; > 1000 (~7 days) means the gallery is missing a meaningful
// chunk of recent on-chain activity and rolls the global status to degraded.
const ORD_LAG_WARN_BLOCKS = 50;
const ORD_LAG_DEGRADED_BLOCKS = 1000;

type StreamStatus = {
  stream: string;
  collection: string;
  last_run_at: number | null;
  age_s: number | null;
  last_status: string | null;
  last_event_count: number | null;
  is_backfilling: boolean;
  last_known_height: number | null;
  stale: boolean;
  // ord-only extras (null on other streams)
  ord_index_tip?: number | null;
  bitcoind_tip?: number | null;
  ord_lag_blocks?: number | null;
  heal_cursor?: number | null;
  heal_completed_at?: number | null;
};

export async function GET() {
  const now = Math.floor(Date.now() / 1000);
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT stream, collection_slug, last_run_at, last_status, last_event_count,
              is_backfilling, last_known_height
       FROM poll_state
       ORDER BY stream, collection_slug`
    )
    .all() as PollStateRow[];

  const ordState = getOrdState();

  const streams: StreamStatus[] = rows.map(r => {
    const age = r.last_run_at == null ? null : now - r.last_run_at;
    const threshold = STALE_THRESHOLD_SEC[r.stream] ?? DEFAULT_STALE_SEC;
    const base: StreamStatus = {
      stream: r.stream,
      collection: r.collection_slug,
      last_run_at: r.last_run_at,
      age_s: age,
      last_status: r.last_status,
      last_event_count: r.last_event_count,
      is_backfilling: r.is_backfilling === 1,
      last_known_height: r.last_known_height,
      stale: age == null || age > threshold,
    };
    if (r.stream === 'ord' && r.collection_slug === 'omb') {
      const ordTip = r.last_known_height;
      const btcTip = ordState.bitcoindTip;
      base.ord_index_tip = ordTip;
      base.bitcoind_tip = btcTip;
      base.ord_lag_blocks = ordTip != null && btcTip != null ? Math.max(0, btcTip - ordTip) : null;
      base.heal_cursor = ordState.healCursor;
      base.heal_completed_at = ordState.healCompletedAt;
    }
    return base;
  });

  // Roll-up status: ok if all fresh + last_status==='ok'-like; degraded if any
  // stream is stale, non-ok, or ord lag exceeds threshold; never 'down' (passive
  // read can't tell us that).
  const anyStale = streams.some(s => s.stale);
  const anyError = streams.some(s => s.last_status != null && !s.last_status.startsWith('ok'));
  const ordLag = streams.find(s => s.stream === 'ord')?.ord_lag_blocks ?? 0;
  const lagDegraded = ordLag > ORD_LAG_DEGRADED_BLOCKS;
  const lagWarn = ordLag > ORD_LAG_WARN_BLOCKS;
  const status = anyStale || lagDegraded ? 'degraded' : anyError || lagWarn ? 'warn' : 'ok';

  return NextResponse.json({
    status,
    now,
    streams,
  });
}
