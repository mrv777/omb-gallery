import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import SubpageShell from '@/components/SubpageShell';
import ConnectWalletButton from '@/components/wallet/ConnectWalletButton';
import CommunityCampaign from '@/components/Community/CommunityCampaign';
import { newOwnerId } from '@/lib/community-purchases/contracts';
import { communityPurchasesEnabled, getCommunityCampaign } from '@/lib/community-purchases/store';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}): Promise<Metadata> {
  const { campaignId } = await params;
  const campaign = communityPurchasesEnabled() ? getCommunityCampaign(campaignId) : null;
  return campaign
    ? {
        title: `Group Buy · OMB ${campaign.inscriptionNumber}`,
        description: `${campaign.allocatedUnitCount} of 100 units assigned.`,
      }
    : { title: 'Group Buy' };
}

export default async function CommunityCampaignPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  if (!communityPurchasesEnabled()) notFound();
  const { campaignId } = await params;
  const campaign = getCommunityCampaign(campaignId);
  if (!campaign) notFound();
  return (
    <SubpageShell active="community" headerControls={<ConnectWalletButton compact />}>
      <CommunityCampaign initial={campaign} initialOwnerId={newOwnerId()} />
    </SubpageShell>
  );
}
