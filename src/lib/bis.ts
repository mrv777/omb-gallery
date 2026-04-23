import 'server-only';

const BIS_BASE = 'https://api.bestinslot.xyz/v3';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 5;

export type BisRawItem = Record<string, unknown>;

export type NormalizedEvent = {
  inscription_id: string;
  inscription_number: number;
  event_type: 'inscribed' | 'transferred' | 'sold';
  block_height: number | null;
  block_timestamp: number;
  new_satpoint: string;
  old_owner: string | null;
  new_owner: string | null;
  marketplace: string | null;
  sale_price_sats: number | null;
  txid: string;
  raw_json: string;
};

export type NormalizedHolder = {
  wallet_addr: string;
  inscription_count: number;
};

export type FetchActivityArgs = {
  slug: string;
  cursor: string | null;
  count?: number; // default 100, max 100
  apiKey?: string;
};

export type FetchHoldersArgs = {
  slug: string;
  offset: number;
  count?: number;
  apiKey?: string;
};

export class BisError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly bodyExcerpt?: string
  ) {
    super(message);
    this.name = 'BisError';
  }
}

export async function fetchActivityPage(args: FetchActivityArgs): Promise<{
  items: NormalizedEvent[];
  rawCount: number;
}> {
  const url = new URL(`${BIS_BASE}/collection/activity`);
  url.searchParams.set('slug', args.slug);
  url.searchParams.set('activity_filter', '7'); // inscribed | transferred | sold
  url.searchParams.set('sort_by', 'ts');
  url.searchParams.set('order', 'asc');
  url.searchParams.set('offset', '0');
  url.searchParams.set('count', String(args.count ?? 100));
  if (args.cursor) url.searchParams.set('last_new_satpoint', args.cursor);

  const json = await getWithRetry(url.toString(), args.apiKey);
  const raw = extractList(json);
  const items: NormalizedEvent[] = [];
  for (const it of raw) {
    const norm = normalizeEvent(it);
    if (norm) items.push(norm);
  }
  return { items, rawCount: raw.length };
}

export async function fetchHoldersPage(args: FetchHoldersArgs): Promise<{
  items: NormalizedHolder[];
  rawCount: number;
}> {
  const url = new URL(`${BIS_BASE}/collection/holders`);
  url.searchParams.set('slug', args.slug);
  url.searchParams.set('sort_by', 'wallet_addr');
  url.searchParams.set('order', 'asc');
  url.searchParams.set('offset', String(args.offset));
  url.searchParams.set('count', String(args.count ?? 100));

  const json = await getWithRetry(url.toString(), args.apiKey);
  const raw = extractList(json);
  const items: NormalizedHolder[] = [];
  for (const it of raw) {
    const wallet = pickString(it, ['wallet_addr', 'wallet', 'address', 'owner_wallet']);
    const count = pickInt(it, ['inscription_count', 'count', 'total', 'inscriptions']);
    if (!wallet || count == null) continue;
    items.push({ wallet_addr: wallet, inscription_count: count });
  }
  return { items, rawCount: raw.length };
}

// ---------------- HTTP + retry ----------------

async function getWithRetry(url: string, apiKey?: string): Promise<unknown> {
  let lastError: BisError | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await getOnce(url, apiKey);
    } catch (err) {
      if (!(err instanceof BisError) || !err.retryable) throw err;
      lastError = err;
      const baseMs = err.status === 429 ? extractRetryAfterMs(err) ?? 60_000 : 1000 * 2 ** attempt;
      const jitter = baseMs * (0.75 + Math.random() * 0.5);
      const sleepMs = Math.min(jitter, 60_000);
      await sleep(sleepMs);
    }
  }
  throw lastError ?? new BisError('Exhausted retries with no error captured', null, false);
}

async function getOnce(url: string, apiKey?: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;
    const res = await fetch(url, { headers, signal: controller.signal });

    if (res.status === 429) {
      const body = await safeText(res);
      throw new BisError(`429 rate limited`, 429, true, withRetryAfterTag(res, body));
    }
    if (res.status >= 500) {
      const body = await safeText(res);
      throw new BisError(`${res.status} from BiS`, res.status, true, body);
    }
    if (!res.ok) {
      const body = await safeText(res);
      // 4xx other than 429 — non-retryable
      throw new BisError(`${res.status} from BiS`, res.status, false, body);
    }
    try {
      return await res.json();
    } catch {
      const body = await safeText(res);
      throw new BisError('Malformed JSON in BiS response', res.status, false, body);
    }
  } catch (err) {
    if (err instanceof BisError) throw err;
    // AbortError or other network/DNS/TLS — retryable
    const msg = err instanceof Error ? err.message : String(err);
    throw new BisError(`Network error: ${msg}`, null, true);
  } finally {
    clearTimeout(timer);
  }
}

