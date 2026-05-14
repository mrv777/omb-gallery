import 'server-only';

import { Signer } from 'bip322-js';
import type { BuyIntentRow, MarketplaceListing } from '@/lib/marketplace/types';

const ORDNET_API_BASE = (process.env.ORDNET_API_BASE_URL ?? 'https://ord.net/api/v1').replace(
  /\/+$/,
  ''
);
const MEMPOOL_API_BASE = (process.env.MEMPOOL_API_BASE_URL ?? 'https://mempool.space/api').replace(
  /\/+$/,
  ''
);
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 3;
const SERVICE_TOKEN_REFRESH_MARGIN_MS = 2 * 60 * 1000;

type AuthChallengeRole = 'ordinals' | 'payment';

export type OrdnetAuthChallenge = {
  challengeId: string;
  message: string;
  address: string;
  role: AuthChallengeRole;
};

export type OrdnetWalletBinding = {
  walletBindingId: string;
  label: string;
  provider: string;
  ordinalsAddress: string;
  paymentAddress: string;
  isPublic: boolean;
};

export type OrdnetVerifiedSession = {
  sessionToken: string;
  expiresAt: string;
  walletBindings: OrdnetWalletBinding[];
};

export type OrdnetListing = {
  listing_id: string;
  inscription_id: string;
  price_sats: number;
  seller: string | null;
  listed_at: number;
  marketplace: 'ord.net';
  raw_json: string;
};

export type FetchOrdnetListingsArgs = {
  collectionSlug: string;
  cursor?: string | null;
  limit?: number;
  sort?: 'recent' | 'price';
};

export type FetchOrdnetListingsResult = {
  items: OrdnetListing[];
  rawCount: number;
  hasMore: boolean;
  nextCursor: string | null;
};

type ServiceWalletConfig = {
  ordAddr: string;
  ordWif: string;
  payAddr: string;
  payWif: string;
};

type CachedServiceToken = {
  token: string;
  expiresAtMs: number;
  walletKey: string;
};

type PsbtStep = {
  stepIndex: number;
  signerAddress: string;
  inputsToSign: Array<{
    address: string;
    signingIndexes: number[];
    publicKey?: string;
    disableTweakSigner?: boolean;
    sigHash?: number;
  }>;
  psbtBase64: string;
};

type SpendableUtxo = {
  txid: string;
  vout: number;
  valueSats: number;
};

type PurchaseRequestListing = {
  listingId: string;
  inscriptionId: string;
};

type PurchasePreflightRequest = {
  walletBindingId: string;
  paymentPublicKey: string;
  listings: PurchaseRequestListing[];
  spendableUtxos?: SpendableUtxo[];
};

type PurchasePreflightResponse = {
  purchaseAnchorUtxoId: string;
  selectedPaymentUtxos: SpendableUtxo[];
  steps: PsbtStep[];
  expectedSettlementTxid: string;
  expectedListingTransferTxids: string[];
};

type StoredOrdnetPreflight = {
  v: 1;
  collectionSlug: string;
  request: PurchasePreflightRequest;
  response: PurchasePreflightResponse;
  createdAt: number;
};

export type OrdnetPurchaseIntent = {
  psbt: string;
  signInputs: Record<string, number[]>;
  preflightJson: string;
  raw: PurchasePreflightResponse;
};

export type OrdnetBroadcastResult = {
  txid: string;
  raw: unknown;
};

export class OrdnetError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly bodyExcerpt?: string
  ) {
    super(message);
    this.name = 'OrdnetError';
  }
}

export class OrdnetConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrdnetConfigError';
  }
}

let cachedServiceToken: CachedServiceToken | null = null;

export function ordnetCollectionSlugFor(collectionSlug: string): string | null {
  if (collectionSlug !== 'omb') return null;
  return (
    cleanEnv(process.env.ORDNET_OMB_COLLECTION_SLUG) ??
    cleanEnv(process.env.ORDNET_COLLECTION_SLUG) ??
    collectionSlug
  );
}

export function ordnetServiceWalletConfigured(): boolean {
  return readServiceWalletConfig({ throwOnPartial: true }) != null;
}

