import { describe, expect, it, vi } from 'vitest';
import { refreshActivityWindow } from '../src/components/Activity/refreshActivityWindow';
import { mergeRevalidatedEvents } from '../src/components/Activity/useActivityFeed';
import type { ApiActivityResponse, ApiEvent } from '../src/components/Activity/types';

function event(id: number, timestamp = id): ApiEvent {
  return {
    id,
    inscription_id: `${id}i0`,
    inscription_number: id,
    event_type: 'transferred',
    block_height: null,
    block_timestamp: timestamp,
    new_satpoint: null,
    old_owner: null,
    new_owner: null,
    marketplace: null,
    sale_price_sats: null,
    txid: String(id),
    raw_json: null,
    created_at: timestamp,
  };
}

function page(events: ApiEvent[], next_cursor: string | null = null): ApiActivityResponse {
  return { events, next_cursor, totals: null, poll: null, matrica: {} };
}

function pages(rows: ApiEvent[], limit = 100) {
  return vi.fn(async (cursor: string | null) => {
    const start =
      cursor == null ? 0 : rows.findIndex(row => `${row.block_timestamp}:${row.id}` === cursor) + 1;
    const events = rows.slice(start, start + limit);
    const last = events.at(-1);
    return page(
      events,
      start + limit < rows.length && last ? `${last.block_timestamp}:${last.id}` : null
    );
  });
}

describe('bounded activity head catch-up', () => {
  it('uses one head request regardless of how many historical pages are loaded', async () => {
    const loaded = Array.from({ length: 10_000 }, (_, i) => event(10_000 - i));
    const fetchPage = pages([event(10_001), ...loaded]);
    const result = await refreshActivityWindow(loaded, fetchPage, '1:1');
    expect(fetchPage).toHaveBeenCalledExactlyOnceWith(null);
    expect(result.events).toEqual([event(10_001), ...loaded]);
    expect(result.next_cursor).toBe('1:1');
  });

  it('crosses a removed old newest tuple without scanning older loaded history', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce(page([event(11), event(9)], '9:9'));
    const result = await refreshActivityWindow([event(10), event(5), event(1)], fetchPage, '1:1');
    expect(fetchPage).toHaveBeenCalledOnce();
    expect(result.next_cursor).toBe('1:1');
    // The exact-ID request removes the reclassified/deleted row separately.
    const reconciled = mergeRevalidatedEvents(result.events, [10], []);
    expect(reconciled.map(row => row.id)).toEqual([11, 9, 5, 1]);
  });

  it('uses ID tie breaking to catch a multi-page burst at one timestamp', async () => {
    const rows = Array.from({ length: 9 }, (_, i) => event(9 - i, 10));
    const fetchPage = pages(rows, 2);
    const result = await refreshActivityWindow([event(4, 10), event(3, 10)], fetchPage, '10:3');
    expect(fetchPage.mock.calls).toEqual([[null], ['10:8'], ['10:6']]);
    expect(result.events.map(row => row.id)).toEqual([9, 8, 7, 6, 5, 4, 3]);
    expect(result.next_cursor).toBe('10:3');
  });

  it('collects every new arrival across several pages and preserves older continuation', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => event(1000 - i));
    const fetchPage = pages(rows);
    const loaded = rows.slice(350, 600);
    const result = await refreshActivityWindow(loaded, fetchPage, '401:401');
    expect(fetchPage).toHaveBeenCalledTimes(4);
    expect(result.events).toEqual(rows.slice(0, 600));
    expect(result.next_cursor).toBe('401:401');
  });

  it('moves continuation forward when head catch-up fetches past a small old window', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => event(12 - i));
    const fetchPage = pages(rows, 2);
    const result = await refreshActivityWindow([event(7)], fetchPage, '7:7');
    expect(result.events).toEqual(rows.slice(0, 6));
    expect(result.next_cursor).toBe('7:7');
    const continuation = await fetchPage(result.next_cursor);
    expect(continuation.events.map(row => row.id)).toEqual([6, 5]);
  });

  it('adopts a deeper head cursor rather than replaying already fetched rows', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => event(12 - i));
    const result = await refreshActivityWindow([event(8)], pages(rows, 2), '8:8');
    expect(result.events.map(row => row.id)).toEqual([12, 11, 10, 9, 8, 7]);
    expect(result.next_cursor).toBe('7:7');
  });

  it('rejects a later page failure without exposing a partial catch-up', async () => {
    const current = [event(8), event(1)];
    const snapshot = structuredClone(current);
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(page([event(10), event(9)], '9:9'))
      .mockRejectedValueOnce(new Error('offline'));
    await expect(refreshActivityWindow(current, fetchPage, '1:1')).rejects.toThrow('offline');
    expect(current).toEqual(snapshot);
  });

  it('loads one page and initializes its continuation when the loaded feed is empty', async () => {
    const first = page([event(8), event(7)], '7:7');
    const fetchPage = vi.fn().mockResolvedValue(first);
    expect(await refreshActivityWindow([], fetchPage)).toEqual(first);
    expect(fetchPage).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('clears all stale rows and continuation when the server feed is empty', async () => {
    const result = await refreshActivityWindow([event(8), event(1)], async () => page([]), '1:1');
    expect(result.events).toEqual([]);
    expect(result.next_cursor).toBeNull();
  });

  it('treats an exhausted catch-up as authoritative for deletions anywhere in the old window', async () => {
    const result = await refreshActivityWindow(
      [event(8), event(5), event(1)],
      pages([event(9), event(8)], 2),
      '1:1'
    );
    expect(result.events).toEqual([event(9), event(8)]);
    expect(result.next_cursor).toBeNull();
  });

  it('deduplicates timestamp-corrected IDs across catch-up pages', async () => {
    const replacement = { ...event(10, 3), event_type: 'sold' as const, sale_price_sats: 100 };
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(page([event(10), event(9)], '9:9'))
      .mockResolvedValueOnce(page([event(4), replacement], '3:10'));
    const result = await refreshActivityWindow([event(8), event(5)], fetchPage, '5:5');
    expect(result.events).toEqual([event(9), event(8), event(5), event(4), replacement]);
    expect(result.next_cursor).toBe('3:10');
  });

  it('rejects a repeated continuation instead of fetching forever', async () => {
    const fetchPage = vi.fn().mockResolvedValue(page([event(10), event(9)], '9:9'));
    await expect(refreshActivityWindow([event(1)], fetchPage)).rejects.toThrow(
      'Activity cursor did not advance'
    );
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('keeps head metadata and merges profiles across catch-up pages', async () => {
    const first = {
      ...page([event(9)], '9:9'),
      totals: { events: 9, holders: 2 },
      matrica: { walletA: { user_id: 'a', username: 'alice', avatar_url: null } },
    };
    const second = {
      ...page([event(1)]),
      matrica: { walletB: { user_id: 'b', username: 'bob', avatar_url: null } },
    };
    const result = await refreshActivityWindow(
      [event(1)],
      vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    );
    expect(result.totals).toEqual(first.totals);
    expect(result.matrica).toEqual({ ...first.matrica, ...second.matrica });
  });
});
