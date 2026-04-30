import { NextRequest, NextResponse } from 'next/server';
import { COOKIE_NAME, parseSession } from '@/lib/subscriberSession';
import { resetTargetFailCount, setStatus, type SubStatus } from '@/lib/subscriptionStore';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// PATCH-style endpoint for the /notifications management page. Auth is the
// session cookie + the row's channel_target matching it (so a leaked sub id
// alone can't be used to flip a stranger's row).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: idParam } = await params;
  const id = parseInt(idParam, 10);
  if (!Number.isFinite(id)) return NextResponse.json({ error: 'invalid-id' }, { status: 400 });

  const cookie = req.headers.get('cookie') ?? '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  const session = parseSession(m?.[1]);
  if (!session) return NextResponse.json({ error: 'no-session' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { status?: unknown };
  const newStatus = body.status;
  if (newStatus !== 'muted' && newStatus !== 'active' && newStatus !== 'failed') {
    return NextResponse.json({ error: 'invalid-status' }, { status: 400 });
  }

  const db = getDb();
  const row = db
    .prepare(`SELECT id, channel, channel_target, status FROM subscriptions WHERE id = ?`)
    .get(id) as
    | { id: number; channel: string; channel_target: string; status: SubStatus }
    | undefined;
  if (!row) return NextResponse.json({ error: 'not-found' }, { status: 404 });
  if (row.channel !== session.channel || row.channel_target !== session.channelTarget) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  setStatus(id, newStatus as SubStatus);
  // Reactivating from failed: clear the per-target fail_count so a single
  // transient delivery hiccup doesn't immediately push the row back to failed.
  // (fail_count is bumped per-target without a status filter — see
  // subscriptionStore.bumpFailCount.)
  if (newStatus === 'active' && row.status === 'failed') {
    resetTargetFailCount(session.channel, session.channelTarget);
  }
  return NextResponse.json({ ok: true });
}

