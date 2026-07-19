// Single source of truth for the top-level navigation.
//
// Imported by both a server component (SubpageShell) and client components
// (MobileMenu, FilterControls), so this file MUST stay framework-free — no
// `'use client'`, no `server-only`, no React/next imports, no hooks. Plain data
// + types only. `NEXT_PUBLIC_*` envs are inlined at build time into both the
// server and client bundles, so the marketplace conditional below resolves
// identically on both sides.

export type NavKey = 'gallery' | 'activity' | 'explorer' | 'marketplace' | 'info';

export type NavItem = { key: NavKey; label: string; href: string };

export const MARKETPLACE_NAV_ENABLED =
  process.env.NEXT_PUBLIC_MARKETPLACE_ENABLED === 'true' ||
  process.env.NEXT_PUBLIC_MARKETPLACE_MOCK === 'true';

export const NAV_ITEMS: NavItem[] = [
  { key: 'gallery', label: 'gallery', href: '/' },
  { key: 'activity', label: 'activity', href: '/activity' },
  { key: 'explorer', label: 'explorer', href: '/explorer' },
  ...(MARKETPLACE_NAV_ENABLED
    ? [{ key: 'marketplace', label: 'marketplace', href: '/marketplace' } as NavItem]
    : []),
  // Trailing ancillary tab — resources / onboarding hub.
  { key: 'info', label: 'info', href: '/info' },
];
