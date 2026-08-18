import { NextRequest, NextResponse } from 'next/server';
import type { CreateCampaignPayloadV1 } from '@/lib/community-purchases/contracts';
import {
  authenticatedCommunityAction,
  communityErrorResponse,
  communityRateLimit,
  requireCommunityEnabled,
} from '@/lib/community-purchases/api';
import { createCommunityCampaign, listCommunityCampaigns } from '@/lib/community-purchases/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() {
  const disabled = requireCommunityEnabled();
  if (disabled) return disabled;
  return NextResponse.json(
    { campaigns: listCommunityCampaigns() },
    { headers: { 'Cache-Control': 'public, max-age=10, stale-while-revalidate=20' } }
  );
}

export async function POST(request: NextRequest) {
  const disabled = requireCommunityEnabled();
  if (disabled) return disabled;
  const limited = communityRateLimit(request, 'create', 3, 20);
  if (limited) return limited;
  try {
    const body = (await request.json().catch(() => null)) as {
      payload?: CreateCampaignPayloadV1;
      signature?: unknown;
    } | null;
    const action = authenticatedCommunityAction(request, body);
    const campaign = await createCommunityCampaign(action);
    return NextResponse.json({ campaign }, { status: 201 });
  } catch (error) {
    return communityErrorResponse(error);
  }
}
