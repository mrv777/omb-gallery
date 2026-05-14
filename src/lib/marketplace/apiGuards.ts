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
