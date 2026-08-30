import { describe, expect, it } from 'vitest';
import { mergeRefreshedEvents } from '../src/components/Activity/useActivityFeed';
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
});
