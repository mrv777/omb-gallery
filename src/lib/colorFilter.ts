import type { ColorFilter } from './types';

// Concrete colors (excludes the 'all' sentinel). Keep in sync with the
// `ColorFilter` union in types.ts and the seeded color-grouped data under
// src/data/collections/omb/inscriptions.json.
export const COLOR_VALUES = ['red', 'blue', 'green', 'orange', 'black'] as const;

export type ConcreteColor = (typeof COLOR_VALUES)[number];

const VALID_COLORS: ReadonlySet<string> = new Set<string>(COLOR_VALUES);

/** Parse a `?color=` URL param. Returns 'all' for missing or invalid input —
 * URLs are shareable, so we soft-fall-back rather than 404 a typoed value. */
export function parseColorParam(value: string | null | undefined): ColorFilter {
  if (!value) return 'all';
  return VALID_COLORS.has(value) ? (value as ColorFilter) : 'all';
}

/** SQL helper: pass to prepared statements that filter by color. NULL means
 * "no filter" — the SQL uses `(@color IS NULL OR <col>.color = @color)`. */
export function colorParamForSql(color: ColorFilter): string | null {
  return color === 'all' ? null : color;
}

/** Append `?color=...` to a path, or pass through unchanged when 'all'.
 * Preserves any existing query string. */
export function appendColorParam(href: string, color: ColorFilter): string {
  if (color === 'all') return href;
  const sep = href.includes('?') ? '&' : '?';
  return `${href}${sep}color=${color}`;
}
