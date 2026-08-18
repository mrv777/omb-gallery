import { NextResponse } from 'next/server';
import { requireCommunityEnabled } from '@/lib/community-purchases/api';
import { getCommunityCampaign } from '@/lib/community-purchases/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(_request: Request, context: { params: Promise<{ campaignId: string }> }) {
  const disabled = requireCommunityEnabled();
  if (disabled) return disabled;
  return context.params.then(({ campaignId }) => {
    const campaign = getCommunityCampaign(campaignId);
    if (!campaign) return NextResponse.json({ error: 'campaign not found' }, { status: 404 });
    return NextResponse.json(
      { campaign },
      { headers: { 'Cache-Control': 'public, max-age=5, stale-while-revalidate=15' } }
    );
  });
}
