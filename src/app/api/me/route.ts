import { NextRequest, NextResponse } from 'next/server';
import { parseSessionV2, readCookieRaw } from '@/lib/subscriberSession';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Client-readable subscriber state: does this browser have a valid session,
// and which channels does it cover? The cookie itself is HttpOnly so the
// client can't read it directly. No PII surfaced — just the channel set.
//
// `channels` is the deduped set of channels the cookie holds bindings for —
// e.g. ['telegram','discord'] when both are onboarded. NotificationButton
// uses this to show one-click "Subscribe via Telegram"/"Subscribe via
// Discord" for any channel already in the set, instead of forcing a fresh
// onboarding round-trip.
export async function GET(req: NextRequest) {
  const cookieRaw = readCookieRaw(req.headers.get('cookie'));
  const sessionV2 = parseSessionV2(cookieRaw);
  if (!sessionV2 || sessionV2.sessions.length === 0) {
    return NextResponse.json({ hasSession: false, channels: [] as string[] });
  }
  const channelSet = new Set<'telegram' | 'discord'>();
  for (const s of sessionV2.sessions) channelSet.add(s.channel);
  return NextResponse.json({
    hasSession: true,
    channels: Array.from(channelSet),
  });
}
