import { NextRequest, NextResponse } from 'next/server';
import {
  getMarketplaceListings,
  getMarketplaceStats,
  marketplaceFixtureListingsEnabled,
  marketplaceMockEnabled,
  normalizeMarketplaceSort,
} from '@/lib/marketplace/listings';
import { requireMarketplaceEnabled } from '@/lib/marketplace/apiGuards';
import { mockListings, mockStats } from '@/lib/marketplace/mock';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const disabled = requireMarketplaceEnabled();
  if (disabled) return disabled;

  const url = new URL(req.url);
  const sort = normalizeMarketplaceSort(url.searchParams.get('sort'));
  const color = url.searchParams.get('color');
  const fixtureListings = marketplaceFixtureListingsEnabled();
  const listings = fixtureListings
    ? filterMockListings(mockListings(), color, sort)
    : getMarketplaceListings({ color, sort });
  const stats = fixtureListings ? mockStats() : getMarketplaceStats();

  return NextResponse.json(
    { listings, stats, mock: marketplaceMockEnabled() },
    {
      headers: {
        'Cache-Control': 'private, no-store',
      },
    }
  );
}

function filterMockListings(
  listings: ReturnType<typeof mockListings>,
  color: string | null,
  sort: ReturnType<typeof normalizeMarketplaceSort>
) {
  const filtered =
    color && color !== 'all' ? listings.filter(listing => listing.color === color) : listings;
  return filtered.toSorted((a, b) => {
    if (sort === 'price-desc')
      return b.price_sats - a.price_sats || a.inscription_number - b.inscription_number;
    if (sort === 'recent')
      return b.listed_at - a.listed_at || a.inscription_number - b.inscription_number;
    return a.price_sats - b.price_sats || a.inscription_number - b.inscription_number;
  });
}
