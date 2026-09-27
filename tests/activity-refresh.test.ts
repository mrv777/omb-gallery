import { describe, expect, it } from 'vitest';
import {
  mergeRefreshedEvents,
  mergeRevalidatedEvents,
  selectRevalidationBatch,
} from '../src/components/Activity/useActivityFeed';
import type { ApiEvent } from '../src/components/Activity/types';

const event = (id: number, eventType: ApiEvent['event_type']): ApiEvent => ({
  id,
  inscription_id: `${id}`,
  inscription_number: id,
  event_type: eventType,
  block_height: null,
  block_timestamp: id,
  new_satpoint: null,
  old_owner: null,
  new_owner: null,
  marketplace: eventType === 'sold' ? 'satflow' : null,
  sale_price_sats: eventType === 'sold' ? 1000 : null,
  txid: `${id}`,
  raw_json: null,
  created_at: id,
});

describe('activity head refresh', () => {
  it('prepends new rows and replaces enriched rows without duplicating IDs', () => {
    const merged = mergeRefreshedEvents(
      [event(2, 'transferred'), event(1, 'transferred')],
      [event(3, 'transferred'), event(2, 'sold')]
    );
    expect(merged.map(item => item.id)).toEqual([3, 2, 1]);
    expect(merged[1]).toMatchObject({ event_type: 'sold', sale_price_sats: 1000 });
  });

  it('reorders a row when enrichment corrects its timestamp', () => {
    const stale = event(1, 'transferred');
    const newer = { ...event(2, 'transferred'), block_timestamp: 20 };
    const corrected = { ...event(1, 'sold'), block_timestamp: 30 };
    expect(mergeRefreshedEvents([newer, stale], [corrected]).map(item => item.id)).toEqual([1, 2]);
  });

  it('removes a loaded transfer when an exact revalidation says it no longer matches transfers', () => {
    const page = [event(4, 'transferred'), event(3, 'transferred'), event(2, 'transferred')];
    const reconciled = mergeRevalidatedEvents(page, [3], []);
    expect(reconciled.map(item => item.id)).toEqual([4, 2]);
  });

  it('replaces requested rows and retains valid older rows outside the batch', () => {
    const page = [event(5, 'transferred'), event(4, 'transferred'), event(3, 'transferred')];
    const upgraded = event(4, 'sold');
    const reconciled = mergeRevalidatedEvents(page, [4], [upgraded]);
    expect(reconciled.map(item => item.id)).toEqual([5, 4, 3]);
    expect(reconciled[1]).toMatchObject({ event_type: 'sold', sale_price_sats: 1000 });
  });

  it('rotates bounded batches over loaded rows, including wraparound', () => {
    const page = [event(5, 'transferred'), event(4, 'transferred'), event(3, 'transferred')];
    expect(selectRevalidationBatch(page, 0, 2)).toEqual({ ids: [5, 4], nextOffset: 2 });
    expect(selectRevalidationBatch(page, 2, 2)).toEqual({ ids: [3, 5], nextOffset: 1 });
  });
});
