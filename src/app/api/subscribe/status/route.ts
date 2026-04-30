import { NextRequest, NextResponse } from 'next/server';
import { clearClaimToken, findByClaimToken } from '@/lib/subscriptionStore';
import { mintSession, setCookieHeader } from '@/lib/subscriberSession';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Source-tab polling endpoint. The browser hits this every few seconds while
// the user is in Telegram tapping /start. Returns 'pending' until the
// telegram-webhook flips the row to 'active', then 200 with a session cookie.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const claim = url.searchParams.get('claim');
  if (!claim) return NextResponse.json({ error: 'claim-required' }, { status: 400 });

  const row = findByClaimToken(claim);
  if (!row) return NextResponse.json({ status: 'unknown' }, { status: 404 });

  if (row.status === 'pending') {
    return NextResponse.json({ status: 'pending' });
  }

  if (row.status === 'active' && row.channel === 'telegram') {
    const sessionValue = mintSession('telegram', row.channel_target);
    const headers = new Headers({ 'content-type': 'application/json' });
    if (sessionValue) headers.append('set-cookie', setCookieHeader(sessionValue));
    // The source tab has now seen the claim and will mint its session — the
    // claim_token has done its job. Clear it so it can't be reused as a
    // bearer that grants unsub_token visibility.
    clearClaimToken(row.id);
    return new NextResponse(
      JSON.stringify({ status: 'claimed', id: row.id, unsubToken: row.unsub_token }),
      { status: 200, headers }
    );
  }

  return NextResponse.json({ status: row.status });
}
