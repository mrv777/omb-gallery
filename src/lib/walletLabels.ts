// Manually-curated labels for special wallets (treasury, mint authority, etc.).
// Used as a display override anywhere we render a wallet identity, and as the
// source of truth for owners we want to suppress from aggregate views
// (leaderboards, charts, activity) so they don't drown out community data.

export const ORANGE_MINT_ADDRESS = 'bc1p4a29gzwlear4csc9sz6ll97j9yl7877tasy75evq8wm6r3admtqq3m72k0';
export const TREASURY_ADDRESS = 'bc1pd6l0a8zg58wgvn30ef46mqmyrtdhwkeqz78kwhe52rk3nl48txhq05ke8f';

export type WalletLabel = {
  name: string;
  /** Short qualifier shown beneath / beside the name in some surfaces. */
  subtitle?: string;
};

export const WALLET_LABELS: Record<string, WalletLabel> = {
  [ORANGE_MINT_ADDRESS]: { name: 'OMB Orange Mint' },
  [TREASURY_ADDRESS]: { name: 'OMB Treasury' },
};

export function lookupWalletLabel(addr: string | null | undefined): WalletLabel | null {
  if (!addr) return null;
  return WALLET_LABELS[addr] ?? null;
}

// Owners whose current holdings & related events are filtered out of every
// aggregate view (leaderboards, distribution/duration histograms, transfer
// sparkline, activity feed, total counts). Top Holders deliberately keeps
// them — that's the only place these protocol wallets should surface, since
// they're by definition among the largest holders.
export const EXCLUDED_OWNERS: readonly string[] = [ORANGE_MINT_ADDRESS, TREASURY_ADDRESS];

// SQL fragment for inline interpolation into prepared statements. Values
// are hardcoded constants we control, so there's no injection vector — but
// we still escape single quotes as a belt-and-braces measure in case a
// future label contains one.
//
// Using inline interpolation (rather than a bound parameter list or a
// `json_each(?)` table-valued function) keeps the queries simple and lets
// SQLite plan them with a literal IN list, which tends to be fast against
// the existing single-column indexes on `current_owner`.
export const SQL_EXCLUDED_OWNERS_LIST: string = EXCLUDED_OWNERS.map(
  a => `'${a.replace(/'/g, "''")}'`
).join(',');
