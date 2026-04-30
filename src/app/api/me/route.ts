import { NextRequest, NextResponse } from 'next/server';
import { COOKIE_NAME, parseSession } from '@/lib/subscriberSession';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Client-readable subscriber state: does this browser have a valid session,
// and if so on which channel? The cookie itself is HttpOnly so the client
// can't read it directly. No PII surfaced — just channel + a target hash.
export async function GET(req: NextRequest) {
  const cookie = req.headers.get('cookie') ?? '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  const session = parseSession(m?.[1]);
  if (!session) return NextResponse.json({ hasSession: false });
  return NextResponse.json({
    hasSession: true,
    channel: session.channel,
  });
}
