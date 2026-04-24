import 'server-only';

// In-memory sliding-window counters. Single Hetzner container = one process,
// so a per-instance Map is adequate. On restart the buckets reset; that's fine
// — worst case is a brief window of no rate limiting right after a deploy.

export type RateCheck =
  | { ok: true }
  | { ok: false; retryAfterSec: number };

const perIp = new Map<string, number[]>();
let globalEvents: number[] = [];

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const SWEEP_INTERVAL_MS = 60_000;
const MAX_TRACKED_IPS = 100_000;
let lastSweep = 0;

function prune(arr: number[], cutoff: number): number[] {
  let i = 0;
  while (i < arr.length && arr[i] < cutoff) i++;
  return i === 0 ? arr : arr.slice(i);
}

function sweepExpired(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  const cutoff = now - DAY_MS;
  perIp.forEach((arr, k) => {
    const p = prune(arr, cutoff);
    if (p.length === 0) perIp.delete(k);
    else if (p !== arr) perIp.set(k, p);
  });
}

export function checkAndConsumePerIp(
  ipKey: string,
  perMin: number,
  perDay: number,
): RateCheck {
  const now = Date.now();
  sweepExpired(now);

  // Saturation fail-closed: if the tracker is full and this is a new key,
  // refuse rather than keep growing. 100k buckets is ~a few MB in practice.
  if (perIp.size >= MAX_TRACKED_IPS && !perIp.has(ipKey)) {
    return { ok: false, retryAfterSec: 60 };
  }

  const dayAgo = now - DAY_MS;
  const minuteAgo = now - MINUTE_MS;

  const pruned = prune(perIp.get(ipKey) ?? [], dayAgo);

  let minuteCount = 0;
  let oldestInMinute = now;
  for (let i = pruned.length - 1; i >= 0; i--) {
    if (pruned[i] < minuteAgo) break;
    minuteCount++;
    oldestInMinute = pruned[i];
  }
  if (minuteCount >= perMin) {
    if (pruned.length === 0) perIp.delete(ipKey);
    else perIp.set(ipKey, pruned);
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((oldestInMinute + MINUTE_MS - now) / 1000)) };
  }
  if (pruned.length >= perDay) {
    perIp.set(ipKey, pruned);
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((pruned[0] + DAY_MS - now) / 1000)) };
  }
  pruned.push(now);
  perIp.set(ipKey, pruned);
  return { ok: true };
}

export function checkAndConsumeGlobal(windowMs: number, limit: number): RateCheck {
  const now = Date.now();
  const cutoff = now - windowMs;
  globalEvents = prune(globalEvents, cutoff);
  if (globalEvents.length >= limit) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((globalEvents[0] + windowMs - now) / 1000)) };
  }
  globalEvents.push(now);
  return { ok: true };
}

// Test / admin helper.
export function __resetRateLimits(): void {
  perIp.clear();
  globalEvents = [];
  lastSweep = 0;
}
