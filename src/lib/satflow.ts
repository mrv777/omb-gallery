import 'server-only';

const SATFLOW_BASE = (process.env.SATFLOW_BASE_URL ?? 'https://api.satflow.com').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 5;

// Satflow plan is 5 req/s with a 10-burst tolerance. We pace at 4/s sustained
// using a minimum-spacing token bucket: every call must be at least
// MIN_INTERVAL_MS after the previous one's reserved slot. This is stricter
// than a sliding-window cap (which permits microbursts when many awakeners
// resolve on the same JS tick) and keeps us comfortably under the limit even
// across retries and concurrent modes.
const RATE_LIMIT_RPS = 4;
const MIN_INTERVAL_MS = 1000 / RATE_LIMIT_RPS;
let nextSlotAt = 0;

/** Optional hook the caller can install to track API usage in persistent
 * storage. Called once per HTTP request that actually reaches Satflow
 * (NOT counted: in-memory rate-limit waits, retries that immediately fail). */
export type CallCounter = () => void;
let callCounter: CallCounter | null = null;
export function setCallCounter(fn: CallCounter | null): void {
  callCounter = fn;
}

/**
 * A normalized Satflow sale, ready for the poller to consume. Note that
 * `inscription_number` is intentionally NOT part of this shape: Satflow's
 * response carries only `inscriptionId`, so the poller resolves the number
 * via our own DB (rows seeded from images.json + bootstrapped via ord). That
 * keeps this client free of DB coupling.
 */
export type NormalizedSale = {
  /** Satflow's own sale id (e.g. `"69ef6857b99f8f4eaa484605"`). Useful for logs. */
  satflow_id: string;
  inscription_id: string;
  /** On-chain tx that completed the sale (Satflow's `fillTx`). Always present. */
  txid: string;
  sale_price_sats: number;
  /** Unix seconds, parsed from `fillCompletedAt` (preferred) or `timestamp`. */
  block_timestamp: number;
  /** Satflow doesn't ship block height — always null. */
  block_height: null;
  marketplace: 'satflow';
  seller: string | null;
  buyer: string | null;
  raw_json: string;
};

export type FetchSalesArgs = {
  collectionSlug: string;
  page?: number;
  pageSize?: number;
  /** 'desc' (newest-first, default) or 'asc' (oldest-first, used for backfill). */
  sortDirection?: 'asc' | 'desc';
  apiKey?: string | null;
};

export type FetchSalesResult = {
  items: NormalizedSale[];
  /**
   * Number of items returned by the API on this page (before normalization
   * filtered any out). Used by the poller to decide whether more pages exist.
   */
  rawCount: number;
  page: number;
  pageSize: number;
  /** Total sales in the collection across all pages, per the API. */
  total: number;
  /**
   * True if `rawCount === pageSize` — i.e. there's likely another page. We
   * can't compute this from `total` reliably because total drifts as new
   * sales arrive between page fetches.
   */
  hasMore: boolean;
};

export class SatflowError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly bodyExcerpt?: string
  ) {
    super(message);
    this.name = 'SatflowError';
  }
}

/** Active listing snapshot, normalized. Like NormalizedSale, no inscription_number. */
export type NormalizedListing = {
  satflow_id: string;
  inscription_id: string;
  price_sats: number;
  seller: string | null;
  /** Unix seconds when this listing was created on Satflow (`createdAt`). */
  listed_at: number;
  raw_json: string;
};

export type FetchListingsArgs = {
  collectionSlug: string;
  page?: number;
  pageSize?: number;
  apiKey?: string | null;
};

export type FetchListingsResult = {
  items: NormalizedListing[];
  rawCount: number;
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
};

// ---------------- public API ----------------

export async function fetchSalesPage(args: FetchSalesArgs): Promise<FetchSalesResult> {
  const page = args.page ?? 1;
  const pageSize = args.pageSize ?? 100;
  const sortDirection = args.sortDirection ?? 'desc';

  const url = new URL(`${SATFLOW_BASE}/v1/activity/sales`);
  url.searchParams.set('collectionSlug', args.collectionSlug);
  url.searchParams.set('page', String(page));
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('sortBy', 'fillCompletedAt');
  url.searchParams.set('sortDirection', sortDirection);

  const json = await getWithRetry(url.toString(), args.apiKey);
  const raw = extractSales(json);
  const total = extractTotal(json);
  const items: NormalizedSale[] = [];
  for (const it of raw) {
    const norm = normalizeSale(it);
    if (norm) items.push(norm);
  }
  return {
    items,
    rawCount: raw.length,
    page,
    pageSize,
    total,
    hasMore: raw.length >= pageSize,
  };
}

