import type { MarketplaceListing, MarketplaceSort } from './types';
import { cheapestBuyerCostOption, highestBuyerCostOption } from './fees';

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
    return (
      highestBuyerCostOption(b.options).estimated_buyer_total_sats -
        highestBuyerCostOption(a.options).estimated_buyer_total_sats ||
      a.inscription_number - b.inscription_number
    );
  }
  if (sort === 'recent') {
    return listingRecentAt(b) - listingRecentAt(a) || a.inscription_number - b.inscription_number;
  }
  return (
    cheapestBuyerCostOption(a.options).estimated_buyer_total_sats -
      cheapestBuyerCostOption(b.options).estimated_buyer_total_sats ||
    a.inscription_number - b.inscription_number
  );
}
