import { NextResponse } from 'next/server';
import { getMarketplaceLiteListings, marketplaceMockEnabled } from '@/lib/marketplace/listings';
import { mockLiteListings } from '@/lib/marketplace/mock';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const mock = marketplaceMockEnabled();
  return NextResponse.json(
    {
      listings: mock ? mockLiteListings() : getMarketplaceLiteListings(),
      mock,
    },
    {
      headers: {
        'Cache-Control': 's-maxage=60, stale-while-revalidate=240',
      },
    }
  );
}
