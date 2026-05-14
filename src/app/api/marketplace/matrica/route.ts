import { NextRequest, NextResponse } from 'next/server';
import { fetchWalletProfile, MatricaError } from '@/lib/matrica';
import { looksLikeAddress } from '@/lib/format';
import { BUYER_COOKIE_NAME, parseBuyerSession } from '@/lib/buyerSession';
import { marketplaceRateLimit, requireMarketplaceEnabled } from '@/lib/marketplace/apiGuards';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const disabled = requireMarketplaceEnabled();
  if (disabled) return disabled;

  const session = parseBuyerSession(req.cookies.get(BUYER_COOKIE_NAME)?.value);
  if (!session) return NextResponse.json({ error: 'connect wallet first' }, { status: 401 });

  const addr = new URL(req.url).searchParams.get('addr');
  if (!addr) return NextResponse.json({ error: 'addr required' }, { status: 400 });
  if (addr !== session.ord_addr) {
    return NextResponse.json({ error: 'wallet mismatch' }, { status: 403 });
  }

  const limited = marketplaceRateLimit(req, 'matrica', 8, 80);
  if (limited) return limited;

  const apiKey = process.env.MATRICA_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ status: 'unknown', reason: 'matrica api not configured' });
  }

  try {
    const profile = await fetchWalletProfile(addr, apiKey);
    if (!profile) return NextResponse.json({ status: 'none' });
    return NextResponse.json({
      status: 'linked',
      profile: {
        username: profile.username,
        avatar_url: profile.avatar_url,
        placeholder: looksLikeAddress(profile.username),
      },
    });
  } catch (err) {
    const message = err instanceof MatricaError ? err.message : 'matrica lookup failed';
    return NextResponse.json({ status: 'unknown', reason: message }, { status: 200 });
  }
}
