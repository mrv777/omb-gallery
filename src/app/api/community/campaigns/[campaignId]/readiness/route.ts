import { NextRequest, NextResponse } from 'next/server';
import type { ConfirmReadinessPayloadV1 } from '@/lib/community-purchases/contracts';
import {
  authenticatedCommunityAction,
  communityErrorResponse,
  communityRateLimit,
  requireCommunityEnabled,
} from '@/lib/community-purchases/api';
import { confirmCommunityReadiness } from '@/lib/community-purchases/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ campaignId: string }> }
) {
  const disabled = requireCommunityEnabled();
  if (disabled) return disabled;
  const limited = communityRateLimit(request, 'readiness', 20, 200);
  if (limited) return limited;
  try {
    const body = (await request.json().catch(() => null)) as {
      payload?: ConfirmReadinessPayloadV1;
      signature?: unknown;
    } | null;
    const action = authenticatedCommunityAction(request, body);
    const { campaignId } = await context.params;
    if (action.payload.campaignId !== campaignId) {
      return NextResponse.json({ error: 'campaign mismatch' }, { status: 400 });
    }
    return NextResponse.json({ campaign: confirmCommunityReadiness(action) });
  } catch (error) {
    return communityErrorResponse(error);
  }
}
