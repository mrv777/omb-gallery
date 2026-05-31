import 'server-only';

import { SatflowError } from '@/lib/satflow';
import type {
  BuyIntentRow,
  MarketplaceIntentQuote,
  MarketplaceListing,
  PurchasePsbtToSign,
} from './types';

const SATFLOW_BASE = (
  process.env.SATFLOW_BUY_BASE_URL ??
  process.env.SATFLOW_BASE_URL ??
  'https://api.satflow.com'
).replace(/\/+$/, '');
const SATFLOW_V1_BASE = SATFLOW_BASE.endsWith('/v1') ? SATFLOW_BASE : `${SATFLOW_BASE}/v1`;
const REQUEST_TIMEOUT_MS = 25_000;
const DEFAULT_FEE_RATE = process.env.SATFLOW_PURCHASE_FEE_RATE ?? 'halfHourFee';
const DEFAULT_EXTRACTION_FEE_RATE =
  process.env.SATFLOW_PURCHASE_EXTRACTION_FEE_RATE ?? DEFAULT_FEE_RATE;

type SatflowFeeRate = 'fastestFee' | 'halfHourFee' | 'hourFee' | 'minimumFee' | number;
type SatflowSecureStage = 'payment-prep' | 'purchase' | 'bulk';

type SatflowSecurePurchaseRequest = {
  inscriptionIds: string[];
  buyerAddress: string;
  buyerTokenReceiveAddress: string;
  buyerPublicKey: string | null;
  buyerScripts?: Array<{ type?: string; script: string }>;
  feeRate: SatflowFeeRate;
  disableCompactPurchase: boolean;
  signedPaymentPrepPSBTs?: string[];
  signedPurchasePSBTs?: string[];
  referralAddress?: string;
  creatorFee?: boolean;
};

type StoredSatflowPreflight = {
  v: 1;
  kind: 'satflow-secure';
  stage: SatflowSecureStage;
  request: SatflowSecurePurchaseRequest;
  response: unknown;
  signedPaymentPrepPSBTs?: string[];
  unsignedBulkBuyingPSBT?: string;
  referralAddress?: string;
  creatorFee?: boolean;
  buyerTokenReceivePublicKey: string;
  createdAt: number;
  updatedAt: number;
};

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
  psbts: PurchasePsbtToSign[];
  step: string;
  preflightJson: string;
  raw: unknown;
};

export type SatflowNextSigningStep = {
  type: 'next';
  psbt: string;
  signInputs?: Record<string, number[]>;
  psbts: PurchasePsbtToSign[];
  step: string;
  preflightJson: string;
  raw: unknown;
};

export type SatflowBroadcastResult = {
  type: 'broadcast';
  txid: string;
  raw: unknown;
};

export class SatflowBuyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SatflowBuyConfigError';
  }
}

export class SatflowBuyResponseError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly bodyExcerpt?: string
  ) {
    super(message);
    this.name = 'SatflowBuyResponseError';
  }
}

export async function createSatflowPurchaseIntent(
  args: SatflowPurchaseIntentArgs
): Promise<SatflowPurchaseIntent> {
  if (!args.buyerPayAddr) {
    throw new SatflowBuyConfigError('Satflow purchases require a payment address from the wallet.');
  }
  if (!args.buyerPayPubkey) {
    throw new SatflowBuyConfigError(
      'Satflow purchases require a payment public key from the wallet.'
    );
  }
  if (!args.buyerOrdPubkey) {
    throw new SatflowBuyConfigError(
      'Satflow purchases require an ordinals public key from the wallet.'
    );
  }

  const request: SatflowSecurePurchaseRequest = {
    inscriptionIds: [args.listing.inscription_id],
    buyerAddress: args.buyerPayAddr,
    buyerTokenReceiveAddress: args.buyerOrdAddr,
    buyerPublicKey: args.buyerPayPubkey,
    feeRate: parseFeeRate(DEFAULT_FEE_RATE),
    disableCompactPurchase: true,
  };
  // Use Satflow's secure purchase path so the response can include the
  // payment-prep -> purchase signing flow. `/purchase/broadcast` handles the
  // final submit for secure and non-secure Satflow purchases.
  const raw = await postSatflowJson('/intent/secure-purchase', request);
  const intent = buildSigningIntent({
    request,
    raw,
    signerAddress: args.buyerPayAddr,
    buyerTokenReceivePublicKey: args.buyerOrdPubkey,
    signedPaymentPrepPSBTs: undefined,
  });
  return {
    psbt: intent.psbts[0].psbt,
    signInputs: intent.psbts[0].sign_inputs,
    psbts: intent.psbts,
    step: `satflow-${intent.stage}`,
    preflightJson: JSON.stringify(intent.preflight),
    raw,
  };
}

