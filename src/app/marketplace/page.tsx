import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import SubpageShell from '@/components/SubpageShell';
import ConnectWalletButton from '@/components/wallet/ConnectWalletButton';
import MarketplaceGrid from '@/components/Marketplace/MarketplaceGrid';
import MockBanner from '@/components/Marketplace/MockBanner';
import {
  getMarketplaceListings,
  getMarketplaceStats,
  marketplaceEnabled,
  marketplaceMockEnabled,
} from '@/lib/marketplace/listings';
import { mockListings, mockStats } from '@/lib/marketplace/mock';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Marketplace',
  description: 'Buy listed Ordinal Maxi Biz inscriptions.',
};

const DEFAULT_DISCORD_INVITE_URL = 'https://discord.gg/ordinalmaxibiz';

export default function MarketplacePage() {
  if (!marketplaceEnabled()) notFound();
  const mock = marketplaceMockEnabled();
  const listings = mock ? mockListings() : getMarketplaceListings({ sort: 'price-asc' });
  const stats = mock ? mockStats() : getMarketplaceStats();

  return (
    <SubpageShell
      active="marketplace"
      headerControls={
        <div className="flex shrink-0">
          <ConnectWalletButton compact />
        </div>
      }
    >
      <MockBanner />
      <MarketplaceGrid
        initialListings={listings}
        initialStats={stats}
        discordInviteUrl={
          process.env.DISCORD_INVITE_URL ??
          process.env.NEXT_PUBLIC_DISCORD_INVITE_URL ??
          DEFAULT_DISCORD_INVITE_URL
        }
        matricaSignupUrl={process.env.MATRICA_SIGNUP_URL ?? 'https://matrica.io/settings'}
      />
    </SubpageShell>
  );
}
