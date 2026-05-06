'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ColorFilter } from './types';
import { parseColorParam } from './colorFilter';
import { useNavigationStart } from '@/components/NavigationProgress';

/** Reads/writes the color filter via the URL `?color=` param. Single source
 * of truth across gallery, activity, and explorer so a filter set on one
 * page persists into the others. */
export function useColorFilter(): { color: ColorFilter; setColor: (next: ColorFilter) => void } {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const startNavigation = useNavigationStart();
  const color = parseColorParam(searchParams.get('color'));

  const setColor = useCallback(
    (next: ColorFilter) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === 'all') params.delete('color');
      else params.set('color', next);
      const qs = params.toString();
      // replace() so the back button doesn't fill up with one entry per
      // swatch click. scroll:false keeps the user's scroll position when
      // toggling filters.
      // Server-rendered pages (/activity, /explorer) re-run their SQL on every
      // color change — surface that as a pending nav. The gallery is fully
      // client-side so the bar's 150ms threshold suppresses the flash there.
      startNavigation();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams, startNavigation]
  );

  return { color, setColor };
}