export async function broadcastSatflowPurchase(
  intent: BuyIntentRow,
  signedPsbts: string[]
): Promise<SatflowBroadcastResult | SatflowNextSigningStep> {
  const stored = parseStoredSatflowPreflight(intent.preflight_json);
  if (!stored) {
    throw new SatflowBuyConfigError('Satflow purchase intent is missing preflight state.');
  }
  if (signedPsbts.length === 0) {
    throw new SatflowBuyConfigError('Satflow purchase requires at least one signed PSBT.');
  }

  if (stored.stage === 'payment-prep') {
    const request: SatflowSecurePurchaseRequest = {
      ...stored.request,
      signedPaymentPrepPSBTs: signedPsbts,
      ...(stored.referralAddress ? { referralAddress: stored.referralAddress } : {}),
      ...(typeof stored.creatorFee === 'boolean' ? { creatorFee: stored.creatorFee } : {}),
    };
    const raw = await postSatflowJson('/intent/secure-purchase', request);
    const next = buildSigningIntent({
      request,
      raw,
      signerAddress: stored.request.buyerAddress,
      buyerTokenReceivePublicKey: stored.buyerTokenReceivePublicKey,
      signedPaymentPrepPSBTs: signedPsbts,
    });
    return {
      type: 'next',
      psbt: next.psbts[0].psbt,
      signInputs: next.psbts[0].sign_inputs,
      psbts: next.psbts,
      step: `satflow-${next.stage}`,
      preflightJson: JSON.stringify(next.preflight),
      raw,
    };
  }

  const broadcastBody = satflowBroadcastBody(stored, signedPsbts);
  const raw = await postSatflowJson('/purchase/broadcast', broadcastBody);
  const txid = parseBroadcastTxid(raw);
  return { type: 'broadcast', txid, raw };
}

export function satflowBuyErrorResponse(err: unknown): {
  message: string;
  status: number;
  quote?: MarketplaceIntentQuote;
} {
  if (err instanceof SatflowBuyConfigError) {
    return { message: err.message, status: 501 };
  }
  if (err instanceof SatflowBuyResponseError) {
    return {
      message: err.message,
      status: err.status ?? 502,
      ...quoteProp(parseSatflowQuoteFromBody(err.bodyExcerpt)),
    };
  }
  if (err instanceof SatflowError) {
    return {
      message: satflowErrorMessage(err),
      status: err.status ?? 502,
      ...quoteProp(parseSatflowQuoteFromBody(err.bodyExcerpt)),
    };
  }
  return { message: err instanceof Error ? err.message : String(err), status: 500 };
}

