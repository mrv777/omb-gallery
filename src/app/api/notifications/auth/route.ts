import { NextRequest, NextResponse } from 'next/server';
import { parseSession, setCookieHeader } from '@/lib/subscriberSession';
import { log } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Magic-login route. Embedded in the Discord subscribe-confirmation message
// and DM'd by the Telegram /manage command. Lets a user mint the
// `omb_sub_session` cookie on a fresh device/browser without re-onboarding.
//
// The token in `?s=` IS the session cookie value (HMAC-signed, channel +
// channel_target inside) — clicking the link just installs it. Reusable for
// the token's TTL (1 year) so admins can pin the original Discord message.
//
// Threat model: the link is bearer-equivalent for managing subs (mute/unmute
// only — destructive ops still go through unsub_tokens). For Discord, anyone
// with channel-read access already has the webhook URL itself, which is far
// more powerful (full posting rights). For Telegram, /manage DMs the link to
// the user's private chat with the bot, which only they can read.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const raw = url.searchParams.get('s');
  if (!raw) {
    return new NextResponse('Missing token', { status: 400 });
  }
  const session = parseSession(raw);
  if (!session) {
    log.warn('subscribe', 'auth link rejected', {});
    return new NextResponse('Invalid or expired link', { status: 400 });
  }
  // Set the cookie verbatim and bounce to /notifications. The redirect target
  // is same-origin and not user-controlled, so no open-redirect risk.
  const headers = new Headers({
    location: '/notifications',
    // Don't leak the token to /notifications via Referer.
    'referrer-policy': 'no-referrer',
    // CDN/proxy caches must never store this URL — it carries a bearer token
    // in the query string. Browsers still record it in history; that's an
    // accepted residual risk (mute/unmute is the only destructive ceiling
    // this token reaches; nuking subs needs unsub_token).
    'cache-control': 'private, no-store',
  });
  headers.append('set-cookie', setCookieHeader(raw));
  return new NextResponse(null, { status: 302, headers });
}
