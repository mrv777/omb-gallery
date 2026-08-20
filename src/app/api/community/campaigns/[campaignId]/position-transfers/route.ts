import { NextRequest, NextResponse } from 'next/server';
import type { CreatePositionTransferInvitePayloadV1 } from '@/lib/community-purchases/contracts';
import {
  authenticatedCommunityAction,
  communityErrorResponse,
  communityRateLimit,
  requireCommunityBuyerSession,
  requireCommunityEnabled,
} from '@/lib/community-purchases/api';
import {
  createPrivatePositionTransferInvite,
  getPositionTransferForOwner,
} from '@/lib/community-purchases/positionTransferStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const privateHeaders = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
};

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ campaignId: string }> }
) {
  const disabled = requireCommunityEnabled();
  if (disabled) return disabled;
  const limited = communityRateLimit(request, 'position-transfer-owner-view', 30, 300);
  if (limited) return limited;
  try {
    const session = requireCommunityBuyerSession(request);
    const { campaignId } = await context.params;
    const transfer = await getPositionTransferForOwner({ campaignId, session });
    return NextResponse.json({ transfer }, { headers: privateHeaders });
  } catch (error) {
    return communityErrorResponse(error);
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ campaignId: string }> }
) {
  const disabled = requireCommunityEnabled();
  if (disabled) return disabled;
  const limited = communityRateLimit(request, 'position-transfer-create', 3, 20);
  if (limited) return limited;
  try {
    const body = (await request.json().catch(() => null)) as {
      payload?: CreatePositionTransferInvitePayloadV1;
      signature?: unknown;
    } | null;
    const action = authenticatedCommunityAction<CreatePositionTransferInvitePayloadV1>(
      request,
      body
    );
    const { campaignId } = await context.params;
    if (action.payload.campaignId !== campaignId) {
      return NextResponse.json(
        { error: 'campaign mismatch' },
        { status: 400, headers: privateHeaders }
      );
    }
    const created = createPrivatePositionTransferInvite({
      payload: action.payload,
      signature: action.signature,
      walletAddress: action.walletAddress,
    });
    const privateUrl = new URL(
      `/community/transfer/${created.inviteToken}`,
      request.url
    ).toString();
    return NextResponse.json(
      { campaign: created.campaign, transfer_id: created.transferId, private_url: privateUrl },
      { status: 201, headers: privateHeaders }
    );
  } catch (error) {
    return communityErrorResponse(error);
  }
}