function buildSigningIntent(args: {
  request: SatflowSecurePurchaseRequest;
  raw: unknown;
  signerAddress: string;
  buyerTokenReceivePublicKey: string;
  signedPaymentPrepPSBTs: string[] | undefined;
}): {
  stage: SatflowSecureStage;
  psbts: PurchasePsbtToSign[];
  preflight: StoredSatflowPreflight;
} {
  const data = responseData(args.raw);
  const paymentPrep = extractPsbtList(data, PAYMENT_PREP_PSBT_KEYS, args.signerAddress, 'prep');
  const purchase = extractPsbtList(data, PURCHASE_PSBT_KEYS, args.signerAddress, 'purchase');
  const bulk = extractSinglePsbt(data, BULK_PSBT_KEYS, args.signerAddress, 'purchase');
  const meta = responseMeta(data);
  const now = Math.floor(Date.now() / 1000);

  if (paymentPrep.length > 0 && !args.signedPaymentPrepPSBTs) {
    return {
      stage: 'payment-prep',
      psbts: paymentPrep,
      preflight: {
        v: 1,
        kind: 'satflow-secure',
        stage: 'payment-prep',
        request: args.request,
        response: args.raw,
        referralAddress: meta.referralAddress,
        creatorFee: meta.creatorFee,
        buyerTokenReceivePublicKey: args.buyerTokenReceivePublicKey,
        createdAt: now,
        updatedAt: now,
      },
    };
  }
  if (purchase.length > 0) {
    return {
      stage: 'purchase',
      psbts: purchase,
      preflight: {
        v: 1,
        kind: 'satflow-secure',
        stage: 'purchase',
        request: args.request,
        response: args.raw,
        signedPaymentPrepPSBTs: args.signedPaymentPrepPSBTs,
        referralAddress: meta.referralAddress,
        creatorFee: meta.creatorFee,
        buyerTokenReceivePublicKey: args.buyerTokenReceivePublicKey,
        createdAt: now,
        updatedAt: now,
      },
    };
  }
  if (bulk) {
    return {
      stage: 'bulk',
      psbts: [bulk],
      preflight: {
        v: 1,
        kind: 'satflow-secure',
        stage: 'bulk',
        request: args.request,
        response: args.raw,
        unsignedBulkBuyingPSBT: bulk.psbt,
        referralAddress: meta.referralAddress,
        creatorFee: meta.creatorFee,
        buyerTokenReceivePublicKey: args.buyerTokenReceivePublicKey,
        createdAt: now,
        updatedAt: now,
      },
    };
  }

  throw new SatflowBuyResponseError(
    `Satflow did not return a purchase PSBT. Response keys: ${describeKeys(data)}.`,
    null,
    JSON.stringify(args.raw).slice(0, 1000)
  );
}

function satflowBroadcastBody(stored: StoredSatflowPreflight, signedPsbts: string[]) {
  const base = {
    inscriptionIds: stored.request.inscriptionIds,
    buyerAddress: stored.request.buyerAddress,
    buyerTokenReceiveAddress: stored.request.buyerTokenReceiveAddress,
    buyerTokenReceivePublicKey: stored.buyerTokenReceivePublicKey,
    buyerPublicKey: stored.request.buyerPublicKey,
    feeRate: stored.request.feeRate,
    extractionFeeRate: parseFeeRate(DEFAULT_EXTRACTION_FEE_RATE),
    referralAddress: stored.referralAddress,
    creatorFee: stored.creatorFee,
  };
  if (stored.stage === 'bulk') {
    return {
      ...base,
      signedBulkBuyingPSBT: signedPsbts[0],
      unsignedBulkBuyingPSBT: stored.unsignedBulkBuyingPSBT,
      securePurchase: false,
    };
  }
  return {
    ...base,
    signedSecurePaymentPrepPSBTs: stored.signedPaymentPrepPSBTs ?? [],
    signedSecurePurchasePSBTs: signedPsbts,
    securePurchase: true,
  };
}

async function postSatflowJson(path: string, body: unknown): Promise<unknown> {
  const apiKey = process.env.SATFLOW_API_KEY;
  if (!apiKey) {
    throw new SatflowBuyConfigError('SATFLOW_API_KEY is required for Satflow purchases.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${SATFLOW_V1_BASE}${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new SatflowBuyResponseError(
        satflowHttpErrorMessage(res.status, text),
        res.status,
        text.slice(0, 1000)
      );
    }
    return text ? JSON.parse(text) : null;
  } catch (err) {
    if (err instanceof SatflowBuyResponseError || err instanceof SatflowBuyConfigError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new SatflowBuyResponseError('Satflow purchase request timed out.', null);
    }
    throw new SatflowBuyResponseError(err instanceof Error ? err.message : String(err), null);
  } finally {
    clearTimeout(timer);
  }
}

