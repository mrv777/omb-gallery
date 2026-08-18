import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import SubpageShell from '@/components/SubpageShell';
import ConnectWalletButton from '@/components/wallet/ConnectWalletButton';
import CommunityHub from '@/components/Community/CommunityHub';
import { newCampaignId, newOwnerId } from '@/lib/community-purchases/contracts';
import { communityPurchasesEnabled, listCommunityCampaigns } from '@/lib/community-purchases/store';
import { getMarketplaceListings } from '@/lib/marketplace/listings';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Group Buys',
  description: 'Buy and hold one OMB together with contributor-controlled Bitcoin custody.',
};

export default function CommunityPage() {
  if (!communityPurchasesEnabled()) notFound();
  return (
    <SubpageShell active="community" headerControls={<ConnectWalletButton compact />}>
      <CommunityHub
        initialCampaigns={listCommunityCampaigns()}
        initialCampaignId={newCampaignId()}
        initialOwnerId={newOwnerId()}
        listings={getMarketplaceListings({ limit: 250 })}
      />
    </SubpageShell>
  );
}
