'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiActivityResponse, ApiEvent } from './types';

const PAGE_SIZE = 60;
const REFRESH_MS = 60_000;

export type FeedFilter = 'all' | 'sales' | 'transfers';

export type FeedState = {
  events: ApiEvent[];
  totals: { events: number; holders: number } | null;
  poll: ApiActivityResponse['poll'];
  loading: boolean;
  error: string | null;
  reachedEnd: boolean;
};

export function useActivityFeed(filter: FeedFilter = 'all') {
  const [state, setState] = useState<FeedState>({
    events: [],
    totals: null,
    poll: null,
    loading: true,
    error: null,
    reachedEnd: false,
  });
  const cursorRef = useRef<number | null>(null);
  const loadingRef = useRef<boolean>(false);
  const seenIdsRef = useRef<Set<number>>(new Set());
  const filterRef = useRef<FeedFilter>(filter);

  const buildUrl = useCallback(
    (cursor: number | null) => {
      const url = new URL('/api/activity', window.location.origin);
      url.searchParams.set('limit', String(PAGE_SIZE));
      if (cursor != null) url.searchParams.set('cursor', String(cursor));
      if (filterRef.current !== 'all') url.searchParams.set('type', filterRef.current);
      return url.toString();
    },
    []
  );

  const loadMore = useCallback(async () => {
    if (loadingRef.current) return;
    // Don't paginate past the end; refreshHead handles new items at the top.
    if (cursorRef.current == null && seenIdsRef.current.size > 0) return;
    loadingRef.current = true;
    try {
      const res = await fetch(buildUrl(cursorRef.current));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: ApiActivityResponse = await res.json();
      const fresh = data.events.filter((e) => !seenIdsRef.current.has(e.id));
      for (const e of fresh) seenIdsRef.current.add(e.id);
      cursorRef.current = data.next_cursor;
      setState((prev) => ({
        ...prev,
        events: [...prev.events, ...fresh],
        // The API only returns totals on first-page requests; preserve the last
        // value we saw so paginated responses don't blank the header.
        totals: data.totals ?? prev.totals,
        poll: data.poll,
        loading: false,
        error: null,
        reachedEnd: data.next_cursor == null,
      }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      loadingRef.current = false;
    }
  }, [buildUrl]);

  const refreshHead = useCallback(async () => {
    // Pull the first page; prepend any events whose id is greater than what we have.
    try {
      const res = await fetch(buildUrl(null));
      if (!res.ok) return;
      const data: ApiActivityResponse = await res.json();
      const newOnes = data.events.filter((e) => !seenIdsRef.current.has(e.id));
      if (newOnes.length === 0) {
        setState((prev) => ({ ...prev, totals: data.totals, poll: data.poll }));
        return;
      }
      for (const e of newOnes) seenIdsRef.current.add(e.id);
      setState((prev) => ({
        ...prev,
        events: [...newOnes, ...prev.events],
        totals: data.totals,
        poll: data.poll,
      }));
    } catch {
      // refresh failures are silent
    }
  }, [buildUrl]);

  // Reset on filter change so a new fetch starts from the top.
  useEffect(() => {
    filterRef.current = filter;
    cursorRef.current = null;
    seenIdsRef.current = new Set();
    setState({
      events: [],
      totals: null,
      poll: null,
      loading: true,
      error: null,
      reachedEnd: false,
    });
    loadMore();
  }, [filter, loadMore]);

  // Periodic head-refresh while tab is visible
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(refreshHead, REFRESH_MS);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };
    onVis();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [refreshHead]);

  return { ...state, loadMore };
}
