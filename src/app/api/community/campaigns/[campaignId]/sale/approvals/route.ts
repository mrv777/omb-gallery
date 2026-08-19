import { NextRequest, NextResponse } from 'next/server';
import type { ApproveSalePayloadV1 } from '@/lib/community-purchases/contracts';
import {
  authenticatedCommunityAction,
  communityErrorResponse,
  communityRateLimit,
  requireCommunityEnabled,
} from '@/lib/community-purchases/api';
import {
  refreshCommunitySale,
  submitCommunitySaleApproval,
} from '@/lib/community-purchases/saleStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ campaignId: string }> }
) {
  const disabled = requireCommunityEnabled();
  if (disabled) return disabled;
  const limited = communityRateLimit(request, 'sale-approval', 10, 100);
  if (limited) return limited;
  try {
    const body = (await request.json().catch(() => null)) as {
      payload?: ApproveSalePayloadV1;
      signature?: unknown;
      signed_psbt?: unknown;
    } | null;
    const action = authenticatedCommunityAction(request, body);
    const { campaignId } = await context.params;
    if (action.payload.campaignId !== campaignId) {
      return NextResponse.json({ error: 'campaign mismatch' }, { status: 400 });
    }
    if (typeof body?.signed_psbt !== 'string') {
      return NextResponse.json({ error: 'signed_psbt required' }, { status: 400 });
    }
    await refreshCommunitySale({ campaignId });
    const campaign = submitCommunitySaleApproval({
      campaignId,
      payload: action.payload,
      signature: action.signature,
      walletAddress: action.walletAddress,
      signedPsbtBase64: body.signed_psbt,
    });
    return NextResponse.json({ campaign }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return communityErrorResponse(error);
  }
}
