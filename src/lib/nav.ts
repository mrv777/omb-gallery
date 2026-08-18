// Single source of truth for the top-level navigation.
//
// Imported by both a server component (SubpageShell) and client components
// (MobileMenu, FilterControls), so this file MUST stay framework-free — no
// `'use client'`, no `server-only`, no React/next imports, no hooks. Plain data
// + types only. `NEXT_PUBLIC_*` envs are inlined at build time into both the
// server and client bundles, so the marketplace conditional below resolves
// identically on both sides.

export type NavKey =
  | 'gallery'
  | 'activity'
  | 'explorer'
  | 'community'
  | 'marketplace'
  | 'history'
  | 'bravocados'
  | 'info';

/**
 * `primary` is the OMB app itself — the surfaces backed by our own index.
 * `secondary` is adjacent material: the collection's story, the companion
 * collection, and the resources hub (which is where Parasite lives).
 *
 * The split is rendered as weight + a divider, never as a dropdown. Bravocados
 * is genuinely NOT OMB, and burying it would misrepresent it just as much as
 * listing it flush with `gallery` would. Dimming says "related, not the same"
 * without costing a click — hiding desktop nav behind a menu measurably halves
 * discoverability (NN/g, 179 participants), which is the problem this tier
 * split exists to solve.
 */
export type NavTier = 'primary' | 'secondary';
export type NavGroup = 'browse' | 'buy' | 'about';

export type NavItem = {
  key: NavKey;
  label: string;
  href: string;
  tier: NavTier;
  group: NavGroup;
  /**
   * Render this item as a glyph instead of its label in the horizontal nav.
   * A name, not a component — this module is imported by both the server tree
   * and the client bundle and has to stay framework-free. Consumers map the
   * name to an icon; the `label` stays the accessible name and is what the
   * mobile sheet shows, since a vertical list has room for words.
   */
  icon?: 'avocado';
};

export const MARKETPLACE_NAV_ENABLED =
  process.env.NEXT_PUBLIC_MARKETPLACE_ENABLED === 'true' ||
  process.env.NEXT_PUBLIC_MARKETPLACE_MOCK === 'true';

export const COMMUNITY_NAV_ENABLED = process.env.NEXT_PUBLIC_COMMUNITY_PURCHASES_ENABLED === 'true';

export const NAV_ITEMS: NavItem[] = [
  { key: 'gallery', label: 'gallery', href: '/', tier: 'primary', group: 'browse' },
  { key: 'activity', label: 'activity', href: '/activity', tier: 'primary', group: 'browse' },
  { key: 'explorer', label: 'explorer', href: '/explorer', tier: 'primary', group: 'browse' },
  ...(MARKETPLACE_NAV_ENABLED
    ? [
        {
          key: 'marketplace',
          label: 'market',
          href: '/marketplace',
          tier: 'primary',
          group: 'buy',
        } as NavItem,
      ]
    : []),
  ...(COMMUNITY_NAV_ENABLED
    ? [
        {
          key: 'community',
          label: 'group buys',
          href: '/community',
          tier: 'primary',
          group: 'buy',
        } as NavItem,
      ]
    : []),
  { key: 'history', label: 'history', href: '/history', tier: 'secondary', group: 'about' },
  {
    key: 'bravocados',
    label: 'bravocados',
    href: '/bravocados',
    tier: 'secondary',
    group: 'about',
    icon: 'avocado',
  },
  { key: 'info', label: 'info', href: '/info', tier: 'secondary', group: 'about' },
];

export const PRIMARY_NAV_ITEMS = NAV_ITEMS.filter(i => i.tier === 'primary');
export const SECONDARY_NAV_ITEMS = NAV_ITEMS.filter(i => i.tier === 'secondary');
