import type { MarketplaceListing, MarketplaceSort } from './types';

export function listingRecentAt(
  listing: Pick<MarketplaceListing, 'listed_at' | 'options'>
): number {
  let latest = listing.listed_at;
  for (const option of listing.options) {
    if (option.listed_at > latest) latest = option.listed_at;
  }
  return latest;
}

export function compareMarketplaceListings(
  a: MarketplaceListing,
  b: MarketplaceListing,
  sort: MarketplaceSort
): number {
  if (sort === 'price-desc') {
    return b.price_sats - a.price_sats || a.inscription_number - b.inscription_number;
  }
  if (sort === 'recent') {
    return listingRecentAt(b) - listingRecentAt(a) || a.inscription_number - b.inscription_number;
  }
  return a.price_sats - b.price_sats || a.inscription_number - b.inscription_number;
}
