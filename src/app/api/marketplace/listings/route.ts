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
import { compareMarketplaceListings } from '@/lib/marketplace/sort';

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
  return filtered.toSorted((a, b) => compareMarketplaceListings(a, b, sort));
}
