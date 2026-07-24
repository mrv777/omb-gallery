'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { getSeries, type Series } from './series';

/**
 * Reads/writes the gallery's named-sub-series filter via `?series=` so a
 * filtered view is shareable. Mirrors useColorFilter / useSearchQueryParam.
 *
 * A real param rather than stuffing `series:pirates` into `?q=`: it composes
 * with color + favorites without fighting whatever the user typed, keeps the
 * search box clean, and makes ▶ PLAY work on a series for free.
 *
 * An unknown slug resolves to null (= unfiltered) rather than erroring, the
 * same forgiving treatment parseColorParam gives a bad `?color=` — these are
 * shareable URLs and a typo shouldn't be a dead end.
 */
export function useSeriesParam(): {
  series: Series | null;
  setSeries: (next: string | null) => void;
} {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const series = getSeries(searchParams.get('series'));

  const setSeries = useCallback(
    (next: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (!next) params.delete('series');
      else params.set('series', next);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  return { series, setSeries };
}
