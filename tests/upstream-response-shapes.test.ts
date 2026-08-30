import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  delete process.env.ORD_BASE_URL;
  delete process.env.SATFLOW_BASE_URL;
});

describe('upstream response envelopes', () => {
  it('accepts an explicitly empty Satflow sales envelope', async () => {
    process.env.SATFLOW_BASE_URL = 'https://satflow.test';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ data: { sales: [], total: 0 } }))
    );
    const { fetchSalesPage } = await import('../src/lib/satflow');
    await expect(fetchSalesPage({ collectionSlug: 'omb' })).resolves.toMatchObject({
      items: [],
      rawCount: 0,
      total: 0,
    });
  });

  it('rejects unknown Satflow sales and listing envelopes', async () => {
    process.env.SATFLOW_BASE_URL = 'https://satflow.test';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true, data: {} }))
    );
    const { fetchListingsPage, fetchSalesPage, SatflowError } = await import('../src/lib/satflow');
    await expect(fetchSalesPage({ collectionSlug: 'omb' })).rejects.toBeInstanceOf(SatflowError);
    await expect(fetchListingsPage({ collectionSlug: 'omb' })).rejects.toBeInstanceOf(SatflowError);
  });

  it('accepts an explicitly empty ord list and rejects unknown objects', async () => {
    process.env.ORD_BASE_URL = 'http://ord.test';
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json([]))
        .mockResolvedValueOnce(Response.json({ synced: true }))
    );
    const { fetchInscriptionsBatch, OrdError } = await import('../src/lib/ord');
    await expect(fetchInscriptionsBatch(['a'])).resolves.toEqual([]);
    await expect(fetchInscriptionsBatch(['a'])).rejects.toBeInstanceOf(OrdError);
  });
});