export async function fetchListingsPage(args: FetchListingsArgs): Promise<FetchListingsResult> {
  const page = args.page ?? 1;
  const pageSize = args.pageSize ?? 100;

  // active=true (default) = currently-listed only. We don't care about
  // cancelled or filled history (sales table covers fills).
  const url = new URL(`${SATFLOW_BASE}/v1/activity/listings`);
  url.searchParams.set('collectionSlug', args.collectionSlug);
  url.searchParams.set('page', String(page));
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('sortBy', 'createdAt');
  url.searchParams.set('sortDirection', 'desc');

  const json = await getWithRetry(url.toString(), args.apiKey);
  const raw = extractListings(json);
  const total = extractTotal(json);
  const items: NormalizedListing[] = [];
  for (const it of raw) {
    const norm = normalizeListing(it);
    if (norm) items.push(norm);
  }
  return {
    items,
    rawCount: raw.length,
    page,
    pageSize,
    total,
    hasMore: raw.length >= pageSize,
  };
}

// ---------------- normalization ----------------

function extractSales(json: unknown): Record<string, unknown>[] {
  if (!json || typeof json !== 'object') return [];
  const obj = json as Record<string, unknown>;
  const data = obj.data;
  if (!data || typeof data !== 'object') return [];
  const sales = (data as Record<string, unknown>).sales;
  if (!Array.isArray(sales)) return [];
  return sales.filter((x) => x && typeof x === 'object') as Record<string, unknown>[];
}

function extractTotal(json: unknown): number {
  if (!json || typeof json !== 'object') return 0;
  const obj = json as Record<string, unknown>;
  const data = obj.data;
  if (!data || typeof data !== 'object') return 0;
  const total = (data as Record<string, unknown>).total;
  if (typeof total === 'number' && Number.isFinite(total)) return Math.trunc(total);
  return 0;
}

/**
 * Pull the order body — Satflow puts it under `ask` (orderType=ask) or
 * `bid` (orderType=bid), never both. Returns null if neither is present
 * (defensive — shouldn't happen for `type: "sale"` rows).
 */
function pickOrder(item: Record<string, unknown>): {
  body: Record<string, unknown>;
  kind: 'ask' | 'bid';
} | null {
  const ask = item.ask;
  if (ask && typeof ask === 'object') return { body: ask as Record<string, unknown>, kind: 'ask' };
  const bid = item.bid;
  if (bid && typeof bid === 'object') return { body: bid as Record<string, unknown>, kind: 'bid' };
  return null;
}

function normalizeSale(item: Record<string, unknown>): NormalizedSale | null {
  const order = pickOrder(item);
  if (!order) return null;

  const inscription_id = pickString(order.body, ['inscriptionId', 'inscription_id']);
  if (!inscription_id) return null;

  const txid = pickString(item, ['fillTx']);
  if (!txid) return null;
  // Sanity-check shape: 64 hex chars. ord events are stored normalized to
  // lowercase, so do the same here so dedup via UNIQUE(inscription_id, txid)
  // matches across sources.
  if (!/^[0-9a-f]{64}$/i.test(txid)) return null;

  // `price` lives both top-level and on the order body; prefer top-level since
  // it reflects the executed price (order.body.price could be the original ask
  // for partial-fill cases). Per Satflow docs, integer satoshis.
  const sale_price_sats = pickInt(item, ['price']) ?? pickInt(order.body, ['price']);
  if (sale_price_sats == null || sale_price_sats <= 0) return null;

  // Prefer fillCompletedAt (when the sale settled on chain). Fall back to
  // timestamp (when the order was filled in Satflow's view) if missing.
  const block_timestamp =
    parseIsoToUnix(pickString(item, ['fillCompletedAt'])) ??
    parseIsoToUnix(pickString(item, ['timestamp', 'updatedAt']));
  if (block_timestamp == null) return null;

  // Seller is the maker on an ask, the bid-acceptor on a bid; both surface
  // their ord (taproot) address as `sellerOrdAddress` on the order body.
  const seller = pickString(order.body, ['sellerOrdAddress', 'sellerReceiveAddress']);

  // Buyer differs by order kind:
  //   - ask order: the taker is the buyer; their address is on the top-level fill fields.
  //   - bid order: the bidder is the buyer; their receive address is on the bid body.
  const buyer =
    order.kind === 'ask'
      ? pickString(item, ['fillOrdAddress', 'fillAddress'])
      : pickString(order.body, ['bidderTokenReceiveAddress', 'bidderAddress']);

  const satflow_id = pickString(item, ['id']) ?? '';

  return {
    satflow_id,
    inscription_id,
    txid: txid.toLowerCase(),
    sale_price_sats,
    block_timestamp,
    block_height: null,
    marketplace: 'satflow',
    seller,
    buyer,
    raw_json: JSON.stringify(item),
  };
}

function extractListings(json: unknown): Record<string, unknown>[] {
  if (!json || typeof json !== 'object') return [];
  const obj = json as Record<string, unknown>;
  const data = obj.data;
  if (!data || typeof data !== 'object') return [];
  const listings = (data as Record<string, unknown>).listings;
  if (!Array.isArray(listings)) return [];
  return listings.filter((x) => x && typeof x === 'object') as Record<string, unknown>[];
}

