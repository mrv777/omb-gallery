'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/** Reads/writes the gallery search filter via the URL `?q=` param so a
 * filtered view is shareable. Mirrors useColorFilter; empty/whitespace input
 * deletes the param rather than leaving `?q=` dangling. */
export function useSearchQueryParam(): { query: string; setQuery: (next: string) => void } {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams.get('q') ?? '';

  const setQuery = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString());
      const trimmed = next.trim();
      if (trimmed === '') params.delete('q');
      else params.set('q', trimmed);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  return { query, setQuery };
}
