import type { ColorFilter } from '@/lib/types';

export type MarketplaceSort = 'price-asc' | 'price-desc' | 'recent';

export type MarketplaceListing = {
  inscription_number: number;
  inscription_id: string;
  listing_id: string;
  satflow_id: string;
  price_sats: number;
  seller: string | null;
  marketplace: string;
  listed_at: number;
  refreshed_at: number;
  color: Exclude<ColorFilter, 'all'> | null;
  thumbnail: string;
  full: string;
  description: string;
};

export type MarketplaceStats = {
  floor_sats: number | null;
  listed_count: number;
  volume_24h_sats: number;
  refreshed_at: number | null;
};

export type MarketplaceListingsResponse = {
  listings: MarketplaceListing[];
  stats: MarketplaceStats;
  mock: boolean;
};

export type MarketplaceLiteListing = {
  inscription_number: number;
  price_sats: number;
  marketplace: string;
  refreshed_at: number;
};

export type BuyIntentStatus = 'created' | 'signed' | 'broadcast' | 'confirmed' | 'failed';

export type BuyIntentRow = {
  id: number;
  inscription_id: string;
  inscription_number: number;
  buyer_ord_addr: string;
  buyer_pay_addr: string | null;
  marketplace: string;
  listing_id: string | null;
  price_sats: number;
  status: BuyIntentStatus;
  txid: string | null;
  fail_reason: string | null;
  preflight_json: string | null;
  is_mock: 0 | 1;
  created_at: number;
  updated_at: number;
};

export type CreateIntentResponse = {
  intent_id: number;
  psbt: string;
  sign_inputs?: Record<string, number[]>;
  listing: MarketplaceListing;
  mock: boolean;
};

export type BroadcastResponse = {
  intent_id: number;
  txid: string;
  mock: boolean;
};
