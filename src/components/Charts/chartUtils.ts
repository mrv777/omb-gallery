// Hand-rolled SVG chart helpers. Kept tiny and dependency-free so charts can
// render as RSC without dragging client bundles in.

export function shortenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (n < 1_000_000) return Math.round(n / 1000) + 'k';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

/** 'yyyy-mm-dd' → 'M/d'. Returns input on parse failure. */
export function shortDate(iso: string): string {
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  if (!Number.isFinite(m) || !Number.isFinite(d)) return iso;
  return `${m}/${d}`;
}

/** unix seconds → 'MMM yyyy' (en-US, no day). */
export function monthYear(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
  });
}

/** unix seconds → 'MMM d, yyyy'. */
export function fullDate(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Generate `count` evenly-spaced ticks across a unix-second range.
 * Picks `monthYear` labels for spans > ~60 days, `shortDate` otherwise — so
 * a 90-day activity window reads as `4/14, 5/1, 5/15, ...` while a multi-year
 * holder timeline reads as `Apr 2022, Oct 2022, Apr 2023, ...`. Returned
 * `pct` is 0-100 for direct CSS `left` positioning. */
export function timeTicks(
  tMin: number,
  tMax: number,
  count: number
): Array<{ t: number; pct: number; label: string }> {
  if (count < 2) return [];
  const span = Math.max(1, tMax - tMin);
  const useMonth = span > 60 * 86400;
  const fmt = (t: number): string => {
    if (useMonth) return monthYear(t);
    const d = new Date(t * 1000);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };
  const out: Array<{ t: number; pct: number; label: string }> = [];
  for (let i = 0; i < count; i++) {
    const frac = i / (count - 1);
    const t = tMin + span * frac;
    out.push({ t, pct: frac * 100, label: fmt(t) });
  }
  return out;
}

/** Hex/css color per OMB color category, used by chart marks. */
export const OMB_COLOR_HEX: Record<string, string> = {
  red: '#ff2a2a',
  blue: '#2f4cff',
  green: '#2bd46c',
  orange: '#ff8a2a',
  black: '#bfbfbf',
};

export const OMB_COLOR_ORDER = ['red', 'blue', 'green', 'orange', 'black'];
