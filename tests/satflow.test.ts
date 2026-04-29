/**
 * Tests for the Satflow client's normalization. We don't hit the live API —
 * each test feeds a hand-built JSON envelope into the response shape that
 * `fetchSalesPage` / `fetchListingsPage` expects, then asserts the produced
 * NormalizedSale / NormalizedListing.
 *
 * Strategy: monkey-patch global.fetch with a stub before each test so the
 * client's HTTP layer (with its retries, rate limiter, etc.) runs end-to-end
 * — that gives us coverage of the entire pipeline, not just the pickX helpers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchListingsPage, fetchSalesPage, _resetRateLimitForTest } from '../src/lib/satflow';

type FetchStub = (...args: Parameters<typeof fetch>) => Promise<Response>;
const originalFetch = globalThis.fetch;

function stubFetch(stub: FetchStub) {
  globalThis.fetch = stub as typeof fetch;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

beforeEach(() => {
  _resetRateLimitForTest();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

// ============================================================================
// SALES
// ============================================================================

describe('fetchSalesPage', () => {
  const baseAsk = {
    id: 'satflow-sale-1',
    type: 'sale',
    orderType: 'ask',
    fillCompletedAt: '2026-04-27T14:27:05.000Z',
    fillTx: 'a'.repeat(64),
    price: 2_500_000,
    fillOrdAddress: 'bc1pbuyer',
    ask: {
      inscriptionId: 'fed' + '0'.repeat(61) + 'i0',
      sellerOrdAddress: 'bc1pseller',
      collectionSlug: 'omb',
      price: 2_500_000,
    },
  };

  it('parses a typical ask-orderType sale', async () => {
    stubFetch(async () => jsonResponse({ data: { sales: [baseAsk], total: 1, _meta: { ms: 1 } } }));
    const res = await fetchSalesPage({ collectionSlug: 'omb' });
    expect(res.items).toHaveLength(1);
    const s = res.items[0];
    expect(s.satflow_id).toBe('satflow-sale-1');
    expect(s.inscription_id).toBe('fed' + '0'.repeat(61) + 'i0');
    expect(s.txid).toBe('a'.repeat(64));
    expect(s.sale_price_sats).toBe(2_500_000);
    expect(s.block_timestamp).toBe(1777300025);
    expect(s.seller).toBe('bc1pseller');
    expect(s.buyer).toBe('bc1pbuyer');
    expect(s.marketplace).toBe('satflow');
  });

  it('flips seller/buyer correctly for bid-orderType sales', async () => {
    const bid = {
      ...baseAsk,
      id: 'satflow-sale-2',
      orderType: 'bid',
      fillOrdAddress: 'bc1pseller-fills-bid', // seller fills the bid
      ask: undefined,
      bid: {
        inscriptionId: baseAsk.ask.inscriptionId,
        bidderTokenReceiveAddress: 'bc1pbidder-receives',
        sellerOrdAddress: 'bc1pseller-fills-bid',
        collectionSlug: 'omb',
        price: 2_500_000,
      },
    };
    stubFetch(async () => jsonResponse({ data: { sales: [bid], total: 1 } }));
    const res = await fetchSalesPage({ collectionSlug: 'omb' });
    const s = res.items[0];
    // Seller is on the bid order body; buyer is the bidder's receive address.
    expect(s.seller).toBe('bc1pseller-fills-bid');
    expect(s.buyer).toBe('bc1pbidder-receives');
  });

  it('rejects records missing fillTx', async () => {
    const noTx = { ...baseAsk, fillTx: null };
    stubFetch(async () => jsonResponse({ data: { sales: [noTx], total: 1 } }));
    const res = await fetchSalesPage({ collectionSlug: 'omb' });
    expect(res.items).toHaveLength(0);
    expect(res.rawCount).toBe(1);
  });

  it('rejects records with malformed (non-hex) txid', async () => {
    const badTx = { ...baseAsk, fillTx: 'not-a-real-txid' };
    stubFetch(async () => jsonResponse({ data: { sales: [badTx], total: 1 } }));
    const res = await fetchSalesPage({ collectionSlug: 'omb' });
    expect(res.items).toHaveLength(0);
  });

  it('rejects records with price <= 0', async () => {
    const free = { ...baseAsk, price: 0, ask: { ...baseAsk.ask, price: 0 } };
    stubFetch(async () => jsonResponse({ data: { sales: [free], total: 1 } }));
    const res = await fetchSalesPage({ collectionSlug: 'omb' });
    expect(res.items).toHaveLength(0);
  });

  it('falls back from fillCompletedAt to timestamp when fill date missing', async () => {
    const fallback = {
      ...baseAsk,
      fillCompletedAt: null,
      timestamp: '2026-04-27T14:00:00.000Z',
    };
    stubFetch(async () => jsonResponse({ data: { sales: [fallback], total: 1 } }));
    const res = await fetchSalesPage({ collectionSlug: 'omb' });
    expect(res.items[0].block_timestamp).toBe(1777298400);
  });

  it('treats epoch-zero placeholder timestamps as missing', async () => {
    // Satflow ships `1970-01-01T00:00:00.000Z` in lastValidationAt for new records.
    // We must not let that leak in as a sale's block_timestamp.
    const epoch = {
      ...baseAsk,
      fillCompletedAt: '1970-01-01T00:00:00.000Z',
      timestamp: null,
    };
    stubFetch(async () => jsonResponse({ data: { sales: [epoch], total: 1 } }));
    const res = await fetchSalesPage({ collectionSlug: 'omb' });
    expect(res.items).toHaveLength(0);
  });

  it('reports hasMore correctly when last page is partial', async () => {
    stubFetch(async () => jsonResponse({ data: { sales: Array(10).fill(baseAsk), total: 30 } }));
    const res = await fetchSalesPage({ collectionSlug: 'omb', page: 1, pageSize: 100 });
    expect(res.hasMore).toBe(false); // got 10 < pageSize=100
  });

  it('lowercases txid for cross-source dedup parity', async () => {
    const upper = { ...baseAsk, fillTx: 'A'.repeat(64) };
    stubFetch(async () => jsonResponse({ data: { sales: [upper], total: 1 } }));
    const res = await fetchSalesPage({ collectionSlug: 'omb' });
    expect(res.items[0].txid).toBe('a'.repeat(64));
  });

  it('returns empty when API returns malformed envelope', async () => {
    stubFetch(async () => jsonResponse({ unexpected: 'shape' }));
    const res = await fetchSalesPage({ collectionSlug: 'omb' });
    expect(res.items).toHaveLength(0);
    expect(res.rawCount).toBe(0);
    expect(res.total).toBe(0);
  });

  it('throws SatflowError on 4xx (non-retryable)', async () => {
    stubFetch(async () => new Response('forbidden', { status: 403 }));
    await expect(fetchSalesPage({ collectionSlug: 'omb' })).rejects.toThrow();
  });
});

// ============================================================================
// LISTINGS
// ============================================================================

describe('fetchListingsPage', () => {
  const baseListing = {
    id: 'satflow-listing-1',
    type: 'listing',
    orderType: 'ask',
    cancelledAt: null,
    fillPendingAt: null,
    fillCompletedAt: null,
    invalidAt: null,
    expiry: null,
    createdAt: '2026-04-27T15:30:46.193Z',
    price: 2_900_000,
    ask: {
      inscriptionId: 'cab' + '1'.repeat(61) + 'i0',
      sellerOrdAddress: 'bc1pseller',
      collectionSlug: 'omb',
      price: 2_900_000,
    },
  };

  it('parses an active listing', async () => {
    stubFetch(async () => jsonResponse({ data: { listings: [baseListing], total: 1 } }));
    const res = await fetchListingsPage({ collectionSlug: 'omb' });
    expect(res.items).toHaveLength(1);
    const l = res.items[0];
    expect(l.satflow_id).toBe('satflow-listing-1');
    expect(l.inscription_id).toBe('cab' + '1'.repeat(61) + 'i0');
    expect(l.price_sats).toBe(2_900_000);
    expect(l.seller).toBe('bc1pseller');
    expect(l.listed_at).toBe(1777303846);
  });

  it('skips listings that have already been cancelled', async () => {
    const cancelled = { ...baseListing, cancelledAt: '2026-04-27T16:00:00.000Z' };
    stubFetch(async () => jsonResponse({ data: { listings: [cancelled], total: 1 } }));
    const res = await fetchListingsPage({ collectionSlug: 'omb' });
    expect(res.items).toHaveLength(0);
  });

  it('skips listings already filled or pending fill', async () => {
    const filled = { ...baseListing, fillCompletedAt: '2026-04-27T16:00:00.000Z' };
    const pending = { ...baseListing, id: 'pending', fillPendingAt: '2026-04-27T16:00:00.000Z' };
    stubFetch(async () => jsonResponse({ data: { listings: [filled, pending], total: 2 } }));
    const res = await fetchListingsPage({ collectionSlug: 'omb' });
    expect(res.items).toHaveLength(0);
  });

  it('skips listings flagged invalid (UTXO spent)', async () => {
    const invalid = { ...baseListing, invalidAt: '2026-04-27T15:31:00.000Z' };
    stubFetch(async () => jsonResponse({ data: { listings: [invalid], total: 1 } }));
    const res = await fetchListingsPage({ collectionSlug: 'omb' });
    expect(res.items).toHaveLength(0);
  });

  it('skips bid-orderType records (they are buy offers, not listings)', async () => {
    const bid = {
      ...baseListing,
      orderType: 'bid',
      ask: undefined,
      bid: { inscriptionId: 'x', price: 1, sellerOrdAddress: 'y' },
    };
    stubFetch(async () => jsonResponse({ data: { listings: [bid], total: 1 } }));
    const res = await fetchListingsPage({ collectionSlug: 'omb' });
    expect(res.items).toHaveLength(0);
  });
});
