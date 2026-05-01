'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiHolder, ApiInscription } from '@/components/Activity/types';
import type { ColorFilter } from '@/lib/types';
import type { LeaderboardKey } from './types';

const PAGE_SIZE = 50;
// Hard cap for the detail page. The four ranked leaderboards are bounded by
// the collection size (~9k OMBs) and Top Holders by distinct holders (~3.8k);
// 1000 is well past where the long tail becomes uninteresting and bounds DB
// cost from a single tab scrolling indefinitely.
const MAX_TOTAL = 1000;

export type LeaderboardItem = ApiInscription | ApiHolder;

export type LeaderboardFeedState<T extends LeaderboardItem> = {
  items: T[];
  loading: boolean;
  error: string | null;
  reachedEnd: boolean;
  capped: boolean;
};

export type InitialLeaderboard<T extends LeaderboardItem> = {
  items: T[];
  next_cursor: string | null;
};

type ApiLeaderboardResponse<T extends LeaderboardItem> = {
  type: LeaderboardKey;
  items: T[];
  next_cursor: string | null;
};

const itemKey = (item: LeaderboardItem): string =>
  'group_key' in item ? `h:${item.group_key}` : `i:${item.inscription_number}`;

export function useLeaderboardFeed<T extends LeaderboardItem>(
  type: LeaderboardKey,
  color: ColorFilter,
  initial: InitialLeaderboard<T>
) {
  const [state, setState] = useState<LeaderboardFeedState<T>>(() => ({
    items: initial.items,
    loading: false,
    error: null,
    reachedEnd: initial.next_cursor == null || initial.items.length >= MAX_TOTAL,
    capped: initial.items.length >= MAX_TOTAL,
  }));
  const cursorRef = useRef<string | null>(initial.next_cursor);
  const loadingRef = useRef<boolean>(false);
  const seenKeysRef = useRef<Set<string>>(new Set(initial.items.map(itemKey)));
  const colorRef = useRef<ColorFilter>(color);
  // Bumped on any reset so a late response from the previous (color, type)
  // cannot bleed into the new feed.
  const reqGenRef = useRef(0);
  // SSR provides the first page for the current (type, color); skip the very
  // first reset-and-fetch so we don't immediately overwrite the server-rendered
  // list with an identical client fetch.
  const skipInitialReset = useRef<boolean>(true);

  const buildUrl = useCallback(
    (cursor: string | null) => {
      const url = new URL(`/api/explorer/${type}`, window.location.origin);
      url.searchParams.set('limit', String(PAGE_SIZE));
      if (cursor != null) url.searchParams.set('cursor', cursor);
      if (colorRef.current !== 'all') url.searchParams.set('color', colorRef.current);
      return url.toString();
    },
    [type]
  );

  const loadMore = useCallback(async () => {
    if (loadingRef.current) return;
    if (cursorRef.current == null) return;
    loadingRef.current = true;
    setState(prev => ({ ...prev, loading: true }));
    const myGen = reqGenRef.current;
    try {
      const res = await fetch(buildUrl(cursorRef.current));
      if (myGen !== reqGenRef.current) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ApiLeaderboardResponse<T>;
      if (myGen !== reqGenRef.current) return;
      const fresh = data.items.filter(item => !seenKeysRef.current.has(itemKey(item)));
      for (const item of fresh) seenKeysRef.current.add(itemKey(item));
      // Defense against an API that returns a non-null cursor but no new
      // rows (e.g. all returned items were duplicates of already-seen keys
      // — shouldn't happen with our keyset ordering, but a runaway sentinel
      // loop is the bad outcome if we trust the cursor blindly).
      const exhausted = fresh.length === 0;
      setState(prev => {
        const merged = [...prev.items, ...fresh];
        const capped = merged.length >= MAX_TOTAL;
        const trimmed = capped ? merged.slice(0, MAX_TOTAL) : merged;
        // Null out the cursor when we cap or exhaust so the sentinel
        // intersecting again doesn't trigger futile fetches.
        cursorRef.current = capped || exhausted ? null : data.next_cursor;
        return {
          items: trimmed,
          loading: false,
          error: null,
          reachedEnd: data.next_cursor == null || capped || exhausted,
          capped,
        };
      });
    } catch (err) {
      if (myGen !== reqGenRef.current) return;
      setState(prev => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      if (myGen === reqGenRef.current) loadingRef.current = false;
    }
  }, [buildUrl]);

  // Reset on color change. Type doesn't change without a full route swap, so
  // it isn't watched here.
  useEffect(() => {
    if (skipInitialReset.current) {
      skipInitialReset.current = false;
      colorRef.current = color;
      return;
    }
    colorRef.current = color;
    cursorRef.current = null;
    seenKeysRef.current = new Set();
    reqGenRef.current++;
    loadingRef.current = false;
    setState({
      items: [],
      loading: true,
      error: null,
      reachedEnd: false,
      capped: false,
    });
    // After a color change the SSR data is stale — kick off a fresh first
    // page. Inline the fetch to avoid a stale closure on `loadMore`.
    (async () => {
      const myGen = reqGenRef.current;
      loadingRef.current = true;
      try {
        const url = new URL(`/api/explorer/${type}`, window.location.origin);
        url.searchParams.set('limit', String(PAGE_SIZE));
        if (color !== 'all') url.searchParams.set('color', color);
        const res = await fetch(url.toString());
        if (myGen !== reqGenRef.current) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as ApiLeaderboardResponse<T>;
        if (myGen !== reqGenRef.current) return;
        for (const item of data.items) seenKeysRef.current.add(itemKey(item));
        cursorRef.current = data.next_cursor;
        const capped = data.items.length >= MAX_TOTAL;
        setState({
          items: capped ? data.items.slice(0, MAX_TOTAL) : data.items,
          loading: false,
          error: null,
          reachedEnd: data.next_cursor == null || capped,
          capped,
        });
      } catch (err) {
        if (myGen !== reqGenRef.current) return;
        setState({
          items: [],
          loading: false,
          error: err instanceof Error ? err.message : String(err),
          reachedEnd: false,
          capped: false,
        });
      } finally {
        if (myGen === reqGenRef.current) loadingRef.current = false;
      }
    })();
  }, [color, type]);

  return { ...state, loadMore };
}
