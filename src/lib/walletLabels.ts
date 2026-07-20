// Manually-curated labels for special wallets (treasury, mint authority, etc.).
// Used as a display override anywhere we render a wallet identity, and as the
// source of truth for owners we want to suppress from aggregate views
// (leaderboards, charts, activity) so they don't drown out community data.

export const ORANGE_MINT_ADDRESS = 'bc1p4a29gzwlear4csc9sz6ll97j9yl7877tasy75evq8wm6r3admtqq3m72k0';
export const TREASURY_ADDRESS = 'bc1pd6l0a8zg58wgvn30ef46mqmyrtdhwkeqz78kwhe52rk3nl48txhq05ke8f';

// Bravocados: the dispensary wallet holds the first 100 and dispenses them one
// at a time to Parasite mining-pool participants who land a big share. A
// bravocado still sitting in a distribution wallet counts as "not yet
// distributed" on /bravocados. Hand-curated (MINT_WALLETS precedent) — extend
// with team/deployer wallets as they're identified from holder concentration.
export const BRAVOCADO_DISPENSARY_ADDRESS = 'bc1qc3vmv3r5l9dlj8tx07yqsdgt4s2dc6f6tucad0';
// Holds the ~902 not yet moved into the dispensary (identified 2026-07-20 by
// holder concentration: 902 of 1,002 in one wallet).
export const BRAVOCADO_RESERVE_ADDRESS =
  'bc1pjzt0tk4f8s6gu5kl2lgtq3ruymce09kmxjw6637ceqdldrwumt7shxwl4u';
export const BRAVOCADO_DISTRIBUTION_WALLETS: readonly string[] = [
  BRAVOCADO_DISPENSARY_ADDRESS,
  BRAVOCADO_RESERVE_ADDRESS,
];

export type WalletLabel = {
  name: string;
  /** Short qualifier shown beneath / beside the name in some surfaces. */
  subtitle?: string;
};

export const WALLET_LABELS: Record<string, WalletLabel> = {
  [ORANGE_MINT_ADDRESS]: { name: 'OMB Orange Mint' },
  [TREASURY_ADDRESS]: { name: 'OMB Treasury' },
  [BRAVOCADO_DISPENSARY_ADDRESS]: {
    name: 'Bravocados Dispensary',
    subtitle: 'Parasite pool rewards',
  },
  [BRAVOCADO_RESERVE_ADDRESS]: { name: 'Bravocados Reserve' },
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

// Same inline-literal treatment for the bravocado distribution wallets.
export const SQL_BRAVOCADO_DISTRIBUTION_LIST: string = BRAVOCADO_DISTRIBUTION_WALLETS.map(
  a => `'${a.replace(/'/g, "''")}'`
).join(',');
