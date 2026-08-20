import { NextRequest, NextResponse } from 'next/server';
import {
  communityErrorResponse,
  communityRateLimit,
  requireCommunityBuyerSession,
  requireCommunityEnabled,
} from '@/lib/community-purchases/api';
import { authorizePrivatePositionTransfer } from '@/lib/community-purchases/positionTransferStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ campaignId: string; transferId: string }> }
) {
  const disabled = requireCommunityEnabled();
  if (disabled) return disabled;
  const limited = communityRateLimit(request, 'position-transfer-authorize', 5, 30);
  if (limited) return limited;
  try {
    const session = requireCommunityBuyerSession(request);
    const body = (await request.json().catch(() => null)) as { signature?: unknown } | null;
    if (typeof body?.signature !== 'string' || body.signature.length === 0) {
      return NextResponse.json({ error: 'signature required' }, { status: 400 });
    }
    const { campaignId, transferId } = await context.params;
    const transfer = await authorizePrivatePositionTransfer({
      campaignId,
      transferId,
      signature: body.signature,
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
