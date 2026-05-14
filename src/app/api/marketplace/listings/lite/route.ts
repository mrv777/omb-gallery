import { NextResponse } from 'next/server';
import {
  getMarketplaceLiteListings,
  marketplaceFixtureListingsEnabled,
  marketplaceMockEnabled,
} from '@/lib/marketplace/listings';
import { mockLiteListings } from '@/lib/marketplace/mock';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const fixtureListings = marketplaceFixtureListingsEnabled();
  return NextResponse.json(
    {
      listings: fixtureListings ? mockLiteListings() : getMarketplaceLiteListings(),
      mock: marketplaceMockEnabled(),
    },
    {
      headers: {
        'Cache-Control': 's-maxage=60, stale-while-revalidate=240',
      },
    }
  );
}
