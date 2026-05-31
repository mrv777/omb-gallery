import { describe, expect, it } from 'vitest';
import type { MarketplaceListing } from '../src/lib/marketplace/types';
import { compareMarketplaceListings, listingRecentAt } from '../src/lib/marketplace/sort';

function listing(
  inscriptionNumber: number,
  priceSats: number,
  listedAt: number,
  optionListedAts: number[]
): MarketplaceListing {
  return {
    inscription_number: inscriptionNumber,
    inscription_id: `${String(inscriptionNumber).padStart(64, '0')}i0`,
    listing_id: `listing-${inscriptionNumber}`,
    satflow_id: `listing-${inscriptionNumber}`,
    price_sats: priceSats,
    seller: null,
    marketplace: 'satflow',
    listed_at: listedAt,
    refreshed_at: listedAt,
    color: null,
    thumbnail: '',
    full: '',
    description: '',
    options: optionListedAts.map((optionListedAt, index) => ({
      listing_id: `listing-${inscriptionNumber}-${index}`,
      satflow_id: `listing-${inscriptionNumber}-${index}`,
      price_sats: priceSats + index,
      seller: null,
      marketplace: index === 0 ? 'satflow' : 'ord.net',
      listed_at: optionListedAt,
      refreshed_at: optionListedAt,
    })),
  };
}

describe('marketplace listing sort helpers', () => {
  it('uses the latest option timestamp for recent sorting', () => {
    const olderPrimaryNewerSecondary = listing(1, 1_000_000, 100, [100, 300]);
    const newerPrimaryOnly = listing(2, 1_000_000, 200, [200]);

    expect(listingRecentAt(olderPrimaryNewerSecondary)).toBe(300);
    expect(
      [newerPrimaryOnly, olderPrimaryNewerSecondary]
        .toSorted((a, b) => compareMarketplaceListings(a, b, 'recent'))
        .map(item => item.inscription_number)
    ).toEqual([1, 2]);
  });
});
