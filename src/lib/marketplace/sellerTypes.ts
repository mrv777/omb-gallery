export const ORDNET_LISTING_DURATIONS = [1, 7, 30, 90, 180] as const;
export type OrdnetListingDurationDays = (typeof ORDNET_LISTING_DURATIONS)[number];

export const ORDNET_SELLER_PROVIDERS = ['xverse', 'unisat', 'leather', 'drey'] as const;
export type OrdnetSellerProvider = (typeof ORDNET_SELLER_PROVIDERS)[number];

export type SellerErrorCode =
  | 'auth-required'
  | 'terms-required'
  | 'stale-ownership'
  | 'unsafe-utxo'
  | 'existing-listing'
  | 'unsupported-wallet'
  | 'stale-preflight'
  | 'rate-limit'
  | 'ambiguous-upstream-state'
  | 'invalid-request';

export type SellerListingSummary = {
  listing_id: string;
  marketplace: string;
  price_sats: number;
  seller: string | null;
  listed_at: number;
  expires_at: number | null;
  status?: 'active' | 'pending_indexing';
};

export type SellerOmb = {
  inscription_number: number;
  inscription_id: string;
  current_output: string;
  current_owner: string;
  color: string | null;
  thumbnail: string;
  full: string;
  description: string;
  active_loan: boolean;
  listings: SellerListingSummary[];
  listable: boolean;
  listability_code:
    | 'listable'
    | 'missing-inscription-id'
    | 'missing-output'
    | 'active-loan'
    | 'listed-ordnet'
    | 'listing-pending'
    | 'listed-elsewhere';
  listability_reason: string | null;
  listing_intent_status: 'created' | 'submitting' | 'pending_indexing' | null;
};

export type OrdnetSellerSigningInput = {
  address: string;
  signingIndexes: number[];
  publicKey?: string;
  disableTweakSigner?: boolean;
  sigHash?: number;
};

export type OrdnetSellerSigningStep = {
  psbt: string;
  sign_inputs: Record<string, number[]>;
  inputs_to_sign: OrdnetSellerSigningInput[];
  label: 'escrow-transfer' | 'settlement' | 'recovery';
  marketplace_context?: unknown;
};

export type ListingPreview = {
  inscription_number: number;
  inscription_id: string;
  current_output: string;
  postage_sats: number;
  payout_address: string;
  price_sats: number;
  seller_proceeds_sats: number;
  marketplace_fee_sats: number;
  duration_days: OrdnetListingDurationDays;
  expires_at: number;
};

export function parseOrdnetListingDuration(value: unknown): OrdnetListingDurationDays | null {
  return typeof value === 'number' &&
    ORDNET_LISTING_DURATIONS.includes(Math.trunc(value) as OrdnetListingDurationDays)
    ? (Math.trunc(value) as OrdnetListingDurationDays)
    : null;
}

export function parseOrdnetSellerProvider(value: unknown): OrdnetSellerProvider | null {
  return typeof value === 'string' &&
    ORDNET_SELLER_PROVIDERS.includes(value.toLowerCase() as OrdnetSellerProvider)
    ? (value.toLowerCase() as OrdnetSellerProvider)
    : null;
}

export function parseListingPriceSats(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
  // Bitcoin's total supply is also a useful hard ceiling for accidental/hostile JSON values.
  return value > 0 && value <= 2_100_000_000_000_000 ? value : null;
}

export function signingInputsByAddress(
  inputs: OrdnetSellerSigningInput[]
): Record<string, number[]> {
  const result: Record<string, number[]> = {};
  for (const input of inputs) {
    result[input.address] = [...(result[input.address] ?? []), ...input.signingIndexes];
  }
  return result;
}
