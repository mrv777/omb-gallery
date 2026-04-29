/**
 * Rate-limit tests. Hammers the satflow client with N concurrent requests
 * and asserts the actual fetch invocations were spread out per the
 * RATE_LIMIT_RPS cap (4 req/s by design).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchSalesPage, _resetRateLimitForTest } from '../src/lib/satflow';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  _resetRateLimitForTest();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('rate limiter', () => {
  it('caps in-flight HTTP calls at 4 per rolling second', async () => {
    const callTimes: number[] = [];
    globalThis.fetch = (async () => {
      callTimes.push(Date.now());
      return new Response(JSON.stringify({ data: { sales: [], total: 0 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    // Fire 12 requests in parallel — limiter must space them so no rolling
    // 1-second window contains more than 4.
    const start = Date.now();
    await Promise.all(
      Array.from({ length: 12 }, () => fetchSalesPage({ collectionSlug: 'omb', pageSize: 1 }))
    );
    const elapsed = Date.now() - start;

    // 12 calls @ 4/s with token-bucket spacing of 250ms = the 12th call's
    // slot is at 11 * 250 = 2750ms. Allow generous margin for slow CI.
    expect(elapsed).toBeGreaterThanOrEqual(2_500);
    expect(callTimes.length).toBe(12);

    // No 1-second sliding window may contain more than 5 timestamps. With
    // perfect 250ms spacing the worst case is exactly 4; we permit one extra
    // for setTimeout jitter. (Satflow's contractual cap is 5 + 10-burst, so
    // 5 sustained is well within budget.)
    for (let i = 0; i < callTimes.length; i++) {
      const windowEnd = callTimes[i] + 1000;
      const inWindow = callTimes.filter(t => t >= callTimes[i] && t < windowEnd).length;
      expect(inWindow).toBeLessThanOrEqual(5);
    }
  }, 20_000);
});
