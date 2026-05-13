import 'server-only';

import { SatflowError } from '@/lib/satflow';
import type { MarketplaceListing } from './types';

const SATFLOW_BUY_BASE = (
  process.env.SATFLOW_BUY_BASE_URL ??
  process.env.SATFLOW_BASE_URL ??
  'https://api.satflow.com'
).replace(/\/+$/, '');

export type SatflowPurchaseIntentArgs = {
  listing: MarketplaceListing;
  buyerOrdAddr: string;
  buyerPayAddr: string | null;
  buyerOrdPubkey: string | null;
  buyerPayPubkey: string | null;
};

export type SatflowPurchaseIntent = {
  psbt: string;
  signInputs?: Record<string, number[]>;
  raw: unknown;
};

export type SatflowBroadcastResult = {
  txid: string;
  raw: unknown;
};

export class SatflowBuyContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SatflowBuyContractError';
  }
}

export async function createSatflowPurchaseIntent(
  args: SatflowPurchaseIntentArgs
): Promise<SatflowPurchaseIntent> {
  void args;
  throw new SatflowBuyContractError(
    `Satflow native purchase is not wired: public docs currently expose ${SATFLOW_BUY_BASE}/v1/intent/external-purchase for external marketplace payloads, but MARKETPLACE.md specifies Satflow's own /intent/secure-purchase flow. Need the exact native request/response contract before enabling real BTC buys.`
  );
}

export async function broadcastSatflowPurchase(
  intentId: number,
  signedPsbt: string
): Promise<SatflowBroadcastResult> {
  void intentId;
  void signedPsbt;
  throw new SatflowBuyContractError(
    'Satflow signed-PSBT broadcast is not wired until the native purchase contract confirms who broadcasts and which response field carries the txid.'
  );
}

export function satflowBuyErrorResponse(err: unknown): { message: string; status: number } {
  if (err instanceof SatflowBuyContractError) {
    return { message: err.message, status: 501 };
  }
  if (err instanceof SatflowError) {
    return { message: err.message, status: err.status ?? 502 };
  }
  return { message: err instanceof Error ? err.message : String(err), status: 500 };
}
