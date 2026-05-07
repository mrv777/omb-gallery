'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/** Reads/writes the gallery favorites-only toggle via the URL `?fav=1` param.
 * Default (off) is the absence of the param so shared URLs stay clean. */
export function useFavoritesOnlyParam(): {
  favoritesOnly: boolean;
  setFavoritesOnly: (next: boolean) => void;
} {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const favoritesOnly = searchParams.get('fav') === '1';

  const setFavoritesOnly = useCallback(
    (next: boolean) => {
      const params = new URLSearchParams(searchParams.toString());
      if (!next) params.delete('fav');
      else params.set('fav', '1');
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  return { favoritesOnly, setFavoritesOnly };
}
