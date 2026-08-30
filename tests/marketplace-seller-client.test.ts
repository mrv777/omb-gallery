import { describe, expect, it, vi } from 'vitest';
import {
  normalizeListingPreflight,
  normalizeSellerOmbsPage,
  parseBtcPriceToSats,
  signListingSteps,
  type ListingSigningStep,
} from '@/lib/marketplace/sellerClient';

describe('marketplace seller client contracts', () => {
  it.each([
    ['0.00000001', 1],
    ['0.1', 10_000_000],
    ['1', 100_000_000],
    ['21.00000000', 2_100_000_000],
  ])('parses %s as exact integer sats', (input, sats) => {
    expect(parseBtcPriceToSats(input)).toBe(sats);
  });

  it.each(['', '0', '-1', '.1', '01', '1.000000001', '1e-3', 'NaN'])(
    'rejects ambiguous or invalid BTC amount %s',
    input => {
      expect(() => parseBtcPriceToSats(input)).toThrow();
    }
  );

  it('normalizes a holdings page with active listing state', () => {
    expect(
      normalizeSellerOmbsPage({
        ombs: [
          {
            inscription_number: 123,
            inscription_id: 'id123',
            current_output: 'tx:0',
            postage_sats: 546,
            thumbnail: '/123.webp',
            listable: false,
            listability_reason: 'already listed',
            active_listing: {
              id: 'listing-1',
              price_sats: 10_000_000,
              expires_at: 2_000_000_000,
              marketplace: 'ord.net',
            },
          },
        ],
        next_cursor: '123',
      })
    ).toMatchObject({
      next_cursor: '123',
      items: [
        {
          inscription_number: 123,
          listability_reasons: ['already listed'],
          active_listing: { listing_id: 'listing-1', marketplace: 'ordnet' },
        },
      ],
    });
  });

  it('requires exactly three PSBT signing steps from preflight', () => {
    const base = {
      intent_id: 'intent-1',
      preview: {
        inscription_number: 123,
        inscription_id: 'id123',
        current_output: 'tx:0',
        postage_sats: 546,
        payout_address: 'bc1qpay',
        price_sats: 10_000_000,
        seller_proceeds_sats: 9_900_000,
        marketplace_fee_sats: 100_000,
        duration_days: 90,
        expires_at: 2_000_000_000,
      },
    };
    expect(() => normalizeListingPreflight({ ...base, signing_steps: [{ psbt: 'one' }] })).toThrow(
      'invalid signing workflow'
    );
    expect(
      normalizeListingPreflight({
        ...base,
        signing_steps: [{ psbt: 'one' }, { psbt: 'two' }, { psbt: 'three' }],
      }).signing_steps.map(step => step.label)
    ).toEqual(['escrow transfer', 'settlement authorization', 'recovery transaction']);
  });

  it('preserves complete ord.net signing declarations for Drey', () => {
    const base = {
      intent_id: 'intent-1',
      preview: {
        inscription_number: 123,
        inscription_id: 'id123',
        current_output: 'tx:0',
        postage_sats: 546,
        payout_address: 'bc1qpay',
        price_sats: 10_000_000,
        seller_proceeds_sats: 9_900_000,
        marketplace_fee_sats: 100_000,
        duration_days: 90,
        expires_at: 2_000_000_000,
      },
    };
    const settlementInput = {
      address: 'bc1pseller',
      signingIndexes: [0],
      publicKey: 'ab'.repeat(32),
      disableTweakSigner: true,
      sigHash: 0x83,
    };
    const result = normalizeListingPreflight({
      ...base,
      signing_steps: [
        { psbt: 'one', inputs_to_sign: [{ ...settlementInput, sigHash: 0 }] },
        { psbt: 'two', inputs_to_sign: [settlementInput] },
        { psbt: 'three', inputs_to_sign: [{ ...settlementInput, sigHash: 1 }] },
      ],
    });
    expect(result.signing_steps[1]?.inputs_to_sign).toEqual([settlementInput]);
  });

  it('requests all three wallet signatures sequentially and stops on rejection', async () => {
    const steps = ['escrow', 'settlement', 'recovery'].map((label, index) => ({
      psbt: label,
      label,
      sign_inputs: { seller: [index] },
    }));
    const order: string[] = [];
    const signer = vi.fn(async (step: ListingSigningStep) => {
      order.push(step.label);
      if (step.label === 'settlement') throw new Error('User rejected');
      return `signed-${step.psbt}`;
    });

    await expect(signListingSteps(steps, signer)).rejects.toThrow('User rejected');
    expect(order).toEqual(['escrow', 'settlement']);
    expect(signer).toHaveBeenCalledTimes(2);
  });
});
