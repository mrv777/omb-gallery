import { describe, expect, it } from 'vitest';
import type { MarketplaceListing } from '../src/lib/marketplace/types';
import { estimateMarketplaceBuyerCost } from '../src/lib/marketplace/fees';
import { compareMarketplaceListings, listingRecentAt } from '../src/lib/marketplace/sort';

function listing(
  inscriptionNumber: number,
  priceSats: number,
  listedAt: number,
  optionListedAts: number[]
): MarketplaceListing {
  const primaryEstimate = estimateMarketplaceBuyerCost('satflow', priceSats);
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
    ...primaryEstimate,
    color: null,
    thumbnail: '',
    full: '',
    description: '',
    options: optionListedAts.map((optionListedAt, index) => {
      const marketplace = index === 0 ? 'satflow' : 'ord.net';
      const price = priceSats + index;
      return {
        listing_id: `listing-${inscriptionNumber}-${index}`,
        satflow_id: `listing-${inscriptionNumber}-${index}`,
        price_sats: price,
        seller: null,
        marketplace,
        listed_at: optionListedAt,
        refreshed_at: optionListedAt,
        ...estimateMarketplaceBuyerCost(marketplace, price),
      };
    }),
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

  it('sorts low/high by estimated buyer total instead of raw list price', () => {
    const satflowLowerList = listing(1, 1_000_000, 100, [100]);
    const ordnetHigherList = {
      ...listing(2, 1_005_000, 100, [100]),
      marketplace: 'ord.net',
      options: [
        {
          listing_id: 'ordnet-2',
          satflow_id: 'ordnet-2',
          price_sats: 1_005_000,
          seller: null,
          marketplace: 'ord.net',
          listed_at: 100,
          refreshed_at: 100,
          ...estimateMarketplaceBuyerCost('ord.net', 1_005_000),
        },
      ],
      ...estimateMarketplaceBuyerCost('ord.net', 1_005_000),
    };

    expect(
      [satflowLowerList, ordnetHigherList]
        .toSorted((a, b) => compareMarketplaceListings(a, b, 'price-asc'))
        .map(item => item.inscription_number)
    ).toEqual([2, 1]);
    expect(
      [satflowLowerList, ordnetHigherList]
        .toSorted((a, b) => compareMarketplaceListings(a, b, 'price-desc'))
        .map(item => item.inscription_number)
    ).toEqual([1, 2]);
  });
});
