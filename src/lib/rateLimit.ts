import 'server-only';

// In-memory sliding-window counters. Single Hetzner container = one process,
// so a per-instance Map is adequate. On restart the buckets reset; that's fine
// — worst case is a brief window of no rate limiting right after a deploy.
//
// Bucket keys are namespaced by `feature` so unrelated endpoints (slideshow,
// upscale, subscribe…) don't share a budget. Without the namespace, slideshow
// activity counts against upscale's much smaller global cap, and per-IP slots
// for one feature get consumed by another.

export type RateCheck = { ok: true } | { ok: false; retryAfterSec: number };

const perIp = new Map<string, number[]>();
const globalEvents = new Map<string, number[]>();

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
  feature: string,
  ipKey: string,
  perMin: number,
  perDay: number
): RateCheck {
  const now = Date.now();
  sweepExpired(now);

  const key = `${feature}:${ipKey}`;

  // Saturation fail-closed: if the tracker is full and this is a new key,
  // refuse rather than keep growing. 100k buckets is ~a few MB in practice.
  if (perIp.size >= MAX_TRACKED_IPS && !perIp.has(key)) {
    return { ok: false, retryAfterSec: 60 };
  }

  const dayAgo = now - DAY_MS;
  const minuteAgo = now - MINUTE_MS;

  const pruned = prune(perIp.get(key) ?? [], dayAgo);

  let minuteCount = 0;
  let oldestInMinute = now;
  for (let i = pruned.length - 1; i >= 0; i--) {
    if (pruned[i] < minuteAgo) break;
    minuteCount++;
    oldestInMinute = pruned[i];
  }
  if (minuteCount >= perMin) {
    if (pruned.length === 0) perIp.delete(key);
    else perIp.set(key, pruned);
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((oldestInMinute + MINUTE_MS - now) / 1000)),
    };
  }
  if (pruned.length >= perDay) {
    perIp.set(key, pruned);
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((pruned[0] + DAY_MS - now) / 1000)) };
  }
  pruned.push(now);
  perIp.set(key, pruned);
  return { ok: true };
}

export function checkAndConsumeGlobal(
  feature: string,
  windowMs: number,
  limit: number
): RateCheck {
  const now = Date.now();
  const cutoff = now - windowMs;
  const pruned = prune(globalEvents.get(feature) ?? [], cutoff);
  if (pruned.length >= limit) {
    globalEvents.set(feature, pruned);
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((pruned[0] + windowMs - now) / 1000)),
    };
  }
  pruned.push(now);
  globalEvents.set(feature, pruned);
  return { ok: true };
}

// Test / admin helper.
export function __resetRateLimits(): void {
  perIp.clear();
  globalEvents.clear();
  lastSweep = 0;
}
