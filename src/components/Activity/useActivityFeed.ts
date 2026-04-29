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
  const cursorRef = useRef<string | null>(null);
  const loadingRef = useRef<boolean>(false);
  const seenIdsRef = useRef<Set<number>>(new Set());
  const filterRef = useRef<FeedFilter>(filter);
  // Bumped on filter reset so an in-flight fetch's response can be discarded
  // when the filter has changed underneath it.
  const reqGenRef = useRef(0);

  const buildUrl = useCallback(
    (cursor: string | null) => {
      const url = new URL('/api/activity', window.location.origin);
      url.searchParams.set('limit', String(PAGE_SIZE));
      if (cursor != null) url.searchParams.set('cursor', cursor);
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
    const myGen = reqGenRef.current;
    try {
      const res = await fetch(buildUrl(cursorRef.current));
      if (myGen !== reqGenRef.current) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: ApiActivityResponse = await res.json();
      if (myGen !== reqGenRef.current) return;
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
      if (myGen !== reqGenRef.current) return;
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      // Only release the lock if this fetch is still the active generation —
      // otherwise the next-generation loadMore that's already running would
      // have its in-flight flag stomped by a stale fetch resolving late.
      if (myGen === reqGenRef.current) loadingRef.current = false;
    }
  }, [buildUrl]);

  const refreshHead = useCallback(async () => {
    // Pull the first page; prepend any events whose id is greater than what we have.
    // Capture the request generation so a stale response from a previous filter
    // is discarded if the user changed filters mid-flight — otherwise old-filter
    // events would prepend into a freshly-reset feed and pollute seenIdsRef.
    const myGen = reqGenRef.current;
    try {
      const res = await fetch(buildUrl(null));
      if (myGen !== reqGenRef.current) return;
      if (!res.ok) return;
      const data: ApiActivityResponse = await res.json();
      if (myGen !== reqGenRef.current) return;
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
    // Invalidate any in-flight request and clear the lock so the new loadMore
    // can proceed immediately even if the previous fetch is still pending.
    reqGenRef.current++;
    loadingRef.current = false;
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
