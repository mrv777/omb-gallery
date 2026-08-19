import 'server-only';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  BUYER_COOKIE_NAME,
  parseBuyerSession,
  verifyBuyerSignature,
  type BuyerSession,
} from '@/lib/buyerSession';
import { clientIpKey } from '@/lib/clientIp';
import { checkAndConsumePerIp } from '@/lib/rateLimit';
import { communityMessage } from './contracts';
import { CommunityPurchaseError, communityPurchasesEnabled } from './store';

export function requireCommunityEnabled(): NextResponse | null {
  if (communityPurchasesEnabled()) return null;
  return NextResponse.json(
    { error: 'community purchases disabled' },
    { status: 404, headers: { 'Cache-Control': 'private, no-store' } }
  );
}

export function communityRateLimit(
  request: NextRequest,
  action: string,
  perMinute: number,
  perDay: number
): NextResponse | null {
  const result = checkAndConsumePerIp(
    `community-purchases:${action}`,
    clientIpKey(request.headers),
    perMinute,
    perDay
  );
  if (result.ok) return null;
  return NextResponse.json(
    { error: 'rate limited', retry_after_sec: result.retryAfterSec },
    { status: 429, headers: { 'retry-after': String(result.retryAfterSec) } }
  );
}

export function authenticatedCommunityAction<T extends Parameters<typeof communityMessage>[0]>(
  request: NextRequest,
  body: { payload?: T; signature?: unknown } | null
): { payload: T; signature: string; walletAddress: string } {
  const session = parseBuyerSession(request.cookies.get(BUYER_COOKIE_NAME)?.value);
  if (!session)
    throw new CommunityPurchaseError('wallet-session-required', 'Connect Drey first.', 401);
  const payload = body?.payload;
  const signature = body?.signature;
  if (!payload || typeof signature !== 'string' || signature.length === 0) {
    throw new CommunityPurchaseError('signed-request-required', 'A signed request is required.');
  }
  if (
    !verifyBuyerSignature({
      address: session.ord_addr,
      message: communityMessage(payload),
      signature,
    })
  ) {
    throw new CommunityPurchaseError(
      'signature-invalid',
      'The signed request did not verify.',
      401
    );
  }
  return { payload, signature, walletAddress: session.ord_addr };
}

export function requireCommunityBuyerSession(request: NextRequest): BuyerSession {
  const session = parseBuyerSession(request.cookies.get(BUYER_COOKIE_NAME)?.value);
  if (!session)
    throw new CommunityPurchaseError('wallet-session-required', 'Connect Drey first.', 401);
  return session;
}

export function communityErrorResponse(error: unknown): NextResponse {
  if (error instanceof CommunityPurchaseError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }
  return NextResponse.json(
    { error: 'Community Purchases request failed.' },
    { status: 500, headers: { 'Cache-Control': 'private, no-store' } }
  );
}
