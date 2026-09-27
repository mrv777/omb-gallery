'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiActivityResponse, ApiEvent, ApiMatricaMap } from './types';
import type { ColorFilter } from '@/lib/types';

const PAGE_SIZE = 60;
const REFRESH_MS = 60_000;
const REVALIDATE_BATCH_SIZE = 200;

export type FeedFilter = 'all' | 'sales' | 'transfers' | 'loans';

export type FeedState = {
  events: ApiEvent[];
  totals: { events: number; holders: number } | null;
  poll: ApiActivityResponse['poll'];
  /** Wallet → Matrica display data. Accumulates across pages: each fetch
   * adds entries for newly-seen addresses and never removes them, so once
   * a row's username overlay is loaded it stays for the session. */
  matrica: ApiMatricaMap;
  loading: boolean;
  error: string | null;
  reachedEnd: boolean;
};

// Server-rendered first-page payload. The page passes this in so the feed
// hydrates already populated and there's no loading flash on initial mount or
// on re-mount after navigation.
export type InitialActivity = {
  events: ApiEvent[];
  next_cursor: string | null;
  totals: { events: number; holders: number } | null;
  poll: ApiActivityResponse['poll'];
  matrica: ApiMatricaMap;
};

export function mergeRefreshedEvents(current: ApiEvent[], incoming: ApiEvent[]): ApiEvent[] {
  const currentIds = new Set(current.map(event => event.id));
  const incomingById = new Map(incoming.map(event => [event.id, event]));
  const newEvents = incoming.filter(event => !currentIds.has(event.id));
  return [...newEvents, ...current.map(event => incomingById.get(event.id) ?? event)].toSorted(
    (left, right) => right.block_timestamp - left.block_timestamp || right.id - left.id
  );
}

/** Reconcile an exact bounded ID snapshot without disturbing older rows that
 * were not part of the request. Missing requested IDs were deleted or no
 * longer match the active feed filters and must be removed. */
export function mergeRevalidatedEvents(
  current: ApiEvent[],
  requestedIds: number[],
  incoming: ApiEvent[]
): ApiEvent[] {
  const requested = new Set(requestedIds);
  const replacements = new Map(
    incoming.filter(event => requested.has(event.id)).map(event => [event.id, event])
  );
  return current
    .filter(event => !requested.has(event.id) || replacements.has(event.id))
    .map(event => replacements.get(event.id) ?? event)
    .toSorted((left, right) => right.block_timestamp - left.block_timestamp || right.id - left.id);
}

/** Select a bounded rotating slice of loaded IDs. Rotation uses an array
 * offset so continuously loading older pages cannot starve them. */
export function selectRevalidationBatch(
  events: ApiEvent[],
  offset: number,
  batchSize = REVALIDATE_BATCH_SIZE
): { ids: number[]; nextOffset: number } {
  if (events.length === 0 || batchSize <= 0) return { ids: [], nextOffset: 0 };
  const count = Math.min(batchSize, events.length);
  const start = ((offset % events.length) + events.length) % events.length;
  const ids = Array.from({ length: count }, (_, i) => events[(start + i) % events.length].id);
  return { ids: [...new Set(ids)], nextOffset: (start + count) % events.length };
}

function sameEvent(left: ApiEvent | undefined, right: ApiEvent | undefined): boolean {
  if (!left || !right) return left === right;
  return Object.keys(left).every(
    key => left[key as keyof ApiEvent] === right[key as keyof ApiEvent]
  );
}

