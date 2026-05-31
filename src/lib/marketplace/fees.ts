export type MarketplaceBuyerCostEstimate = {
  estimated_buyer_fee_sats: number;
  estimated_buyer_total_sats: number;
  buyer_fee_bps: number;
  buyer_fee_label: string;
  buyer_total_label: string;
};

const BPS_DENOMINATOR = 10_000;
const ORDNET_BUYER_FEE_BPS = 150;
const ORDNET_MIN_BUYER_FEE_SATS = 1_000;
const SATFLOW_BUYER_FEE_BPS = 250;

export function estimateMarketplaceBuyerCost(
  marketplace: string,
  priceSats: number
): MarketplaceBuyerCostEstimate {
  const price = normalizePrice(priceSats);
  const key = normalizeMarketplaceKey(marketplace);
  if (isOrdnetKey(key)) {
    const fee = Math.max(ORDNET_MIN_BUYER_FEE_SATS, ceilBps(price, ORDNET_BUYER_FEE_BPS));
    return {
      estimated_buyer_fee_sats: fee,
      estimated_buyer_total_sats: price + fee,
      buyer_fee_bps: ORDNET_BUYER_FEE_BPS,
      buyer_fee_label: 'ORD.NET taker fee',
      buyer_total_label: 'est. before network',
    };
  }
  if (key === 'satflow') {
    const fee = ceilBps(price, SATFLOW_BUYER_FEE_BPS);
    return {
      estimated_buyer_fee_sats: fee,
      estimated_buyer_total_sats: price + fee,
      buyer_fee_bps: SATFLOW_BUYER_FEE_BPS,
      buyer_fee_label: 'Satflow buyer fee estimate',
      buyer_total_label: 'est. before network',
    };
  }

  return {
    estimated_buyer_fee_sats: 0,
    estimated_buyer_total_sats: price,
    buyer_fee_bps: 0,
    buyer_fee_label: 'buyer fee unknown',
    buyer_total_label: 'est. before network',
  };
}

export function cheapestBuyerCostOption<T extends MarketplaceBuyerCostEstimate>(options: T[]): T {
  const first = options[0];
  if (!first) {
    throw new Error('cheapestBuyerCostOption requires at least one option');
  }
  return options.reduce((best, option) =>
    option.estimated_buyer_total_sats < best.estimated_buyer_total_sats ? option : best
  );
}

export function highestBuyerCostOption<T extends MarketplaceBuyerCostEstimate>(options: T[]): T {
  const first = options[0];
  if (!first) {
    throw new Error('highestBuyerCostOption requires at least one option');
  }
  return options.reduce((best, option) =>
    option.estimated_buyer_total_sats > best.estimated_buyer_total_sats ? option : best
  );
}

function ceilBps(priceSats: number, bps: number): number {
  if (priceSats <= 0) return 0;
  return Math.ceil((priceSats * bps) / BPS_DENOMINATOR);
}

function normalizePrice(priceSats: number): number {
  return Number.isFinite(priceSats) && priceSats > 0 ? Math.trunc(priceSats) : 0;
}

function normalizeMarketplaceKey(value: string): string {
  return value.trim().toLowerCase();
}

function isOrdnetKey(key: string): boolean {
  return key === 'ord.net' || key === 'ordnet' || key === 'ord-net';
}
