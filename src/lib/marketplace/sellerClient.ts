import type { ListingInputToSign, MarketplaceProviderContext } from './types';

export const LISTING_DURATIONS = [1, 7, 30, 90, 180] as const;
export type ListingDuration = (typeof LISTING_DURATIONS)[number];

export type SellerListing = {
  listing_id: string;
  marketplace: string;
  price_sats: number;
  expires_at: number | null;
  status: string;
};

export type SellerOmb = {
  inscription_number: number;
  inscription_id: string;
  current_output: string | null;
  postage_sats: number | null;
  thumbnail: string;
  full: string;
  listable: boolean;
  listability_reasons: string[];
  active_listing: SellerListing | null;
};

export type SellerOmbsPage = {
  items: SellerOmb[];
  next_cursor: string | null;
};

export type ListingSigningStep = {
  psbt: string;
  sign_inputs?: Record<string, number[]>;
  inputs_to_sign?: ListingInputToSign[];
  label: string;
  marketplace_context?: MarketplaceProviderContext;
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
  duration_days: number;
  expires_at: number;
};

export type ListingPreflight = {
  intent_id: string | number;
  signing_steps: ListingSigningStep[];
  preview: ListingPreview;
};

const BTC_INPUT = /^(?:0|[1-9]\d*)(?:\.(\d{1,8}))?$/;

