import type { ApiHolder, ApiInscription } from '@/components/Activity/types';

export type LeaderboardKey =
  | 'most-transferred'
  | 'longest-unmoved'
  | 'top-volume'
  | 'highest-sale'
  | 'most-loaned'
  | 'currently-loaned'
  | 'top-holders';

export type LeaderboardMeta = {
  key: LeaderboardKey;
  title: string;
  blurb: string;
  metricLabel: string;
};

export const LEADERBOARDS: Record<LeaderboardKey, LeaderboardMeta> = {
  'most-transferred': {
    key: 'most-transferred',
    title: 'Most Transferred',
    blurb: 'Inscriptions changing hands most often (transfers + sales).',
    metricLabel: 'moves',
  },
  'longest-unmoved': {
    key: 'longest-unmoved',
    title: 'Longest Unmoved',
    blurb:
      'Inscriptions that have moved at least once and whose last movement was longest ago. Never-distributed pieces are excluded.',
    metricLabel: 'last moved',
  },
  'top-volume': {
    key: 'top-volume',
    title: 'Top Sale Volume',
    blurb: 'Inscriptions with the highest total BTC sold across history.',
    metricLabel: 'volume',
  },
  'highest-sale': {
    key: 'highest-sale',
    title: 'Highest Single Sale',
    blurb: 'Inscriptions with the highest single sale price ever recorded.',
    metricLabel: 'sale',
  },
  'most-loaned': {
    key: 'most-loaned',
    title: 'Most Borrowed Against',
    blurb: 'Inscriptions used as collateral in the most loans (originations).',
    metricLabel: 'loans',
  },
  'currently-loaned': {
    key: 'currently-loaned',
    title: 'Currently Loaned',
    blurb: 'Active loans, newest first. Hover for an estimated expiration.',
    metricLabel: 'loaned',
  },
  'top-holders': {
    key: 'top-holders',
    title: 'Top Holders',
    blurb: 'Wallets holding the most OMB inscriptions.',
    metricLabel: 'inscriptions',
  },
};

export type LeaderboardItem =
  | { kind: 'inscription'; row: ApiInscription }
  | { kind: 'holder'; row: ApiHolder };
