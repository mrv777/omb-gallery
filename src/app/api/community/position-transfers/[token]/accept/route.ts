import { NextRequest, NextResponse } from 'next/server';
import type { AcceptPositionTransferPayloadV1 } from '@/lib/community-purchases/contracts';
import {
  authenticatedCommunityAction,
  communityErrorResponse,
  communityRateLimit,
  requireCommunityBuyerSession,
  requireCommunityEnabled,
} from '@/lib/community-purchases/api';
import { acceptPrivatePositionTransfer } from '@/lib/community-purchases/positionTransferStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const disabled = requireCommunityEnabled();
  if (disabled) return disabled;
  const limited = communityRateLimit(request, 'position-transfer-accept', 5, 30);
  if (limited) return limited;
  try {
    const body = (await request.json().catch(() => null)) as {
      payload?: AcceptPositionTransferPayloadV1;
      signature?: unknown;
    } | null;
    const session = requireCommunityBuyerSession(request);
    const action = authenticatedCommunityAction<AcceptPositionTransferPayloadV1>(request, body);
    const { token } = await context.params;
    const transfer = acceptPrivatePositionTransfer({
      token,
      payload: action.payload,
      signature: action.signature,
      session,
    });
    return NextResponse.json(
      { transfer },
      { headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' } }
    );
  } catch (error) {
    return communityErrorResponse(error);
  }
}