function extractRetryAfterMs(err: BisError): number | null {
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

// ---------------- response normalization ----------------

function extractList(json: unknown): BisRawItem[] {
  if (!json || typeof json !== 'object') return [];
  const obj = json as Record<string, unknown>;
  const candidate = obj.data ?? obj.items ?? obj.results ?? obj.activity ?? obj.holders;
  if (Array.isArray(candidate)) return candidate.filter((x) => x && typeof x === 'object') as BisRawItem[];
  if (Array.isArray(json)) return json.filter((x) => x && typeof x === 'object') as BisRawItem[];
  return [];
}

function normalizeEvent(item: BisRawItem): NormalizedEvent | null {
  const new_satpoint = pickString(item, ['new_satpoint', 'satpoint']);
  const inscription_number = pickInt(item, [
    'inscription_number',
    'inscription_no',
    'number',
    'inscription_num',
  ]);
  if (!new_satpoint || inscription_number == null) return null;

  const inscription_id =
    pickString(item, ['inscription_id', 'id']) ?? `unknown-${inscription_number}`;
  const event_type = mapEventType(item);
  if (!event_type) return null;

  const block_timestamp = pickInt(item, ['block_timestamp', 'timestamp', 'ts', 'block_time']);
  if (block_timestamp == null) return null;

  const block_height = pickInt(item, ['block_height', 'height']);
  const old_owner = pickString(item, ['old_owner_wallet', 'from_wallet', 'old_wallet', 'from']);
  const new_owner = pickString(item, ['new_owner_wallet', 'to_wallet', 'new_wallet', 'to', 'wallet']);
  const marketplace = pickString(item, [
    'marketplace_name',
    'marketplace',
    'market',
    'platform',
    'source',
  ]);
  const sale_price_sats = pickInt(item, [
    'sale_price_sats',
    'sale_price_in_sats',
    'price_in_sats',
    'price_sats',
    'sold_price_in_sats',
    'amount_sats',
  ]);
  const txid =
    pickString(item, ['txid', 'tx_id', 'transaction_id']) ??
    new_satpoint.split(':')[0] ??
    'unknown';

  return {
    inscription_id,
    inscription_number,
    event_type,
    block_height,
    block_timestamp,
    new_satpoint,
    old_owner,
    new_owner,
    marketplace: event_type === 'sold' ? marketplace : null,
    sale_price_sats: event_type === 'sold' ? sale_price_sats : null,
    txid,
    raw_json: JSON.stringify(item),
  };
}

function mapEventType(item: BisRawItem): NormalizedEvent['event_type'] | null {
  // Try string-typed fields first
  const s = pickString(item, ['event_type', 'activity_type', 'type', 'kind']);
  if (s) {
    const lower = s.toLowerCase();
    if (lower.includes('inscrib') || lower === 'mint') return 'inscribed';
    if (lower.includes('sale') || lower.includes('sold') || lower === 'buy') return 'sold';
    if (lower.includes('transfer') || lower === 'send') return 'transferred';
  }
  // Numeric activity-filter mapping (BiS uses 1/2/4 in some payloads)
  const n = pickInt(item, ['activity_filter', 'filter', 'event_code']);
  if (n === 1) return 'inscribed';
  if (n === 2) return 'transferred';
  if (n === 4) return 'sold';
  // Fallback: if it has a sale price, treat as sold; if old_owner exists, transferred; else inscribed
  if (pickInt(item, ['sale_price_sats', 'sale_price_in_sats', 'price_in_sats']) != null) return 'sold';
  if (pickString(item, ['old_owner_wallet', 'from_wallet', 'old_wallet', 'from'])) return 'transferred';
  return 'inscribed';
}

function pickString(item: BisRawItem, keys: string[]): string | null {
  for (const k of keys) {
    const v = item[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function pickInt(item: BisRawItem, keys: string[]): number | null {
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
