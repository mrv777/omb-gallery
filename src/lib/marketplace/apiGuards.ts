import 'server-only';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { clientIpKey } from '@/lib/clientIp';
import { checkAndConsumePerIp } from '@/lib/rateLimit';
import { marketplaceEnabled } from './listings';

export function requireMarketplaceEnabled(): NextResponse | null {
  if (marketplaceEnabled()) return null;
  return NextResponse.json(
    { error: 'marketplace disabled' },
    {
      status: 404,
      headers: { 'Cache-Control': 'private, no-store' },
    }
  );
}

export function requireMarketplaceSellingEnabled(): NextResponse | null {
  if (process.env.MARKETPLACE_SELL_ENABLED === 'true') return null;
  return NextResponse.json(
    { error: 'marketplace selling disabled' },
    { status: 404, headers: { 'Cache-Control': 'private, no-store' } }
  );
}

/** Seller writes rely on HttpOnly cookies, so require an exact browser Origin. */
export function requireExactOrigin(req: NextRequest): NextResponse | null {
  const origin = req.headers.get('origin');
  const configured =
    process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.NODE_ENV === 'production' ? 'https://ordinalmaxibiz.wiki' : req.nextUrl.origin);
  let expected: string;
  try {
    expected = new URL(configured).origin;
  } catch {
    return NextResponse.json(
      { error: 'server origin is not configured', code: 'invalid-request' },
      { status: 500 }
    );
  }
  if (origin === expected) return null;
  return NextResponse.json(
    { error: 'request origin mismatch', code: 'invalid-request' },
    { status: 403, headers: { 'Cache-Control': 'private, no-store' } }
  );
}

/** Stay below ord.net's 8 writes/profile/minute quota, independent of source IP. */
export function ordnetSellerProfileRateLimit(profileKey: string): NextResponse | null {
  const check = checkAndConsumePerIp('marketplace:ordnet-seller-profile', profileKey, 7, 500);
  if (check.ok) return null;
  return NextResponse.json(
    { error: 'rate limited', code: 'rate-limit', retry_after_sec: check.retryAfterSec },
    { status: 429, headers: { 'retry-after': String(check.retryAfterSec) } }
  );
}

/** Wallet sign-in is shared by Marketplace and Community Purchases. */
export function requireWalletSessionsEnabled(): NextResponse | null {
  if (
    marketplaceEnabled() ||
    process.env.COMMUNITY_PURCHASES_ENABLED === 'true' ||
    process.env.NEXT_PUBLIC_COMMUNITY_PURCHASES_ENABLED === 'true'
  ) {
    return null;
  }
  return NextResponse.json(
    { error: 'wallet sessions disabled' },
    { status: 404, headers: { 'Cache-Control': 'private, no-store' } }
  );
}

export function marketplaceRateLimit(
  req: NextRequest,
  feature: string,
  perMin: number,
  perDay: number
): NextResponse | null {
  const ip = clientIpKey(req.headers);
  const check = checkAndConsumePerIp(`marketplace:${feature}`, ip, perMin, perDay);
  if (check.ok) return null;
  return NextResponse.json(
    { error: 'rate limited', retry_after_sec: check.retryAfterSec },
    { status: 429, headers: { 'retry-after': String(check.retryAfterSec) } }
  );
}
