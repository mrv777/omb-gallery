import 'server-only';

const ORD_BASE = (process.env.ORD_BASE_URL ?? '').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 3;

export type OrdInscriptionState = {
  inscription_number: number;
  inscription_id: string;
  output: string | null;
  address: string | null;
};

export type OrdInscriptionDetail = {
  inscription_number: number;
  inscription_id: string;
  output: string | null;
  address: string | null;
  block_height: number | null;
  block_timestamp: number | null;
  satpoint: string | null;
};

export class OrdError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly bodyExcerpt?: string
  ) {
    super(message);
    this.name = 'OrdError';
  }
}

function ensureBase(): string {
  if (!ORD_BASE) {
    throw new OrdError('ORD_BASE_URL not configured', null, false);
  }
  return ORD_BASE;
}

// ---------------- public API ----------------

export async function fetchBlockHeight(): Promise<number> {
  const json = await getJson(`${ensureBase()}/blockheight`);
  if (typeof json === 'number') return json;
  if (typeof json === 'string' && /^\d+$/.test(json)) return parseInt(json, 10);
  throw new OrdError('Unexpected /blockheight response shape', null, false);
}

/**
 * Fetch current state for a single inscription, addressable by either ID or number.
 * Used to bootstrap inscription_id for entries seeded only by number from images.json.
 */
export async function fetchInscriptionDetail(
  numberOrId: number | string
): Promise<OrdInscriptionDetail> {
  const json = (await getJson(`${ensureBase()}/inscription/${numberOrId}`)) as Record<
    string,
    unknown
  >;
  return normalizeInscriptionDetail(json);
}

/**
 * Batch-fetch state for many inscriptions in one call. ord exposes
 * `POST /inscriptions` for this; body is a JSON array of inscription IDs.
 *
 * Returns one entry per requested ID. If an ID is missing from the response,
 * we omit it from the result (caller should treat as "no change this tick").
 */
export async function fetchInscriptionsBatch(
  ids: string[]
): Promise<OrdInscriptionState[]> {
  if (ids.length === 0) return [];
  const json = (await postJson(`${ensureBase()}/inscriptions`, ids)) as unknown;
  const list = extractList(json);
  const out: OrdInscriptionState[] = [];
  for (const item of list) {
    const norm = normalizeInscriptionState(item);
    if (norm) out.push(norm);
  }
  return out;
}

/**
 * `GET /output/<txid>:<vout>` — used to recover the on-chain block height
 * for a transfer satpoint. ord doesn't expose the transfer's own block info
 * directly (the inscription endpoint only ships *genesis* height/timestamp),
 * so we derive it from `confirmations` against the chain tip.
 *
 * Returns confirmations of the tx that *created* this output. For a mempool
 * tx, ord returns 0 (and we fall back to the poller's now-time at the call
 * site). Returns 404 if ord doesn't know the output.
 */
export async function fetchOutputConfirmations(satpoint: string): Promise<number | null> {
  const json = (await getJson(`${ensureBase()}/output/${satpoint}`)) as Record<string, unknown>;
  return pickInt(json, ['confirmations']);
}

/**
 * `GET /r/blockinfo/<height>` — small JSON (~700 bytes) with `timestamp`,
 * `hash`, `height`, etc. Avoids `/block/<height>` which ships every tx in
 * the block (megabytes for a full-fee block).
 */
export async function fetchBlockTimestamp(height: number): Promise<number | null> {
  if (height < 1) return null;
  const json = (await getJson(`${ensureBase()}/r/blockinfo/${height}`)) as Record<string, unknown>;
  return pickInt(json, ['timestamp']);
}

// ---------------- normalization ----------------

function extractList(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) {
    return json.filter((x) => x && typeof x === 'object') as Record<string, unknown>[];
  }
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    // Some ord versions wrap responses (e.g. {inscriptions: [...]}, {data: [...]})
    const candidate = obj.inscriptions ?? obj.data ?? obj.items ?? obj.results;
    if (Array.isArray(candidate)) {
      return candidate.filter((x) => x && typeof x === 'object') as Record<string, unknown>[];
    }
  }
  return [];
}