function normalizeListing(item: Record<string, unknown>): NormalizedListing | null {
  // Defensive: skip listings that already terminated (cancelled / filled /
  // invalid) even though we asked for active. Keeps the snapshot clean if
  // Satflow's `active=true` filter is ever loosened.
  if (
    item.cancelledAt != null ||
    item.fillCompletedAt != null ||
    item.fillPendingAt != null ||
    item.invalidAt != null
  ) {
    return null;
  }

  const order = pickOrder(item);
  if (!order || order.kind !== 'ask') return null; // only ask-orders are listings

  const inscription_id = pickString(order.body, ['inscriptionId', 'inscription_id']);
  if (!inscription_id) return null;

  const price_sats = pickInt(item, ['price']) ?? pickInt(order.body, ['price']);
  if (price_sats == null || price_sats <= 0) return null;

  const listed_at =
    parseIsoToUnix(pickString(item, ['createdAt', 'timestamp'])) ??
    parseIsoToUnix(pickString(item, ['updatedAt']));
  if (listed_at == null) return null;

  const seller = pickString(order.body, ['sellerOrdAddress', 'sellerReceiveAddress']);
  const satflow_id = pickString(item, ['id']) ?? '';

  return {
    satflow_id,
    inscription_id,
    price_sats,
    seller,
    listed_at,
    raw_json: JSON.stringify(item),
  };
}

function parseIsoToUnix(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  // Guard against the `1970-01-01T00:00:00.000Z` placeholders Satflow
  // sometimes ships in unrelated fields — don't let one of those leak in
  // as a "block_timestamp".
  if (ms <= 0) return null;
  return Math.floor(ms / 1000);
}

// ---------------- HTTP + retry ----------------

async function getWithRetry(url: string, apiKey?: string | null): Promise<unknown> {
  let lastError: SatflowError | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await getOnce(url, apiKey);
    } catch (err) {
      if (!(err instanceof SatflowError) || !err.retryable) throw err;
      lastError = err;
      const baseMs =
        err.status === 429 ? extractRetryAfterMs(err) ?? 60_000 : 1000 * 2 ** attempt;
      const jitter = baseMs * (0.75 + Math.random() * 0.5);
      await sleep(Math.min(jitter, 60_000));
    }
  }
  throw lastError ?? new SatflowError('Exhausted retries with no error captured', null, false);
}

async function getOnce(url: string, apiKey?: string | null): Promise<unknown> {
  await waitForRateLimit();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;
    if (callCounter) {
      try {
        callCounter();
      } catch {
        // Counter failures must never break the actual API call.
      }
    }
    const res = await fetch(url, { headers, signal: controller.signal });

    if (res.status === 429) {
      const body = await safeText(res);
      throw new SatflowError(`429 rate limited`, 429, true, withRetryAfterTag(res, body));
    }
    if (res.status >= 500) {
      const body = await safeText(res);
      throw new SatflowError(`${res.status} from satflow`, res.status, true, body);
    }
    if (!res.ok) {
      const body = await safeText(res);
      throw new SatflowError(`${res.status} from satflow`, res.status, false, body);
    }
    try {
      return await res.json();
    } catch {
      const body = await safeText(res);
      throw new SatflowError('Malformed JSON in satflow response', res.status, false, body);
    }
  } catch (err) {
    if (err instanceof SatflowError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new SatflowError(`Network error: ${msg}`, null, true);
  } finally {
    clearTimeout(timer);
  }
}

function extractRetryAfterMs(err: SatflowError): number | null {
  if (!err.bodyExcerpt) return null;
  const m = /__retry_after__:(\d+)/.exec(err.bodyExcerpt);
  if (!m) return null;
  return parseInt(m[1], 10) * 1000;
}

function withRetryAfterTag(res: Response, body: string): string {
  const ra = res.headers.get('retry-after');
  if (!ra) return body;
  const seconds = /^\d+$/.test(ra) ? parseInt(ra, 10) : 60;
  return `__retry_after__:${seconds}\n${body}`;
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 4096);
  } catch {
    return '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Token-bucket-style limiter. Each caller atomically reserves the next
 * available slot (at least MIN_INTERVAL_MS after the previously-reserved
 * slot), then sleeps until that slot. The reservation is non-yielding so
 * concurrent callers receive distinct, monotonically-increasing slots and
 * never collide into a microburst — even if many resolve on the same JS tick.
 *
 * Sporadic callers don't pay: if the next slot is already in the past, the
 * sleep is zero.
 */
async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextSlotAt);
  nextSlotAt = slot + MIN_INTERVAL_MS;
  const wait = slot - now;
  if (wait > 0) await sleep(wait);
}

/** Test-only escape hatch to clear the rate limiter between unit tests. */
export function _resetRateLimitForTest(): void {
  nextSlotAt = 0;
}

// ---------------- field helpers ----------------

function pickString(item: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = item[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function pickInt(item: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = item[k];
    if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
    if (typeof v === 'string') {
      const n = Number(v);
      if (Number.isFinite(n)) return Math.trunc(n);
    }
  }
  return null;
}