export function useActivityFeed(
  filter: FeedFilter = 'all',
  color: ColorFilter = 'all',
  initial?: InitialActivity
) {
  const [state, setState] = useState<FeedState>(() => ({
    events: initial?.events ?? [],
    totals: initial?.totals ?? null,
    poll: initial?.poll ?? null,
    matrica: initial?.matrica ?? {},
    loading: !initial,
    error: null,
    reachedEnd: initial != null && initial.next_cursor == null,
  }));
  const eventsRef = useRef(state.events);
  eventsRef.current = state.events;
  const cursorRef = useRef<string | null>(initial?.next_cursor ?? null);
  const loadingRef = useRef<boolean>(false);
  const seenIdsRef = useRef<Set<number>>(new Set(initial?.events.map(e => e.id) ?? []));
  const filterRef = useRef<FeedFilter>(filter);
  const colorRef = useRef<ColorFilter>(color);
  // Bumped on filter reset so an in-flight fetch's response can be discarded
  // when the filter has changed underneath it.
  const reqGenRef = useRef(0);
  // Any response that mutates the event list invalidates a concurrently
  // running revalidation snapshot, preventing it from overwriting newer page
  // or head-refresh data.
  const eventMutationRef = useRef(0);
  const revalidationOffsetRef = useRef(0);
  // Skip the very first reset-and-fetch when the server already provided data
  // for the default filter; subsequent filter changes still reset normally.
  const skipInitialReset = useRef<boolean>(initial != null);

  const buildUrl = useCallback((cursor: string | null) => {
    const url = new URL('/api/activity', window.location.origin);
    url.searchParams.set('limit', String(PAGE_SIZE));
    if (cursor != null) url.searchParams.set('cursor', cursor);
    if (filterRef.current !== 'all') url.searchParams.set('type', filterRef.current);
    if (colorRef.current !== 'all') url.searchParams.set('color', colorRef.current);
    return url.toString();
  }, []);

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
      const fresh = data.events.filter(e => !seenIdsRef.current.has(e.id));
      for (const e of fresh) seenIdsRef.current.add(e.id);
      cursorRef.current = data.next_cursor;
      eventMutationRef.current++;
      setState(prev => ({
        ...prev,
        events: [...prev.events, ...fresh],
        // The API only returns totals on first-page requests; preserve the last
        // value we saw so paginated responses don't blank the header.
        totals: data.totals ?? prev.totals,
        poll: data.poll,
        matrica: { ...prev.matrica, ...(data.matrica ?? {}) },
        loading: false,
        error: null,
        reachedEnd: data.next_cursor == null,
      }));
    } catch (err) {
      if (myGen !== reqGenRef.current) return;
      setState(prev => ({
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
    // Pull the first page, prepend new rows, and replace matching IDs whose
    // enrichment changed (for example transferred -> sold).
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
      const newOnes = data.events.filter(e => !seenIdsRef.current.has(e.id));
      for (const e of newOnes) seenIdsRef.current.add(e.id);
      eventMutationRef.current++;
      setState(prev => ({
        ...prev,
        events: mergeRefreshedEvents(prev.events, data.events),
        totals: data.totals,
        poll: data.poll,
        matrica: { ...prev.matrica, ...(data.matrica ?? {}) },
      }));
    } catch {
      // refresh failures are silent
    }
  }, [buildUrl]);

  const revalidateLoaded = useCallback(async () => {
    const snapshot = eventsRef.current;
    const selection = selectRevalidationBatch(snapshot, revalidationOffsetRef.current);
    if (selection.ids.length === 0) return;
    const myGen = reqGenRef.current;
    const myMutation = eventMutationRef.current;
    const url = new URL(buildUrl(null));
    url.searchParams.set('ids', selection.ids.join(','));
    try {
      const res = await fetch(url.toString());
      if (!res.ok || myGen !== reqGenRef.current || myMutation !== eventMutationRef.current) return;
      const data: ApiActivityResponse = await res.json();
      if (myGen !== reqGenRef.current || myMutation !== eventMutationRef.current) return;
      const requested = new Set(selection.ids);
      const returned = data.events.filter(event => requested.has(event.id));
      const returnedIds = new Set(returned.map(event => event.id));
      const oldById = new Map(snapshot.map(event => [event.id, event]));
      const returnedById = new Map(returned.map(event => [event.id, event]));
      const changedOrRemoved = selection.ids.some(id => {
        const old = oldById.get(id);
        const fresh = returnedById.get(id);
        return !fresh || !sameEvent(old, fresh);
      });
      revalidationOffsetRef.current = selection.nextOffset;
      if (!changedOrRemoved) return;
      for (const id of selection.ids) {
        if (!returnedIds.has(id)) seenIdsRef.current.delete(id);
      }
      for (const event of returned) seenIdsRef.current.add(event.id);
      eventMutationRef.current++;
      setState(prev => ({
        ...prev,
        events: mergeRevalidatedEvents(prev.events, selection.ids, returned),
        matrica: { ...prev.matrica, ...(data.matrica ?? {}) },
      }));
    } catch {
      // A later cycle retries this batch when a revalidation request fails.
    }
  }, [buildUrl]);

  // Reset on filter or color change so a new fetch starts from the top. Skip
  // once on initial mount when we already have server-rendered data for the
  // current (filter, color) — otherwise we'd immediately blow away the
  // SSR-provided list and re-fetch, defeating the whole point of passing
  // initial data in.
  useEffect(() => {
    if (skipInitialReset.current) {
      skipInitialReset.current = false;
      filterRef.current = filter;
      colorRef.current = color;
      return;
    }
    filterRef.current = filter;
    colorRef.current = color;
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
      matrica: {},
      loading: true,
      error: null,
      reachedEnd: false,
    });
    loadMore();
  }, [filter, color, loadMore]);

  // Periodically refresh the head and reconcile a bounded rotating slice of
  // loaded IDs. The second request catches type upgrades/removals below the
  // first page without downloading every historical page again.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let refreshing = false;
    const start = () => {
      if (timer) return;
      timer = setInterval(async () => {
        if (refreshing) return;
        refreshing = true;
        try {
          await refreshHead();
          await revalidateLoaded();
        } finally {
          refreshing = false;
        }
      }, REFRESH_MS);
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
  }, [refreshHead, revalidateLoaded]);

  return { ...state, loadMore };
}