export async function createOrdnetAuthChallenge(args: {
  ordinalsAddress: string;
  paymentAddress: string;
}): Promise<{ authRequestId: string; challenges: OrdnetAuthChallenge[] }> {
  const json = await postJson('/auth/challenge', {
    ordinalsAddress: args.ordinalsAddress,
    paymentAddress: args.paymentAddress,
  });
  return parseAuthChallengeResponse(json);
}

export async function verifyOrdnetAuthChallenge(args: {
  authRequestId: string;
  verifications: Array<{ challengeId: string; address: string; signature: string }>;
}): Promise<OrdnetVerifiedSession> {
  const json = await postJson('/auth/verify', {
    authRequestId: args.authRequestId,
    verifications: args.verifications,
  });
  return parseAuthVerifyResponse(json);
}

export async function fetchOrdnetListingsPage(
  args: FetchOrdnetListingsArgs
): Promise<FetchOrdnetListingsResult> {
  const token = await getServiceBearerToken();
  const url = new URL(`${ORDNET_API_BASE}/listings`);
  url.searchParams.set('collectionSlug', args.collectionSlug);
  url.searchParams.set('sort', args.sort ?? 'price');
  url.searchParams.set('limit', String(Math.max(1, Math.min(args.limit ?? 100, 100))));
  if (args.cursor) url.searchParams.set('cursor', args.cursor);

  const json = await getJson(url.toString(), token);
  return parseListingsResponse(json);
}

export async function createOrdnetPurchaseIntent(args: {
  listing: MarketplaceListing;
  buyerPayAddr: string | null;
  buyerPayPubkey: string | null;
  ordnetSession: {
    session_token: string;
    wallet_binding_id: string;
  };
}): Promise<OrdnetPurchaseIntent> {
  if (!args.buyerPayPubkey) {
    throw new OrdnetConfigError('ORD.NET purchases require a payment public key from the wallet.');
  }
  if (!args.buyerPayAddr) {
    throw new OrdnetConfigError('ORD.NET purchases require a payment address from the wallet.');
  }
  const collectionSlug = ordnetCollectionSlugFor('omb') ?? 'omb';
  const spendableUtxos = await fetchSpendablePaymentUtxos(args.buyerPayAddr);
  if (spendableUtxos.length === 0) {
    throw new OrdnetError(
      'ORD.NET requires spendable BTC on the connected payment address, but no payment UTXOs were found.',
      403,
      false
    );
  }
  const spendableTotal = spendableUtxos.reduce((sum, utxo) => sum + utxo.valueSats, 0);
  if (spendableTotal < args.listing.price_sats) {
    throw new OrdnetError(
      'ORD.NET requires enough spendable BTC on the connected payment address for the listing price plus fees.',
      403,
      false
    );
  }
  const requestBody: PurchasePreflightRequest = {
    walletBindingId: args.ordnetSession.wallet_binding_id,
    paymentPublicKey: args.buyerPayPubkey,
    listings: [
      {
        listingId: args.listing.listing_id,
        inscriptionId: args.listing.inscription_id,
      },
    ],
    spendableUtxos,
  };

  const raw = await postJson(
    `/collection/${encodeURIComponent(collectionSlug)}/purchases/preflight`,
    requestBody,
    args.ordnetSession.session_token
  );
  const response = parsePurchasePreflightResponse(raw);
  const step = response.steps[0];
  const stored: StoredOrdnetPreflight = {
    v: 1,
    collectionSlug,
    request: requestBody,
    response,
    createdAt: Math.floor(Date.now() / 1000),
  };

  return {
    psbt: step.psbtBase64,
    signInputs: psbtStepToSignInputs(step),
    preflightJson: JSON.stringify(stored),
    raw: response,
  };
}

export async function broadcastOrdnetPurchase(args: {
  intent: BuyIntentRow;
  signedPsbt: string;
  ordnetSession: { session_token: string };
}): Promise<OrdnetBroadcastResult> {
  const stored = parseStoredOrdnetPreflight(args.intent.preflight_json);
  if (!stored) {
    throw new OrdnetConfigError('ORD.NET purchase intent is missing preflight state.');
  }
  const originalStep = stored.response.steps[0];
  const submitBody = {
    ...stored.request,
    purchaseAnchorUtxoId: stored.response.purchaseAnchorUtxoId,
    selectedPaymentUtxos: stored.response.selectedPaymentUtxos,
    signedSteps: [{ ...originalStep, psbtBase64: args.signedPsbt }],
  };
  const raw = await postJson(
    `/collection/${encodeURIComponent(stored.collectionSlug)}/purchases/submit`,
    submitBody,
    args.ordnetSession.session_token
  );
  const txid = parseSubmitTxid(raw);
  return { txid, raw };
}