function normalizeInscriptionState(item: Record<string, unknown>): OrdInscriptionState | null {
  const inscription_id = pickString(item, ['id', 'inscription_id']);
  const inscription_number = pickInt(item, ['number', 'inscription_number']);
  if (!inscription_id || inscription_number == null) return null;
  const output = pickString(item, ['satpoint', 'output', 'location']);
  const normalized_output = output ? outputFromSatpoint(output) : null;
  return {
    inscription_id,
    inscription_number,
    output: normalized_output,
    address: pickString(item, ['address', 'owner']),
  };
}

function normalizeInscriptionDetail(item: Record<string, unknown>): OrdInscriptionDetail {
  const inscription_id = pickString(item, ['id', 'inscription_id']) ?? '';
  const inscription_number = pickInt(item, ['number', 'inscription_number']) ?? -1;
  const output = pickString(item, ['output', 'location']);
  const satpoint = pickString(item, ['satpoint']);
  return {
    inscription_id,
    inscription_number,
    output: output ?? (satpoint ? outputFromSatpoint(satpoint) : null),
    address: pickString(item, ['address', 'owner']),
    block_height: pickInt(item, ['height', 'genesis_height', 'block_height']),
    block_timestamp: pickInt(item, ['timestamp', 'block_timestamp', 'block_time', 'genesis_timestamp']),
    satpoint: satpoint ?? null,
  };
}

/**
 * ord's "satpoint" field is `<txid>:<vout>:<offset>`. The "output" we want for
 * change detection is `<txid>:<vout>` only — strip the trailing offset.
 * Offset within an output isn't relevant for transfer detection (and changes
 * when the inscription is "consolidated" into a different position within
 * the same UTXO).
 */
function outputFromSatpoint(satpoint: string): string {
  const parts = satpoint.split(':');
  if (parts.length >= 2) return `${parts[0]}:${parts[1]}`;
  return satpoint;
}

const TXID_RE = /^[0-9a-f]{64}$/i;

/**
 * Extract the txid from an `<txid>:<vout>` output. Returns null if the leading
 * segment isn't a valid 64-char hex txid — guards against malformed ord
 * responses or unexpected satpoint shapes silently writing junk into events.txid.
 */
export function txidFromOutput(output: string): string | null {
  const idx = output.indexOf(':');
  const candidate = idx > 0 ? output.slice(0, idx) : output;
  return TXID_RE.test(candidate) ? candidate.toLowerCase() : null;
}

// ---------------- HTTP + retry ----------------

async function getJson(url: string): Promise<unknown> {
  return await withRetry(() => doFetch(url, { method: 'GET' }));
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  return await withRetry(() =>
    doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

type FetchInit = {
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
};

async function doFetch(url: string, init: FetchInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(init.headers ?? {}),
    };
    const res = await fetch(url, {
      method: init.method,
      headers,
      body: init.body,
      signal: controller.signal,
    });

    if (res.status >= 500) {
      const body = await safeText(res);
      throw new OrdError(`${res.status} from ord`, res.status, true, body);
    }
    if (!res.ok) {
      const body = await safeText(res);
      throw new OrdError(`${res.status} from ord`, res.status, false, body);
    }
    try {
      return await res.json();
    } catch {
      const body = await safeText(res);
      throw new OrdError('Malformed JSON in ord response', res.status, false, body);
    }
  } catch (err) {
    if (err instanceof OrdError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new OrdError(`Network error: ${msg}`, null, true);
  } finally {
    clearTimeout(timer);
  }
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: OrdError | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof OrdError) || !err.retryable) throw err;
      lastError = err;
      const baseMs = 500 * 2 ** attempt;
      const jitter = baseMs * (0.75 + Math.random() * 0.5);
      await sleep(Math.min(jitter, 10_000));
    }
  }
  throw lastError ?? new OrdError('Exhausted retries with no error captured', null, false);
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
