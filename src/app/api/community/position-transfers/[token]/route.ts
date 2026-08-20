import { NextRequest, NextResponse } from 'next/server';
import { BUYER_COOKIE_NAME, parseBuyerSession } from '@/lib/buyerSession';
import {
  communityErrorResponse,
  communityRateLimit,
  requireCommunityEnabled,
} from '@/lib/community-purchases/api';
import { getPrivatePositionTransferByToken } from '@/lib/community-purchases/positionTransferStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const disabled = requireCommunityEnabled();
  if (disabled) return disabled;
  const limited = communityRateLimit(request, 'position-transfer-private-view', 30, 300);
  if (limited) return limited;
  try {
    const { token } = await context.params;
    const session = parseBuyerSession(request.cookies.get(BUYER_COOKIE_NAME)?.value);
    const transfer = await getPrivatePositionTransferByToken({ token, session });
    return NextResponse.json(
      { transfer },
      { headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' } }
    );
  } catch (error) {
    return communityErrorResponse(error);
  }
}