export function ordnetErrorResponse(err: unknown): { message: string; status: number } {
  if (err instanceof OrdnetConfigError) return { message: err.message, status: 501 };
  if (err instanceof OrdnetError) return { message: err.message, status: err.status ?? 502 };
  return { message: err instanceof Error ? err.message : String(err), status: 500 };
}

async function fetchSpendablePaymentUtxos(address: string): Promise<SpendableUtxo[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${MEMPOOL_API_BASE}/address/${encodeURIComponent(address)}/utxo`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new OrdnetError(
        `Could not check payment-address UTXOs (${res.status} from mempool.space).`,
        res.status,
        res.status === 429 || res.status >= 500,
        text.slice(0, 500)
      );
    }
    const raw = text ? JSON.parse(text) : [];
    if (!Array.isArray(raw)) {
      throw new OrdnetError('Payment-address UTXO response was not an array.', null, false);
    }
    return raw
      .map(parseMempoolUtxo)
      .filter((utxo): utxo is SpendableUtxo => utxo != null)
      .toSorted((a, b) => b.valueSats - a.valueSats)
      .slice(0, 1000);
  } catch (err) {
    if (err instanceof OrdnetError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new OrdnetError('Payment-address UTXO lookup timed out.', null, true);
    }
    throw new OrdnetError(err instanceof Error ? err.message : String(err), null, true);
  } finally {
    clearTimeout(timeout);
  }
}

async function getServiceBearerToken(): Promise<string> {
  const cfg = readServiceWalletConfig({ throwOnPartial: true });
  if (!cfg) {
    throw new OrdnetConfigError('ORD.NET service wallet is not configured.');
  }
  const walletKey = `${cfg.ordAddr}:${cfg.payAddr}`;
  if (
    cachedServiceToken &&
    cachedServiceToken.walletKey === walletKey &&
    cachedServiceToken.expiresAtMs - Date.now() > SERVICE_TOKEN_REFRESH_MARGIN_MS
  ) {
    return cachedServiceToken.token;
  }

  const challenge = await createOrdnetAuthChallenge({
    ordinalsAddress: cfg.ordAddr,
    paymentAddress: cfg.payAddr,
  });
  const verifications = challenge.challenges.map(ch => ({
    challengeId: ch.challengeId,
    address: ch.address,
    signature: signServiceChallengeHex(ch, cfg),
  }));
  const verified = await verifyOrdnetAuthChallenge({
    authRequestId: challenge.authRequestId,
    verifications,
  });
  const expiresAtMs = Date.parse(verified.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    throw new OrdnetError('ORD.NET auth response had an invalid expiry.', null, false);
  }
  cachedServiceToken = { token: verified.sessionToken, expiresAtMs, walletKey };
  return verified.sessionToken;
}

function signServiceChallengeHex(challenge: OrdnetAuthChallenge, cfg: ServiceWalletConfig): string {
  const expectedAddress = challenge.role === 'ordinals' ? cfg.ordAddr : cfg.payAddr;
  if (challenge.address !== expectedAddress) {
    throw new OrdnetError(
      'ORD.NET auth challenge address did not match service wallet.',
      null,
      false
    );
  }
  const wif = challenge.role === 'ordinals' ? cfg.ordWif : cfg.payWif;
  const signatureBase64 = Signer.sign(wif, challenge.address, challenge.message);
  return Buffer.from(signatureBase64, 'base64').toString('hex');
}

function readServiceWalletConfig(opts: { throwOnPartial: boolean }): ServiceWalletConfig | null {
  const ordAddr =
    cleanEnv(process.env.ORDNET_SERVICE_ORD_ADDR) ?? cleanEnv(process.env.ORDNET_BACKEND_ORD_ADDR);
  const ordWif =
    cleanEnv(process.env.ORDNET_SERVICE_ORD_WIF) ?? cleanEnv(process.env.ORDNET_BACKEND_ORD_WIF);
  const payAddr =
    cleanEnv(process.env.ORDNET_SERVICE_PAY_ADDR) ?? cleanEnv(process.env.ORDNET_BACKEND_PAY_ADDR);
  const payWif =
    cleanEnv(process.env.ORDNET_SERVICE_PAY_WIF) ?? cleanEnv(process.env.ORDNET_BACKEND_PAY_WIF);

  const values = [ordAddr, ordWif, payAddr, payWif];
  if (values.every(Boolean)) {
    return {
      ordAddr: ordAddr!,
      ordWif: ordWif!,
      payAddr: payAddr!,
      payWif: payWif!,
    };
  }
  if (values.some(Boolean) && opts.throwOnPartial) {
    throw new OrdnetConfigError(
      'ORD.NET service wallet env is incomplete. Set ORDNET_SERVICE_ORD_ADDR, ORDNET_SERVICE_ORD_WIF, ORDNET_SERVICE_PAY_ADDR, and ORDNET_SERVICE_PAY_WIF.'
    );
  }
  return null;
}

function parseAuthChallengeResponse(json: unknown): {
  authRequestId: string;
  challenges: OrdnetAuthChallenge[];
} {
  const obj = objectOrThrow(json, 'ORD.NET auth challenge response was not an object.');
  const authRequestId = stringField(obj, 'authRequestId');
  const rawChallenges = arrayField(obj, 'challenges');
  const challenges: OrdnetAuthChallenge[] = [];
  for (const raw of rawChallenges) {
    const ch = objectOrThrow(raw, 'ORD.NET auth challenge item was not an object.');
    const role = stringField(ch, 'role');
    if (role !== 'ordinals' && role !== 'payment') {
      throw new OrdnetError('ORD.NET auth challenge had an unknown role.', null, false);
    }
    challenges.push({
      challengeId: stringField(ch, 'challengeId'),
      message: stringField(ch, 'message'),
      address: stringField(ch, 'address'),
      role,
    });
  }
  if (challenges.length === 0) {
    throw new OrdnetError('ORD.NET auth challenge response had no challenges.', null, false);
  }
  return { authRequestId, challenges };
}

function parseAuthVerifyResponse(json: unknown): OrdnetVerifiedSession {
  const obj = objectOrThrow(json, 'ORD.NET auth verify response was not an object.');
  const sessionToken = stringField(obj, 'sessionToken');
  const expiresAt = stringField(obj, 'expiresAt');
  const rawBindings = arrayField(obj, 'walletBindings');
  const walletBindings: OrdnetWalletBinding[] = [];
  for (const raw of rawBindings) {
    const b = objectOrThrow(raw, 'ORD.NET wallet binding was not an object.');
    walletBindings.push({
      walletBindingId: stringField(b, 'walletBindingId'),
      label: stringField(b, 'label'),
      provider: stringField(b, 'provider'),
      ordinalsAddress: stringField(b, 'ordinalsAddress'),
      paymentAddress: stringField(b, 'paymentAddress'),
      isPublic: Boolean(b.isPublic),
    });
  }
  return { sessionToken, expiresAt, walletBindings };
}

function parseListingsResponse(json: unknown): FetchOrdnetListingsResult {
  const obj = objectOrThrow(json, 'ORD.NET listings response was not an object.');
  const rawListings = arrayField(obj, 'listings');
  const items: OrdnetListing[] = [];
  for (const raw of rawListings) {
    const norm = normalizeListing(raw);
    if (norm) items.push(norm);
  }

  const pagination =
    obj.pagination && typeof obj.pagination === 'object'
      ? (obj.pagination as Record<string, unknown>)
      : {};
  return {
    items,
    rawCount: rawListings.length,
    hasMore: pagination.hasNext === true,
    nextCursor: typeof pagination.nextCursor === 'string' ? pagination.nextCursor : null,
  };
}

function normalizeListing(raw: unknown): OrdnetListing | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const listing_id = cleanString(obj.listingId);
  const inscription_id = cleanString(obj.inscriptionId);
  const price_sats = cleanPositiveInt(obj.priceSats);
  const listed_at = parseIsoToUnix(cleanString(obj.listedAt));
  if (!listing_id || !inscription_id || price_sats == null || listed_at == null) return null;
  return {
    listing_id,
    inscription_id,
    price_sats,
    seller: cleanString(obj.sellerAddress),
    listed_at,
    marketplace: 'ord.net',
    raw_json: JSON.stringify(raw),
  };
}

function parsePurchasePreflightResponse(raw: unknown): PurchasePreflightResponse {
  const obj = objectOrThrow(raw, 'ORD.NET purchase preflight response was not an object.');
  const steps = arrayField(obj, 'steps').map(parsePsbtStep);
  if (steps.length !== 1) {
    throw new OrdnetError(
      'ORD.NET purchase preflight returned an unexpected PSBT step count.',
      null,
      false
    );
  }
  return {
    purchaseAnchorUtxoId: stringField(obj, 'purchaseAnchorUtxoId'),
    selectedPaymentUtxos: arrayField(obj, 'selectedPaymentUtxos').map(parseSpendableUtxo),
    steps,
    expectedSettlementTxid: stringField(obj, 'expectedSettlementTxid'),
    expectedListingTransferTxids: arrayField(obj, 'expectedListingTransferTxids').map(value => {
      if (typeof value !== 'string') {
        throw new OrdnetError('ORD.NET expected transfer txid was not a string.', null, false);
      }
      return value;
    }),
  };
}

function parseStoredOrdnetPreflight(raw: string | null | undefined): StoredOrdnetPreflight | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredOrdnetPreflight;
    if (!parsed || parsed.v !== 1 || !parsed.request || !parsed.response) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parsePsbtStep(raw: unknown): PsbtStep {
  const obj = objectOrThrow(raw, 'ORD.NET PSBT step was not an object.');
  const inputsToSign = arrayField(obj, 'inputsToSign').map(item => {
    const input = objectOrThrow(item, 'ORD.NET input-to-sign item was not an object.');
    const signingIndexes = arrayField(input, 'signingIndexes').map(value => {
      const n = typeof value === 'number' ? Math.trunc(value) : Number.NaN;
      if (!Number.isFinite(n) || n < 0) {
        throw new OrdnetError('ORD.NET signing index was invalid.', null, false);
      }
      return n;
    });
    return {
      address: stringField(input, 'address'),
      signingIndexes,
      publicKey: cleanString(input.publicKey) ?? undefined,
      disableTweakSigner:
        typeof input.disableTweakSigner === 'boolean' ? input.disableTweakSigner : undefined,
      sigHash: typeof input.sigHash === 'number' ? Math.trunc(input.sigHash) : undefined,
    };
  });
  return {
    stepIndex: numberField(obj, 'stepIndex'),
    signerAddress: stringField(obj, 'signerAddress'),
    inputsToSign,
    psbtBase64: stringField(obj, 'psbtBase64'),
  };
}

function parseSpendableUtxo(raw: unknown): SpendableUtxo {
  const obj = objectOrThrow(raw, 'ORD.NET spendable UTXO was not an object.');
  return {
    txid: stringField(obj, 'txid'),
    vout: numberField(obj, 'vout'),
    valueSats: numberField(obj, 'valueSats'),
  };
}

function psbtStepToSignInputs(step: PsbtStep): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const input of step.inputsToSign) {
    out[input.address] = [...(out[input.address] ?? []), ...input.signingIndexes];
  }
  return out;
}

function parseSubmitTxid(raw: unknown): string {
  const obj = objectOrThrow(raw, 'ORD.NET purchase submit response was not an object.');
  return stringField(obj, 'settlementTxid');
}

async function getJson(url: string, bearerToken: string): Promise<unknown> {
  return requestJson(url, { method: 'GET', bearerToken });
}

async function postJson(path: string, body: unknown, bearerToken?: string): Promise<unknown> {
  return requestJson(`${ORDNET_API_BASE}${path}`, { method: 'POST', body, bearerToken });
}

async function requestJson(
  url: string,
  args: { method: 'GET' | 'POST'; body?: unknown; bearerToken?: string }
): Promise<unknown> {
  let lastError: OrdnetError | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await requestJsonOnce(url, args);
    } catch (err) {
      if (!(err instanceof OrdnetError) || !err.retryable) throw err;
      lastError = err;
      const retryAfterMs = extractRetryAfterMs(err);
      const baseMs = retryAfterMs ?? 1000 * 2 ** attempt;
      const jitter = baseMs * (0.75 + Math.random() * 0.5);
      await sleep(Math.min(jitter, 30_000));
    }
  }
  throw lastError ?? new OrdnetError('ORD.NET request exhausted retries.', null, false);
}

async function requestJsonOnce(
  url: string,
  args: { method: 'GET' | 'POST'; body?: unknown; bearerToken?: string }
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: args.method,
      headers: {
        Accept: 'application/json',
        ...(args.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        ...(args.bearerToken ? { Authorization: `Bearer ${args.bearerToken}` } : {}),
      },
      body: args.method === 'POST' ? JSON.stringify(args.body ?? {}) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new OrdnetError(
        ordnetHttpErrorMessage(res.status, text),
        res.status,
        retryable,
        text.slice(0, 500)
      );
    }
    return text ? JSON.parse(text) : null;
  } catch (err) {
    if (err instanceof OrdnetError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new OrdnetError('ORD.NET request timed out.', null, true);
    }
    throw new OrdnetError(err instanceof Error ? err.message : String(err), null, true);
  } finally {
    clearTimeout(timeout);
  }
}

function extractRetryAfterMs(err: OrdnetError): number | null {
  if (!err.bodyExcerpt) return null;
  const match = /retry-after:\s*(\d+)/i.exec(err.bodyExcerpt);
  if (!match) return null;
  return Math.max(0, Number(match[1]) * 1000);
}

function objectOrThrow(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OrdnetError(message, null, false);
  }
  return value as Record<string, unknown>;
}

function arrayField(obj: Record<string, unknown>, key: string): unknown[] {
  const value = obj[key];
  if (!Array.isArray(value)) {
    throw new OrdnetError(`ORD.NET response field ${key} was not an array.`, null, false);
  }
  return value;
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const value = cleanString(obj[key]);
  if (!value) {
    throw new OrdnetError(`ORD.NET response field ${key} was not a string.`, null, false);
  }
  return value;
}

function numberField(obj: Record<string, unknown>, key: string): number {
  const value = typeof obj[key] === 'number' ? Math.trunc(obj[key] as number) : Number.NaN;
  if (!Number.isFinite(value)) {
    throw new OrdnetError(`ORD.NET response field ${key} was not a number.`, null, false);
  }
  return value;
}

function parseIsoToUnix(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.floor(ms / 1000);
}

function cleanPositiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? Math.trunc(value) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseMempoolUtxo(raw: unknown): SpendableUtxo | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const txid = cleanString(obj.txid);
  const vout = typeof obj.vout === 'number' ? Math.trunc(obj.vout) : Number.NaN;
  const valueSats = typeof obj.value === 'number' ? Math.trunc(obj.value) : Number.NaN;
  if (
    !txid ||
    !Number.isFinite(vout) ||
    vout < 0 ||
    !Number.isFinite(valueSats) ||
    valueSats <= 0
  ) {
    return null;
  }
  return { txid, vout, valueSats };
}

function ordnetHttpErrorMessage(status: number, body: string): string {
  const detail = responseErrorDetail(body);
  const base = `ORD.NET request failed with HTTP ${status}`;
  if (detail) return `${base}: ${detail}`;
  if (status === 403) {
    return `${base}: wallet is not allowed to perform this action. Confirm the connected payment address has at least 0.01 BTC confirmed and enough spendable BTC for the purchase.`;
  }
  return base;
}

function responseErrorDetail(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const value = cleanString(obj.error) ?? cleanString(obj.message) ?? cleanString(obj.detail);
      if (value) return truncateErrorDetail(value);
    }
  } catch {
    // fall through to plain-text body handling
  }
  return truncateErrorDetail(trimmed.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));
}

function truncateErrorDetail(value: string): string {
  return value.length > 220 ? `${value.slice(0, 217)}...` : value;
}

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function cleanEnv(value: string | undefined): string | null {
  return value && value.trim().length > 0 ? value.trim() : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
