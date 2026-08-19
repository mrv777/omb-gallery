import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.ORD_BASE_URL = 'http://ord.test';
  vi.resetModules();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.ORD_BASE_URL;
});

describe('ord Community Vault output evidence', () => {
  it('requests cardinal address outputs and normalizes asset evidence', async () => {
    globalThis.fetch = vi.fn(async (input, init) => {
      expect(String(input)).toBe('http://ord.test/outputs/bc1qbuyer?type=cardinal');
      expect(init?.headers).toMatchObject({ Accept: 'application/json' });
      return Response.json([
        {
          outpoint: `${'aa'.repeat(32)}:1`,
          value: 123456,
          script_pubkey: `0014${'bb'.repeat(20)}`,
          confirmations: 4,
          spent: false,
          inscriptions: [],
          runes: {},
        },
      ]);
    }) as typeof fetch;
    const { fetchAddressCardinalOutputs } = await import('@/lib/ord');
    await expect(fetchAddressCardinalOutputs('bc1qbuyer')).resolves.toEqual([
      {
        outpoint: `${'aa'.repeat(32)}:1`,
        valueSats: '123456',
        scriptPubKeyHex: `0014${'bb'.repeat(20)}`,
        confirmations: 4,
        spent: false,
        inscriptionIds: [],
        runeIds: [],
      },
    ]);
  });

  it('posts exact outpoints and preserves inscriptions and rune identifiers', async () => {
    const outpoint = `${'cc'.repeat(32)}:0`;
    globalThis.fetch = vi.fn(async (_input, init) => {
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe(JSON.stringify([outpoint]));
      return Response.json([
        {
          outpoint,
          value: '10000',
          script_pubkey: `5120${'dd'.repeat(32)}`,
          confirmations: 1,
          spent: false,
          inscriptions: [`${'ee'.repeat(32)}i0`],
          runes: { '840000:1': { amount: 1 } },
        },
      ]);
    }) as typeof fetch;
    const { fetchOutputsBatch } = await import('@/lib/ord');
    const [output] = await fetchOutputsBatch([outpoint]);
    expect(output?.inscriptionIds).toEqual([`${'ee'.repeat(32)}i0`]);
    expect(output?.runeIds).toEqual(['840000:1']);
  });

  it('fails closed on incomplete output metadata', async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json([{ outpoint: `${'aa'.repeat(32)}:0` }])
    ) as typeof fetch;
    const { fetchAddressCardinalOutputs } = await import('@/lib/ord');
    await expect(fetchAddressCardinalOutputs('bc1qbuyer')).rejects.toThrow(
      /Incomplete ord output/u
    );
  });
});
