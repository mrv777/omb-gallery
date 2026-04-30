import { NextRequest, NextResponse } from 'next/server';
import {
  discordWebhookSummaries,
  parseSessionV2,
  readCookieRaw,
} from '@/lib/subscriberSession';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Client-readable subscriber state. The cookie is HttpOnly so the client
// can't read it directly; this endpoint exposes only the minimum the UI
// needs to render the right onboarding state.
//
//   channels         — set of channels the cookie holds bindings for
//   discordWebhooks  — { id, tokenSuffix } per Discord binding. The id is
//                      the numeric portion of the webhook URL (public-ish —
//                      useless without the token). The suffix gives users
//                      a 4-char tail to disambiguate when they have several
//                      webhooks in the same browser. The full URL never
//                      leaves the server, so XSS can't exfiltrate it.
export async function GET(req: NextRequest) {
  const cookieRaw = readCookieRaw(req.headers.get('cookie'));
  const sessionV2 = parseSessionV2(cookieRaw);
  if (!sessionV2 || sessionV2.sessions.length === 0) {
    return NextResponse.json({
      hasSession: false,
      channels: [] as string[],
      discordWebhooks: [] as Array<{ id: string; tokenSuffix: string }>,
    });
  }
  const channelSet = new Set<'telegram' | 'discord'>();
  for (const s of sessionV2.sessions) channelSet.add(s.channel);
  return NextResponse.json({
    hasSession: true,
    channels: Array.from(channelSet),
    discordWebhooks: discordWebhookSummaries(sessionV2),
  });
}
