import { NextRequest, NextResponse } from 'next/server';
import {
  communityErrorResponse,
  communityRateLimit,
  requireCommunityBuyerSession,
  requireCommunityEnabled,
} from '@/lib/community-purchases/api';
import { cancelPositionTransfer } from '@/lib/community-purchases/positionTransferStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ campaignId: string; transferId: string }> }
) {
  const disabled = requireCommunityEnabled();
  if (disabled) return disabled;
  const limited = communityRateLimit(request, 'position-transfer-cancel', 5, 30);
  if (limited) return limited;
  try {
    const session = requireCommunityBuyerSession(request);
    const { campaignId, transferId } = await context.params;
    const campaign = cancelPositionTransfer({ campaignId, transferId, session });
    return NextResponse.json(
      { campaign },
      { headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' } }
    );
  } catch (error) {
    return communityErrorResponse(error);
  }
}
