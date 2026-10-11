'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiActivityResponse, ApiEvent, ApiMatricaMap } from './types';
import type { ColorFilter } from '@/lib/types';
import { mergeRefreshedEvents, refreshActivityWindow } from './refreshActivityWindow';

export { mergeRefreshedEvents } from './refreshActivityWindow';

const PAGE_SIZE = 60;
const REFRESH_MS = 60_000;
const REVALIDATE_BATCH_SIZE = 200;
const REQUEST_TIMEOUT_MS = 30_000;

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
  refreshing: boolean;
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
    refreshing: false,
    error: null,
    reachedEnd: initial != null && initial.next_cursor == null,
  }));
  const eventsRef = useRef(state.events);
  const cursorRef = useRef<string | null>(initial?.next_cursor ?? null);
  const loadingRef = useRef<boolean>(false);
  const requestRef = useRef<AbortController | null>(null);
  const seenIdsRef = useRef<Set<number>>(new Set(initial?.events.map(e => e.id) ?? []));
  const filterRef = useRef<FeedFilter>(filter);
  const colorRef = useRef<ColorFilter>(color);
  // Bumped on filter reset so an in-flight fetch's response can be discarded
  // when the filter has changed underneath it.
  const reqGenRef = useRef(0);
  // A filter reset or newer event mutation invalidates staged revalidation.
  const eventMutationRef = useRef(0);
  const revalidationOffsetRef = useRef(0);
  // Skip the very first reset-and-fetch when the server already provided data
  // for the default filter; subsequent filter changes still reset normally.
  const skipInitialReset = useRef<boolean>(initial != null);

  const buildUrl = useCallback((cursor: string | null, refresh = false) => {
    const url = new URL('/api/activity', window.location.origin);
    url.searchParams.set('limit', String(refresh ? 100 : PAGE_SIZE));
    if (refresh) url.searchParams.set('refresh', '1');
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
    const controller = new AbortController();
    requestRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    setState(prev => ({ ...prev, loading: true, error: null }));
    try {
      const res = await fetch(buildUrl(cursorRef.current), { signal: controller.signal });
      if (myGen !== reqGenRef.current) return;
      if (controller.signal.aborted) throw new Error('Activity request timed out');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: ApiActivityResponse = await res.json();
      if (myGen !== reqGenRef.current) return;
      if (controller.signal.aborted) throw new Error('Activity request timed out');
      const fresh = data.events.filter(e => !seenIdsRef.current.has(e.id));
      for (const e of fresh) seenIdsRef.current.add(e.id);
      cursorRef.current = data.next_cursor;
      eventMutationRef.current++;
      eventsRef.current = mergeRefreshedEvents(eventsRef.current, data.events);
      const events = eventsRef.current;
      setState(prev => ({
        ...prev,
        events,
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
      clearTimeout(timeout);
      if (myGen === reqGenRef.current) {
        loadingRef.current = false;
        requestRef.current = null;
      }
    }
  }, [buildUrl]);

  const refreshHead = useCallback(async () => {
    // Pagination and refresh share one lock: no stale continuation can append
    // after a head catch-up changes its cursor or reconciles removed rows.
    if (loadingRef.current) return;
    loadingRef.current = true;
    const myGen = reqGenRef.current;
    const controller = new AbortController();
    requestRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    setState(prev => ({ ...prev, refreshing: true }));
    try {
      const snapshot = eventsRef.current;
      const selection = selectRevalidationBatch(snapshot, revalidationOffsetRef.current);
      // Remember the next old ID so prepending a large arrival burst cannot
      // make the rotating batch repeatedly select the same historical rows.
      const nextId = snapshot[selection.nextOffset]?.id;
      const data = await refreshActivityWindow(
        snapshot,
        async cursor => {
          const res = await fetch(buildUrl(cursor, true), {
            signal: controller.signal,
            cache: 'no-store',
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const page: ApiActivityResponse = await res.json();
          if (controller.signal.aborted || myGen !== reqGenRef.current) {
            throw new Error('Activity refresh cancelled');
          }
          return page;
        },
        cursorRef.current
      );
      if (controller.signal.aborted || myGen !== reqGenRef.current) return;
      eventsRef.current = data.events;
      seenIdsRef.current = new Set(data.events.map(event => event.id));
      cursorRef.current = data.next_cursor;
      eventMutationRef.current++;
      setState(prev => ({
        ...prev,
        events: data.events,
        totals: data.totals,
        poll: data.poll,
        matrica: { ...prev.matrica, ...data.matrica },
        loading: false,
        error: null,
        reachedEnd: data.next_cursor == null,
      }));

      // Revalidate the old loaded slice even when its IDs were absent from
      // the head response. Missing IDs mean deletion or a filter mismatch.
      if (selection.ids.length === 0) return;
      const myMutation = eventMutationRef.current;
      const url = new URL(buildUrl(null, true));
      url.searchParams.set('ids', selection.ids.join(','));
      const res = await fetch(url.toString(), { signal: controller.signal, cache: 'no-store' });
      if (!res.ok) return;
      const refreshed: Pick<ApiActivityResponse, 'events' | 'matrica'> = await res.json();
      if (
        controller.signal.aborted ||
        myGen !== reqGenRef.current ||
        myMutation !== eventMutationRef.current
      )
        return;
      const requested = new Set(selection.ids);
      const returned = refreshed.events.filter(event => requested.has(event.id));
      const oldById = new Map(eventsRef.current.map(event => [event.id, event]));
      const returnedById = new Map(returned.map(event => [event.id, event]));
      const changedOrRemoved = selection.ids.some(
        id => !sameEvent(oldById.get(id), returnedById.get(id))
      );
      if (changedOrRemoved) {
        eventsRef.current = mergeRevalidatedEvents(eventsRef.current, selection.ids, returned);
        seenIdsRef.current = new Set(eventsRef.current.map(event => event.id));
        eventMutationRef.current++;
      }
      const nextIndex =
        nextId == null ? -1 : eventsRef.current.findIndex(event => event.id === nextId);
      revalidationOffsetRef.current = nextIndex >= 0 ? nextIndex : selection.nextOffset;
      const events = eventsRef.current;
      // Profiles can change independently of events, so reconcile the overlay
      // even when none of the event fields changed.
      setState(prev => ({
        ...prev,
        events,
        matrica: { ...prev.matrica, ...(refreshed.matrica ?? {}) },
      }));
    } catch {
      // Preserve the readable window/cursor if catch-up fails. If only the
      // ID request fails, the successfully staged head remains available.
    } finally {
      clearTimeout(timeout);
      if (myGen === reqGenRef.current) {
        loadingRef.current = false;
        requestRef.current = null;
        setState(prev => (prev.refreshing ? { ...prev, refreshing: false } : prev));
      }
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
    requestRef.current?.abort();
    eventsRef.current = [];
    revalidationOffsetRef.current = 0;
    eventMutationRef.current++;
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
      refreshing: false,
      error: null,
      reachedEnd: false,
    });
    loadMore();
  }, [filter, color, loadMore]);

  useEffect(
    () => () => {
      reqGenRef.current++;
      requestRef.current?.abort();
      loadingRef.current = false;
    },
    []
  );

  // Refresh immediately on returning to the tab, then every visible minute.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (!timer) timer = setInterval(refreshHead, REFRESH_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        start();
        void refreshHead();
      } else stop();
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [refreshHead]);

  return { ...state, loadMore };
}
