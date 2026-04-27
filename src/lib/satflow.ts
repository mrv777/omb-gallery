import 'server-only';

const SATFLOW_BASE = (process.env.SATFLOW_BASE_URL ?? 'https://api.satflow.com').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 5;

export type NormalizedSale = {
  inscription_id: string;
  inscription_number: number;
  txid: string;
  sale_price_sats: number;
  block_timestamp: number;
  block_height: number | null;
  marketplace: 'satflow';
  seller: string | null;
  buyer: string | null;
  raw_json: string;
};

export type FetchSalesArgs = {
  collectionId: string;
  /** Pull sales newer than this unix timestamp. Used for incremental polls. */
  since?: number | null;
  /** Opaque cursor from previous response (preferred over `since` when present). */
  cursor?: string | null;
  count?: number;
  apiKey?: string | null;
};

export type FetchSalesResult = {
  items: NormalizedSale[];
  rawCount: number;
  /** Next cursor if the API exposes one; null when drained. */
  nextCursor: string | null;
  /**
   * Oldest block_timestamp in this page, used as a fallback "since" cursor when
   * the API doesn't expose opaque cursors.
   */
  oldestTimestamp: number | null;
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

// ---------------- public API ----------------

export async function fetchSalesPage(args: FetchSalesArgs): Promise<FetchSalesResult> {
  const url = new URL(`${SATFLOW_BASE}/rest/activity/sales`);
  url.searchParams.set('collectionId', args.collectionId);
  url.searchParams.set('count', String(args.count ?? 100));
  // Sort newest-first. Cursor pagination walks backwards through history.
  url.searchParams.set('sort', 'desc');
  if (args.cursor) url.searchParams.set('cursor', args.cursor);
  if (args.since != null) url.searchParams.set('since', String(args.since));

  const json = await getWithRetry(url.toString(), args.apiKey);
  const raw = extractList(json);
  const items: NormalizedSale[] = [];
  let oldestTimestamp: number | null = null;
  for (const it of raw) {
    const norm = normalizeSale(it);
    if (!norm) continue;
    items.push(norm);
    if (oldestTimestamp == null || norm.block_timestamp < oldestTimestamp) {
      oldestTimestamp = norm.block_timestamp;
    }
  }
  const nextCursor = pickCursor(json);
  return { items, rawCount: raw.length, nextCursor, oldestTimestamp };
}

// ---------------- normalization ----------------

function extractList(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) {
    return json.filter((x) => x && typeof x === 'object') as Record<string, unknown>[];
  }
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    const candidate =
      obj.data ?? obj.items ?? obj.results ?? obj.sales ?? obj.activity;
    if (Array.isArray(candidate)) {
      return candidate.filter((x) => x && typeof x === 'object') as Record<string, unknown>[];
    }
  }
  return [];
}

function pickCursor(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  const candidate =
    obj.next_cursor ?? obj.nextCursor ?? obj.cursor ?? obj.next ?? obj.next_page;
  if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  // Some APIs nest cursor under a `pagination` object.
  const pagination = obj.pagination;
  if (pagination && typeof pagination === 'object') {
    const p = pagination as Record<string, unknown>;
    const nested = p.next_cursor ?? p.nextCursor ?? p.cursor;
    if (typeof nested === 'string' && nested.length > 0) return nested;
  }
  return null;
}

function normalizeSale(item: Record<string, unknown>): NormalizedSale | null {
  // Note: 'id' is intentionally omitted — many APIs use 'id' for the row's own
  // primary key (sale id), not the inscription id. Only add it if a future
  // Satflow response is known to use 'id' specifically for the inscription.
  const inscription_id = pickString(item, [
    'inscription_id',
    'inscriptionId',
    'item_id',
    'itemId',
  ]);
  const inscription_number = pickInt(item, [
    'inscription_number',
    'inscriptionNumber',
    'number',
    'inscription_no',
  ]);
  if (!inscription_id || inscription_number == null) return null;

  const txid = pickString(item, ['txid', 'tx_id', 'transaction_id', 'tx_hash']);
  if (!txid) return null;

  const sale_price_sats = pickInt(item, [
    'sale_price_sats',
    'price_sats',
    'price_in_sats',
    'amount_sats',
    'price',
    'amount',
    'sats',
  ]);
  if (sale_price_sats == null) return null;

  const block_timestamp = pickInt(item, [
    'block_timestamp',
    'timestamp',
    'ts',
    'block_time',
    'sold_at',
    'created_at',
  ]);
  if (block_timestamp == null) return null;

  return {
    inscription_id,
    inscription_number,
    txid,
    sale_price_sats,
    block_timestamp,
    block_height: pickInt(item, ['block_height', 'height']),
    marketplace: 'satflow',
    seller: pickString(item, ['seller', 'seller_address', 'from']),
    buyer: pickString(item, ['buyer', 'buyer_address', 'to']),
    raw_json: JSON.stringify(item),
  };
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) {
      // Satflow's auth scheme is TBD at deploy time. Send the key under both
      // common header names so we don't need a code change to swap.
      headers['x-api-key'] = apiKey;
      headers['Authorization'] = `Bearer ${apiKey}`;
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
