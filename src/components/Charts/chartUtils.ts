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

/** Hex/css color per OMB color category, used by chart marks. */
export const OMB_COLOR_HEX: Record<string, string> = {
  red: '#ff2a2a',
  blue: '#2f4cff',
  green: '#2bd46c',
  orange: '#ff8a2a',
  black: '#bfbfbf',
};

export const OMB_COLOR_ORDER = ['red', 'blue', 'green', 'orange', 'black'];
