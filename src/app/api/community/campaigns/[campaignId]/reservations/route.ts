import { NextRequest, NextResponse } from 'next/server';
import type { ReserveUnitsPayloadV1 } from '@/lib/community-purchases/contracts';
import {
  authenticatedCommunityAction,
  communityErrorResponse,
  communityRateLimit,
  requireCommunityEnabled,
} from '@/lib/community-purchases/api';
import { reserveCommunityUnits } from '@/lib/community-purchases/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ campaignId: string }> }
) {
  const disabled = requireCommunityEnabled();
  if (disabled) return disabled;
  const limited = communityRateLimit(request, 'reserve', 10, 100);
  if (limited) return limited;
  try {
    const body = (await request.json().catch(() => null)) as {
      payload?: ReserveUnitsPayloadV1;
      signature?: unknown;
    } | null;
    const action = authenticatedCommunityAction(request, body);
    const { campaignId } = await context.params;
    if (action.payload.campaignId !== campaignId) {
      return NextResponse.json({ error: 'campaign mismatch' }, { status: 400 });
    }
    return NextResponse.json({ campaign: reserveCommunityUnits(action) });
  } catch (error) {
    return communityErrorResponse(error);
  }
}
