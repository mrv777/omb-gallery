'use client';

import { useEffect, useMemo, useState } from 'react';
import type { MarketplaceLiteListing } from '@/lib/marketplace/types';

export function useListings() {
  const [listings, setListings] = useState<MarketplaceLiteListing[]>([]);

  useEffect(() => {
    if (
      process.env.NEXT_PUBLIC_MARKETPLACE_ENABLED !== 'true' &&
      process.env.NEXT_PUBLIC_MARKETPLACE_MOCK !== 'true'
    ) {
      return;
    }
    let cancelled = false;
    fetch('/api/marketplace/listings/lite')
      .then(res => (res.ok ? res.json() : null))
      .then(json => {
        if (!cancelled && Array.isArray(json?.listings)) {
          setListings(json.listings as MarketplaceLiteListing[]);
        }
      })
      .catch(() => {
        if (!cancelled) setListings([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(() => {
    const map = new Map<number, MarketplaceLiteListing>();
    for (const listing of listings) map.set(listing.inscription_number, listing);
    return map;
  }, [listings]);
}
