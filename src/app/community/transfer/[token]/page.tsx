import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import SubpageShell from '@/components/SubpageShell';
import ConnectWalletButton from '@/components/wallet/ConnectWalletButton';
import CommunityPositionTransfer from '@/components/Community/CommunityPositionTransfer';
import { newOwnerId } from '@/lib/community-purchases/contracts';
import { communityPurchasesEnabled } from '@/lib/community-purchases/store';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Private ownership transfer · OMB',
  description: 'Private Community Vault ownership invitation.',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default async function CommunityPositionTransferPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  if (!communityPurchasesEnabled()) notFound();
  const { token } = await params;
  return (
    <SubpageShell active="community" headerControls={<ConnectWalletButton compact />}>
      <CommunityPositionTransfer token={token} initialOwnerId={newOwnerId()} />
    </SubpageShell>
  );
}