const PAYMENT_PREP_PSBT_KEYS = [
  'securePaymentPrepPSBTs',
  'unsignedSecurePaymentPrepPSBTs',
  'paymentPrepPSBTs',
  'unsignedPaymentPrepPSBTs',
  'paymentPreparationPSBTs',
];
const PURCHASE_PSBT_KEYS = [
  'securePurchasePSBTs',
  'unsignedSecurePurchasePSBTs',
  'purchasePSBTs',
  'unsignedPurchasePSBTs',
  'secureBuyingPSBTs',
  'unsignedSecureBuyingPSBTs',
];
const BULK_PSBT_KEYS = [
  'unsignedBulkBuyingPSBT',
  'unsignedBulkBuyingPSBTBase64',
  'unsignedBuyingPSBT',
  'unsignedBuyingPSBTBase64',
  'buyingPSBT',
  'buyingPSBTBase64',
];

function extractPsbtList(
  data: unknown,
  keys: string[],
  signerAddress: string,
  label: string
): PurchasePsbtToSign[] {
  for (const root of responseCandidateObjects(data)) {
    for (const key of keys) {
      const value = root[key];
      const list = Array.isArray(value) ? value : cleanString(value) ? [value] : null;
      if (!list || list.length === 0) continue;
      const normalized = list
        .map((item, index) => normalizePsbtToSign(item, signerAddress, `${label}-${index + 1}`))
        .filter((item): item is PurchasePsbtToSign => item != null);
      if (normalized.length > 0) return normalized;
    }
  }
  return [];
}

function extractSinglePsbt(
  data: unknown,
  keys: string[],
  signerAddress: string,
  label: string
): PurchasePsbtToSign | null {
  for (const root of responseCandidateObjects(data)) {
    for (const key of keys) {
      const normalized = normalizePsbtToSign(root[key], signerAddress, label);
      if (normalized) return normalized;
    }
  }
  return null;
}

function normalizePsbtToSign(
  value: unknown,
  signerAddress: string,
  label: string
): PurchasePsbtToSign | null {
  if (typeof value === 'string' && value.length > 0) {
    return { psbt: value, label };
  }
  const obj = objectRecord(value);
  if (!obj) return null;
  const psbt =
    cleanString(obj.psbt) ??
    cleanString(obj.psbtBase64) ??
    cleanString(obj.psbt_base64) ??
    cleanString(obj.base64) ??
    cleanString(obj.unsignedPSBT) ??
    cleanString(obj.unsignedPSBTBase64);
  if (!psbt) return null;
  const indexes = cleanNumberArray(
    obj.indicesToSign ?? obj.signingIndexes ?? obj.inputsToSign ?? obj.inputIndexes
  );
  return {
    psbt,
    label,
    ...(indexes.length > 0 ? { sign_inputs: { [signerAddress]: indexes } } : {}),
  };
}

function responseData(raw: unknown): unknown {
  const root = objectRecord(raw);
  if (!root) return raw;
  return root.data ?? raw;
}

function responseCandidateObjects(data: unknown): Record<string, unknown>[] {
  const root = objectRecord(data);
  if (!root) return [];
  return [
    root,
    objectRecord(root.buyer),
    objectRecord(root.purchase),
    objectRecord(root.securePurchase),
    objectRecord(root.intent),
    objectRecord(root.psbts),
  ].filter((item): item is Record<string, unknown> => item != null);
}

function responseMeta(data: unknown): { referralAddress?: string; creatorFee?: boolean } {
  const obj = objectRecord(data);
  if (!obj) return {};
  return {
    ...(cleanString(obj.referralAddress)
      ? { referralAddress: cleanString(obj.referralAddress)! }
      : {}),
    ...(typeof obj.creatorFee === 'boolean' ? { creatorFee: obj.creatorFee } : {}),
  };
}

