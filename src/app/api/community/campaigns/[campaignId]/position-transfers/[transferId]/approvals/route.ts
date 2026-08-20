import { NextRequest, NextResponse } from 'next/server';
import type { ApprovePositionTransferPayloadV1 } from '@/lib/community-purchases/contracts';
import {
  authenticatedCommunityAction,
  communityErrorResponse,
  communityRateLimit,
  requireCommunityEnabled,
} from '@/lib/community-purchases/api';
import { submitPositionTransferApproval } from '@/lib/community-purchases/positionTransferStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ campaignId: string; transferId: string }> }
) {
  const disabled = requireCommunityEnabled();
  if (disabled) return disabled;
  const limited = communityRateLimit(request, 'position-transfer-approval', 10, 100);
  if (limited) return limited;
  try {
    const body = (await request.json().catch(() => null)) as {
      payload?: ApprovePositionTransferPayloadV1;
      signature?: unknown;
      signed_psbt?: unknown;
    } | null;
    const action = authenticatedCommunityAction<ApprovePositionTransferPayloadV1>(request, body);
    const { campaignId, transferId } = await context.params;
    if (typeof body?.signed_psbt !== 'string') {
      return NextResponse.json({ error: 'signed_psbt required' }, { status: 400 });
    }
    const transfer = submitPositionTransferApproval({
      campaignId,
      transferId,
      payload: action.payload,
      signature: action.signature,
      walletAddress: action.walletAddress,
      signedPsbtBase64: body.signed_psbt,
    });
    return NextResponse.json(
      { transfer },
      { headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' } }
    );
  } catch (error) {
    return communityErrorResponse(error);
  }
}
