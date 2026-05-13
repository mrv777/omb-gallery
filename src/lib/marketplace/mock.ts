import 'server-only';

import { getInscriptionLookup, lookupInscription } from '@/lib/inscriptionLookup';
import type {
  BroadcastResponse,
  CreateIntentResponse,
  MarketplaceListing,
  MarketplaceLiteListing,
  MarketplaceStats,
} from './types';

export const MOCK_ENABLED = process.env.MARKETPLACE_MOCK === 'true';

const MOCK_PRICES = [
  790_000, 850_000, 910_000, 990_000, 1_100_000, 1_250_000, 1_420_000, 1_580_000, 1_750_000,
  1_900_000, 2_100_000, 2_350_000, 2_600_000, 2_900_000, 3_200_000, 3_650_000, 4_100_000, 4_700_000,
  5_300_000, 6_000_000, 6_900_000, 7_900_000, 9_100_000, 10_500_000, 12_200_000, 14_100_000,
  16_000_000, 18_500_000, 21_000_000, 25_000_000,
];

const SELLERS = [
  'bc1pseller0000000000000000000000000000000000000000000000000000qqq',
  'bc1qmockmarket0000000000000000000000000000000xy42',
];

export function mockListings(): MarketplaceListing[] {
  const picks = pickMockNumbers();
  const now = Math.floor(Date.now() / 1000);
  const listings: MarketplaceListing[] = [];
  for (let i = 0; i < picks.length; i++) {
    const num = picks[i];
    const hit = lookupInscription(num);
    if (!hit || hit.kind !== 'omb') continue;
    const marketplace = i % 5 === 0 ? 'ord.net' : 'satflow';
    const listingId = `mock-${marketplace === 'ord.net' ? 'on' : 'sf'}-${num}`;
    listings.push({
      inscription_number: num,
      inscription_id: hit.inscriptionId ?? `mock-${num}`,
      listing_id: listingId,
      satflow_id: listingId,
      price_sats: MOCK_PRICES[i % MOCK_PRICES.length],
      seller: SELLERS[i % SELLERS.length],
      marketplace,
      listed_at: now - i * 3_900,
      refreshed_at: now - 45,
      color: normalizeColor(hit.color),
      thumbnail: hit.thumbnail,
      full: hit.full,
      description: hit.description,
    });
  }
  return listings;
}

export function mockLiteListings(): MarketplaceLiteListing[] {
  return mockListings().map(listing => ({
    inscription_number: listing.inscription_number,
    price_sats: listing.price_sats,
    marketplace: listing.marketplace,
    refreshed_at: listing.refreshed_at,
  }));
}

export function mockStats(): MarketplaceStats {
  const listings = mockListings();
  const floor = listings.reduce<number | null>(
    (min, listing) => (min == null ? listing.price_sats : Math.min(min, listing.price_sats)),
    null
  );
  return {
    floor_sats: floor,
    listed_count: listings.length,
    volume_24h_sats: 24_300_000,
    refreshed_at: listings[0]?.refreshed_at ?? null,
  };
}

export function mockListing(inscriptionNumber: number): MarketplaceListing | null {
  return mockListings().find(listing => listing.inscription_number === inscriptionNumber) ?? null;
}

export function mockIntentResponse(args: {
  intentId: number;
  listing: MarketplaceListing;
}): CreateIntentResponse {
  return {
    intent_id: args.intentId,
    psbt: 'mock-psbt-signing-is-client-stubbed',
    listing: args.listing,
    mock: true,
  };
}

export function mockBroadcast(intentId: number): BroadcastResponse {
  return {
    intent_id: intentId,
    txid: `mock-${Date.now().toString(16)}-${intentId}`,
    mock: true,
  };
}

function pickMockNumbers(): number[] {
  const byColor = new Map<string, number[]>();
  for (const [num, hit] of Array.from(getInscriptionLookup())) {
    if (hit.kind !== 'omb' || !hit.color) continue;
    const list = byColor.get(hit.color) ?? [];
    list.push(num);
    byColor.set(hit.color, list);
  }

  const colors = ['red', 'blue', 'green', 'orange', 'black'];
  const out: number[] = [];
  for (const color of colors) {
    const nums = (byColor.get(color) ?? []).sort((a, b) => a - b);
    if (nums.length === 0) continue;
    const stride = Math.max(1, Math.floor(nums.length / 6));
    for (let i = 0; i < 6 && i * stride < nums.length; i++) {
      out.push(nums[i * stride]);
    }
  }
  return out.slice(0, 30);
}

function normalizeColor(color: string | null): MarketplaceListing['color'] {
  if (
    color === 'red' ||
    color === 'blue' ||
    color === 'green' ||
    color === 'orange' ||
    color === 'black'
  ) {
    return color;
  }
  return null;
}