function parseStoredSatflowPreflight(
  raw: string | null | undefined
): StoredSatflowPreflight | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredSatflowPreflight;
    if (!parsed || parsed.v !== 1 || parsed.kind !== 'satflow-secure') return null;
    if (!parsed.request || !parsed.buyerTokenReceivePublicKey) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseBroadcastTxid(raw: unknown): string {
  const data = responseData(raw);
  const root = objectRecord(data);
  const txid =
    cleanString(root?.fillTx) ??
    cleanString(root?.txid) ??
    cleanString(root?.transactionId) ??
    cleanString(objectRecord(raw)?.fillTx);
  if (!txid) {
    throw new SatflowBuyResponseError(
      `Satflow broadcast succeeded but did not return a txid. Response keys: ${describeKeys(data)}.`,
      null,
      JSON.stringify(raw).slice(0, 1000)
    );
  }
  return txid;
}

function satflowHttpErrorMessage(status: number, body: string): string {
  const detail = responseErrorDetail(body);
  const base = `Satflow purchase request failed with HTTP ${status}`;
  return detail ? `${base}: ${detail}` : base;
}

function satflowErrorMessage(err: SatflowError): string {
  const detail = err.bodyExcerpt ? responseErrorDetail(err.bodyExcerpt) : null;
  return detail ? `${err.message}: ${detail}` : err.message;
}

function responseErrorDetail(body: string): string | null {
  const value = responseErrorDetailRaw(body);
  return value ? truncateErrorDetail(value) : null;
}

function responseErrorDetailRaw(body: string | null | undefined): string | null {
  const trimmed = body?.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const obj = objectRecord(parsed);
    const value = cleanString(obj?.error) ?? cleanString(obj?.message) ?? cleanString(obj?.detail);
    if (value) return value;
  } catch {
    // fall through to plain text handling
  }
  return trimmed.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
}

export function parseSatflowQuoteFromBody(
  body: string | null | undefined
): MarketplaceIntentQuote | null {
  const detail = responseErrorDetailRaw(body);
  if (!detail) return null;
  const totalRequired = btcLineToSats(detail, /Total required:\s*([0-9.,]+)\s*BTC/i);
  const networkFee = btcLineToSats(detail, /Network fees?:\s*([0-9.,]+)\s*BTC/i);
  const spendable = btcLineToSats(detail, /Spendable funds:\s*([0-9.,]+)\s*BTC/i);
  if (totalRequired == null && networkFee == null && spendable == null) return null;
  return {
    marketplace: 'satflow',
    total_required_sats: totalRequired,
    network_fee_sats: networkFee,
    spendable_funds_sats: spendable,
  };
}

function btcLineToSats(text: string, pattern: RegExp): number | null {
  const match = pattern.exec(text);
  if (!match?.[1]) return null;
  return btcStringToSats(match[1]);
}

function btcStringToSats(raw: string): number | null {
  const clean = raw.replace(/,/g, '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(clean)) return null;
  const [wholeRaw, fracRaw = ''] = clean.split('.');
  const whole = Number(wholeRaw);
  if (!Number.isSafeInteger(whole)) return null;
  const frac = `${fracRaw}00000000`.slice(0, 8);
  return whole * 100_000_000 + Number(frac);
}

function quoteProp(quote: MarketplaceIntentQuote | null): { quote?: MarketplaceIntentQuote } {
  return quote ? { quote } : {};
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function cleanNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => (typeof item === 'number' ? Math.trunc(item) : Number.NaN))
    .filter(item => Number.isFinite(item) && item >= 0);
}

function parseFeeRate(value: string): SatflowFeeRate {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0.01) return n;
  if (
    value === 'fastestFee' ||
    value === 'halfHourFee' ||
    value === 'hourFee' ||
    value === 'minimumFee'
  ) {
    return value;
  }
  return 'halfHourFee';
}

function describeKeys(value: unknown): string {
  const obj = objectRecord(value);
  if (!obj) return '(non-object response)';
  const keys = Object.keys(obj);
  return keys.length > 0 ? keys.join(', ') : '(empty object)';
}

function truncateErrorDetail(value: string): string {
  return value.length > 260 ? `${value.slice(0, 257)}...` : value;
}
