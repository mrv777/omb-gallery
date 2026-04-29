import 'server-only';

const MATRICA_BASE = (process.env.MATRICA_BASE_URL ?? 'https://api.matrica.io').replace(
  /\/+$/,
  ''
);
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 5;

// Matrica's documented rate limits are sparse, but probing showed /v1/user/*
// 429s after ~3-4 calls and /v1/wallet/* tolerates ~3 req/s before the bucket
// noticeably tightens. Pacing at 2 req/s — re-tested 2026-04-29 with a 90-wallet
// sustained burst (0 × 429), giving us comfortable headroom under the ~3 req/s
// ceiling. The matrica poller runs hourly and probes hundreds of wallets per
// tick, so 2/s halves the wallclock vs. 1/s.
// Same minimum-spacing token bucket as satflow.ts.
const RATE_LIMIT_RPS = 2;
const MIN_INTERVAL_MS = 1000 / RATE_LIMIT_RPS;
let nextSlotAt = 0;

/**
 * A Matrica wallet → user mapping, normalized for the poller.
 * Returned by `fetchWalletProfile` when Matrica has a profile for the address.
 */
export type MatricaWalletProfile = {
  /** The wallet address we queried (echoed back). */
  wallet_addr: string;
  /** Matrica's stable user UUID — the join key for grouping wallets by user. */
  user_id: string;
  /** Display name. May be the wallet addr itself when the user hasn't set one. */
  username: string;
  /** Profile picture URL — null when default/missing. */
  avatar_url: string | null;
  /** Network the address is on — e.g. "BTC", "SOL". */
  network: string;
  raw_json: string;
};

export class MatricaError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly bodyExcerpt?: string
  ) {
    super(message);
    this.name = 'MatricaError';
  }
}

// ---------------- public API ----------------

/**
 * Look up the Matrica user linked to a wallet address. Returns null when
 * Matrica has no profile for the address (status 400 + "Wallet not found").
 * Throws MatricaError for tier (403), rate-limit-after-retries (429), and
 * persistent 5xx / network errors.
 */
export async function fetchWalletProfile(
  addr: string,
  apiKey: string
): Promise<MatricaWalletProfile | null> {
  const url = new URL(`${MATRICA_BASE}/v1/wallet/${encodeURIComponent(addr)}`);
  url.searchParams.set('apiKey', apiKey);

  const result = await getWithRetry(url.toString());
  if (result.kind === 'not_found') return null;
  return normalizeWalletProfile(addr, result.json);
}

// ---------------- normalization ----------------

function normalizeWalletProfile(addr: string, json: unknown): MatricaWalletProfile | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  const user = obj.user;
  if (!user || typeof user !== 'object') return null;
  const userObj = user as Record<string, unknown>;
  const userId = pickString(userObj, ['id', 'userId', 'user_id']);
  if (!userId) return null;

  const username = pickString(userObj, ['username', 'vanityURL', 'handle']) ?? addr;
  const profile = (userObj.profile && typeof userObj.profile === 'object'
    ? userObj.profile
    : null) as Record<string, unknown> | null;
  const rawPfp = profile ? pickString(profile, ['pfp']) : null;
  // Matrica returns a default-square placeholder for users who never set a
  // pfp. Treat it as "no avatar" so the UI can fall back cleanly.
  const avatar_url = rawPfp && !rawPfp.includes('default_square') ? rawPfp : null;

  const network = obj.network && typeof obj.network === 'object'
    ? (pickString(obj.network as Record<string, unknown>, ['symbol']) ?? 'UNKNOWN')
    : 'UNKNOWN';

  return {
    wallet_addr: addr,
    user_id: userId,
    username,
    avatar_url,
    network,
    raw_json: JSON.stringify(json),
  };
}

// ---------------- HTTP + retry ----------------

type GetResult = { kind: 'ok'; json: unknown } | { kind: 'not_found' };

async function getWithRetry(url: string): Promise<GetResult> {
  let lastError: MatricaError | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await getOnce(url);
    } catch (err) {
      if (!(err instanceof MatricaError) || !err.retryable) throw err;
      lastError = err;
      const baseMs =
        err.status === 429 ? (extractRetryAfterMs(err) ?? 30_000) : 1000 * 2 ** attempt;
      const jitter = baseMs * (0.75 + Math.random() * 0.5);
      await sleep(Math.min(jitter, 60_000));
    }
  }
  throw lastError ?? new MatricaError('Exhausted retries with no error captured', null, false);
}

async function getOnce(url: string): Promise<GetResult> {
  await waitForRateLimit();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (res.status === 429) {
      const body = await safeText(res);
      throw new MatricaError('429 rate limited', 429, true, withRetryAfterTag(res, body));
    }
    if (res.status >= 500) {
      const body = await safeText(res);
      throw new MatricaError(`${res.status} from matrica`, res.status, true, body);
    }
    // Matrica returns 400 with `{"message":"Wallet not found on Matrica."}`
    // when the address isn't linked. That's not an error — it's the steady-state
    // "no profile" answer. Only treat 400s NOT matching that as errors.
    if (res.status === 400) {
      const body = await safeText(res);
      if (/wallet not found/i.test(body) || /user not found/i.test(body)) {
        return { kind: 'not_found' };
      }
      throw new MatricaError(`400 from matrica`, 400, false, body);
    }
    if (!res.ok) {
      const body = await safeText(res);
      throw new MatricaError(`${res.status} from matrica`, res.status, false, body);
    }
    try {
      return { kind: 'ok', json: await res.json() };
    } catch {
      const body = await safeText(res);
      throw new MatricaError('Malformed JSON in matrica response', res.status, false, body);
    }
  } catch (err) {
    if (err instanceof MatricaError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new MatricaError(`Network error: ${msg}`, null, true);
  } finally {
    clearTimeout(timer);
  }
}

function extractRetryAfterMs(err: MatricaError): number | null {
  if (!err.bodyExcerpt) return null;
  const m = /__retry_after__:(\d+)/.exec(err.bodyExcerpt);
  if (!m) return null;
  return parseInt(m[1], 10) * 1000;
}

function withRetryAfterTag(res: Response, body: string): string {
  const ra = res.headers.get('retry-after');
  if (!ra) return body;
  const seconds = /^\d+$/.test(ra) ? parseInt(ra, 10) : 30;
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
  return new Promise(r => setTimeout(r, ms));
}

async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextSlotAt);
  nextSlotAt = slot + MIN_INTERVAL_MS;
  const wait = slot - now;
  if (wait > 0) await sleep(wait);
}

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
