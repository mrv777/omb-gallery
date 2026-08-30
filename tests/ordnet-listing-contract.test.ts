import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OrdnetError,
  createOrdnetListingPreflight,
  delistOrdnetListing,
  submitOrdnetListing,
} from '@/lib/ordnet';
import {
  parseListingPriceSats,
  parseOrdnetListingDuration,
  parseOrdnetSellerProvider,
} from '@/lib/marketplace/sellerTypes';

const INPUTS = [{ address: 'bc1pseller', signingIndexes: [0], sigHash: 0 }];

function preflightJson() {
  return {
    listings: [
      {
        inscriptionId: 'abc123i0',
        anchorUtxoId: 'anchor-1',
        psbts: [
          {
            stepIndex: 0,
            inscriptionId: 'abc123i0',
            signerAddress: 'bc1pseller',
            inputsToSign: INPUTS,
            psbtBase64: 'escrow',
          },
          {
            stepIndex: 1,
            inscriptionId: 'abc123i0',
            signerAddress: 'bc1pseller',
            inputsToSign: [{ ...INPUTS[0], sigHash: 131 }],
            psbtBase64: 'settlement',
          },
        ],
      },
    ],
    recoveryPsbt: {
      signerAddress: 'bc1pseller',
      inputsToSign: [{ ...INPUTS[0], sigHash: 1 }],
      psbtBase64: 'recovery',
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('ord.net seller contract', () => {
  it('echoes the exact preflight fields into submit and preserves signing metadata', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        requests.push({ url, body });
        const response = url.endsWith('/preflight')
          ? preflightJson()
          : { listings: [{ inscriptionId: 'abc123i0', listingId: 'listing-1' }] };
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      })
    );

    const stored = await createOrdnetListingPreflight({
      inscriptionId: 'abc123i0',
      priceSats: 123_456,
      durationDays: 90,
      ordinalsPublicKey: '02'.padEnd(66, '1'),
      walletBindingId: 'binding-1',
      sessionToken: 'secret',
    });
    expect(stored.response.listings[0]?.psbts[1]?.inputsToSign[0]).toMatchObject({
      signingIndexes: [0],
      sigHash: 131,
    });
    const result = await submitOrdnetListing({
      stored,
      signedPsbts: ['signed-escrow', 'signed-settlement', 'signed-recovery'],
      sessionToken: 'secret',
    });
    expect(result.listingId).toBe('listing-1');
    expect(requests[1]?.body).toMatchObject({
      walletBindingId: 'binding-1',
      ordinalsPublicKey: '02'.padEnd(66, '1'),
      items: [{ inscriptionId: 'abc123i0', priceSats: 123_456 }],
      durationDays: 90,
      anchors: [{ inscriptionId: 'abc123i0', anchorUtxoId: 'anchor-1' }],
      signed: [
        {
          inscriptionId: 'abc123i0',
          psbts: [
            { stepIndex: 0, psbtBase64: 'signed-escrow' },
            { stepIndex: 1, psbtBase64: 'signed-settlement' },
          ],
        },
      ],
      signedRecoveryPsbt: { psbtBase64: 'signed-recovery' },
    });
  });

  it('does not retry seller writes after a transient upstream failure', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      createOrdnetListingPreflight({
        inscriptionId: 'abc123i0',
        priceSats: 50_000,
        durationDays: 1,
        ordinalsPublicKey: '02'.padEnd(66, '1'),
        walletBindingId: 'binding-1',
        sessionToken: 'secret',
      })
    ).rejects.toBeInstanceOf(OrdnetError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects unsafe preflight sighashes', async () => {
    const response = preflightJson();
    response.listings[0]!.psbts[1]!.inputsToSign[0]!.sigHash = 1;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }))
    );
    await expect(
      createOrdnetListingPreflight({
        inscriptionId: 'abc123i0',
        priceSats: 50_000,
        durationDays: 7,
        ordinalsPublicKey: '02'.padEnd(66, '1'),
        walletBindingId: 'binding-1',
        sessionToken: 'secret',
      })
    ).rejects.toThrow('unsafe sighash');
  });

  it('requires the delist echo to match exactly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ listings: [{ inscriptionId: 'abc123i0', listingId: 'wrong' }] }),
            { status: 200 }
          )
      )
    );
    await expect(
      delistOrdnetListing({
        inscriptionId: 'abc123i0',
        listingId: 'listing-1',
        walletBindingId: 'binding-1',
        sessionToken: 'secret',
      })
    ).rejects.toThrow('did not match');
  });
});

describe('seller input guards', () => {
  it('accepts only supported durations and providers', () => {
    expect(parseOrdnetListingDuration(90)).toBe(90);
    expect(parseOrdnetListingDuration(2)).toBeNull();
    expect(parseOrdnetSellerProvider('DREY')).toBe('drey');
    expect(parseOrdnetSellerProvider('ledger')).toBeNull();
  });

  it('requires exact safe integer sats within the Bitcoin supply', () => {
    expect(parseListingPriceSats(1)).toBe(1);
    expect(parseListingPriceSats(1.5)).toBeNull();
    expect(parseListingPriceSats(2_100_000_000_000_001)).toBeNull();
  });
});
