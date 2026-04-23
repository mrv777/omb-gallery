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

function prune(arr: number[], cutoff: number): number[] {
  let i = 0;
  while (i < arr.length && arr[i] < cutoff) i++;
  return i === 0 ? arr : arr.slice(i);
}

export function checkAndConsumePerIp(
  ipKey: string,
  perMin: number,
  perDay: number,
): RateCheck {
  const now = Date.now();
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
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((oldestInMinute + MINUTE_MS - now) / 1000)) };
  }
  if (pruned.length >= perDay) {
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
}