export function parseBtcPriceToSats(input: string): number {
  const value = input.trim();
  const match = BTC_INPUT.exec(value);
  if (!match) throw new Error('Enter a BTC amount with no more than 8 decimal places.');
  const [whole = '0'] = value.split('.');
  const fraction = (match[1] ?? '').padEnd(8, '0');
  const sats = BigInt(whole) * 100_000_000n + BigInt(fraction || '0');
  if (sats <= 0n) throw new Error('List price must be greater than zero.');
  if (sats > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('List price is too large.');
  return Number(sats);
}

export function normalizeSellerOmbsPage(value: unknown): SellerOmbsPage {
  const root = object(value);
  const candidates = Array.isArray(root.items)
    ? root.items
    : Array.isArray(root.ombs)
      ? root.ombs
      : [];
  return {
    items: candidates.map(normalizeSellerOmb),
    next_cursor: stringOrNull(root.next_cursor ?? root.nextCursor),
  };
}

export function normalizeListingPreflight(value: unknown): ListingPreflight {
  const root = object(value);
  const preview = object(root.preview);
  const rawSteps = Array.isArray(root.signing_steps)
    ? root.signing_steps
    : Array.isArray(root.steps)
      ? root.steps
      : Array.isArray(root.psbts)
        ? root.psbts
        : [];
  const intentId = root.intent_id;
  if ((typeof intentId !== 'string' && typeof intentId !== 'number') || rawSteps.length !== 3) {
    throw new Error('Listing preflight returned an invalid signing workflow.');
  }
  const signingSteps = rawSteps.map((raw, index) => {
    const step = object(raw);
    if (typeof step.psbt !== 'string' || !step.psbt) {
      throw new Error('Listing preflight returned an invalid signing workflow.');
    }
    return {
      psbt: step.psbt,
      sign_inputs: recordOfNumberArrays(step.sign_inputs),
      inputs_to_sign: listingInputsToSign(step.inputs_to_sign),
      label:
        typeof step.label === 'string'
          ? step.label
          : ['escrow transfer', 'settlement authorization', 'recovery transaction'][index]!,
      marketplace_context: (step.marketplace_context ?? step.drey_context) as
        | MarketplaceProviderContext
        | undefined,
    };
  });
  const normalizedPreview: ListingPreview = {
    inscription_number: requiredNumber(preview.inscription_number),
    inscription_id: requiredString(preview.inscription_id),
    current_output: requiredString(preview.current_output ?? preview.outpoint),
    postage_sats: requiredNumber(preview.postage_sats),
    payout_address: requiredString(preview.payout_address),
    price_sats: requiredNumber(preview.price_sats),
    seller_proceeds_sats: requiredNumber(preview.seller_proceeds_sats),
    marketplace_fee_sats: requiredNumber(preview.marketplace_fee_sats),
    duration_days: requiredNumber(preview.duration_days),
    expires_at: requiredNumber(preview.expires_at),
  };
  return { intent_id: intentId, signing_steps: signingSteps, preview: normalizedPreview };
}

export function marketplaceApiError(body: unknown, fallback: string): Error {
  const data = object(body);
  const message = typeof data.error === 'string' ? data.error : fallback;
  const code = typeof data.code === 'string' ? data.code : null;
  if (code === 'auth-required' || code === 'ordnet-auth-required') {
    return new Error('Reconnect and authorize ord.net to continue.');
  }
  if (code === 'stale-ownership') return new Error('Ownership changed. Refresh and try again.');
  if (code === 'unsafe-utxo') return new Error(`This OMB cannot be listed safely. ${message}`);
  if (code === 'existing-listing') return new Error(message);
  if (code === 'unsupported-wallet') return new Error('This wallet cannot safely create listings.');
  if (code === 'stale-preflight') return new Error('Listing details changed. Start again.');
  if (code === 'rate-limit')
    return new Error('Too many listing requests. Wait a minute and retry.');
  if (code === 'ambiguous-upstream-state') {
    return new Error(
      'ord.net may have received this request. Refresh your listings before retrying.'
    );
  }
  return new Error(message);
}

export async function signListingSteps(
  steps: ListingSigningStep[],
  signer: (step: ListingSigningStep, index: number) => Promise<string>
): Promise<string[]> {
  if (steps.length !== 3) throw new Error('Listing requires exactly three wallet signatures.');
  const signed: string[] = [];
  for (const [index, step] of steps.entries()) {
    signed.push(await signer(step, index));
  }
  return signed;
}

function normalizeSellerOmb(value: unknown): SellerOmb {
  const item = object(value);
  const rawListing = item.active_listing ?? item.listing;
  const listing = rawListing ? object(rawListing) : null;
  const reasons = Array.isArray(item.listability_reasons)
    ? item.listability_reasons.filter((reason): reason is string => typeof reason === 'string')
    : typeof item.listability_reason === 'string'
      ? [item.listability_reason]
      : [];
  return {
    inscription_number: requiredNumber(item.inscription_number),
    inscription_id: requiredString(item.inscription_id),
    current_output: stringOrNull(item.current_output ?? item.outpoint),
    postage_sats: optionalNumber(item.postage_sats),
    thumbnail: typeof item.thumbnail === 'string' ? item.thumbnail : '',
    full: typeof item.full === 'string' ? item.full : '',
    listable: item.listable === true,
    listability_reasons: reasons,
    active_listing: listing
      ? {
          listing_id: requiredString(listing.listing_id ?? listing.id),
          marketplace:
            typeof listing.marketplace === 'string'
              ? normalizeMarketplace(listing.marketplace)
              : 'ordnet',
          price_sats: requiredNumber(listing.price_sats),
          expires_at: optionalNumber(listing.expires_at),
          status: typeof listing.status === 'string' ? listing.status : 'active',
        }
      : null,
  };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Marketplace returned invalid data.');
  return value;
}

function requiredNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Marketplace returned invalid data.');
  }
  return value;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function recordOfNumberArrays(value: unknown): Record<string, number[]> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result: Record<string, number[]> = {};
  for (const [key, indexes] of Object.entries(value)) {
    if (!Array.isArray(indexes) || !indexes.every(Number.isSafeInteger)) return undefined;
    result[key] = indexes as number[];
  }
  return result;
}

function listingInputsToSign(value: unknown): ListingInputToSign[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.map(raw => {
    const input = object(raw);
    const signingIndexes = Array.isArray(input.signingIndexes)
      ? input.signingIndexes.filter((index): index is number => Number.isSafeInteger(index))
      : [];
    if (
      typeof input.address !== 'string' ||
      input.address.length === 0 ||
      signingIndexes.length === 0 ||
      signingIndexes.length !== (input.signingIndexes as unknown[]).length
    ) {
      throw new Error('Listing preflight returned invalid wallet signing instructions.');
    }
    return {
      address: input.address,
      signingIndexes,
      ...(typeof input.publicKey === 'string' ? { publicKey: input.publicKey } : {}),
      ...(typeof input.disableTweakSigner === 'boolean'
        ? { disableTweakSigner: input.disableTweakSigner }
        : {}),
      ...(typeof input.sigHash === 'number' && Number.isSafeInteger(input.sigHash)
        ? { sigHash: input.sigHash }
        : {}),
    };
  });
}

function normalizeMarketplace(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, '');
}
