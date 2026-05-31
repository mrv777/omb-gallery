import { describe, expect, it } from 'vitest';
import { estimateMarketplaceBuyerCost } from '../src/lib/marketplace/fees';
import { parseSatflowQuoteFromBody } from '../src/lib/marketplace/satflowBuy';

describe('marketplace buyer fee estimates', () => {
  it('uses the observed Satflow buyer-fee estimate', () => {
    expect(estimateMarketplaceBuyerCost('satflow', 1_750_000)).toMatchObject({
      estimated_buyer_fee_sats: 43_750,
      estimated_buyer_total_sats: 1_793_750,
      buyer_fee_bps: 250,
    });
  });

  it('uses the ORD.NET taker-fee estimate with the 1000 sat minimum', () => {
    expect(estimateMarketplaceBuyerCost('ord.net', 1_750_000)).toMatchObject({
      estimated_buyer_fee_sats: 26_250,
      estimated_buyer_total_sats: 1_776_250,
      buyer_fee_bps: 150,
    });
    expect(estimateMarketplaceBuyerCost('ordnet', 10_000).estimated_buyer_fee_sats).toBe(1_000);
  });
});

describe('Satflow quote parsing', () => {
  it('extracts insufficient-funds quote fields from Satflow API errors', () => {
    const quote = parseSatflowQuoteFromBody(
      JSON.stringify({
        success: false,
        error:
          'Not enough spendable funds.\n\nSpendable funds: 0.01187687 BTC\nNetwork fees: 0.00000428 BTC\nTotal required: 0.01796465 BTC',
      })
    );

    expect(quote).toEqual({
      marketplace: 'satflow',
      spendable_funds_sats: 1_187_687,
      network_fee_sats: 428,
      total_required_sats: 1_796_465,
    });
  });
});
