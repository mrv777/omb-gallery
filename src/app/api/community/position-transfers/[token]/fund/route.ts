import { NextRequest, NextResponse } from 'next/server';
import {
  communityErrorResponse,
  communityRateLimit,
  requireCommunityBuyerSession,
  requireCommunityEnabled,
} from '@/lib/community-purchases/api';
import { submitPositionTransferBuyerFunding } from '@/lib/community-purchases/positionTransferStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const disabled = requireCommunityEnabled();
  if (disabled) return disabled;
  const limited = communityRateLimit(request, 'position-transfer-fund', 5, 30);
  if (limited) return limited;
  try {
    const session = requireCommunityBuyerSession(request);
    const body = (await request.json().catch(() => null)) as { signed_psbt?: unknown } | null;
    if (typeof body?.signed_psbt !== 'string') {
      return NextResponse.json({ error: 'signed_psbt required' }, { status: 400 });
    }
    const { token } = await context.params;
    const transfer = await submitPositionTransferBuyerFunding({
      token,
      signedPsbtBase64: body.signed_psbt,
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
