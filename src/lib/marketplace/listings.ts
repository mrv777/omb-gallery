import 'server-only';

import { getDb, type ActiveListingRow } from '@/lib/db';
import { lookupInscription } from '@/lib/inscriptionLookup';
import type {
  MarketplaceListing,
  MarketplaceLiteListing,
  MarketplaceSort,
  MarketplaceStats,
} from './types';

type ListingDbRow = ActiveListingRow & {
  color: string | null;
};

const SORT_SQL: Record<MarketplaceSort, string> = {
  'price-asc': 'al.price_sats ASC, al.inscription_number ASC',
  'price-desc': 'al.price_sats DESC, al.inscription_number ASC',
  recent: 'al.listed_at DESC, al.inscription_number ASC',
};

export function marketplaceMockEnabled(): boolean {
  return process.env.MARKETPLACE_MOCK === 'true';
}

export function marketplaceFixtureListingsEnabled(): boolean {
  return process.env.MARKETPLACE_FIXTURE_LISTINGS === 'true';
}

export function marketplaceMockWalletEnabled(): boolean {
  return process.env.MARKETPLACE_MOCK_WALLET === 'true';
}

export function marketplaceEnabled(): boolean {
  return (
    process.env.NEXT_PUBLIC_MARKETPLACE_ENABLED === 'true' ||
    marketplaceMockEnabled() ||
    marketplaceFixtureListingsEnabled()
  );
}

export function normalizeMarketplaceSort(value: string | null | undefined): MarketplaceSort {
  if (value === 'price-desc' || value === 'recent') return value;
  return 'price-asc';
}

export function getMarketplaceListings(options?: {
  color?: string | null;
  sort?: MarketplaceSort;
  limit?: number;
}): MarketplaceListing[] {
  const sort = options?.sort ?? 'price-asc';
  const limit = Math.max(1, Math.min(options?.limit ?? 1000, 1000));
  const color = normalizeColor(options?.color);
  const rows = getDb()
    .prepare(
      `
      SELECT al.*, i.color
      FROM active_listings al
      JOIN inscriptions i ON i.inscription_number = al.inscription_number
      WHERE i.collection_slug = 'omb'
        AND (@color IS NULL OR i.color = @color)
      ORDER BY ${SORT_SQL[sort]}
      LIMIT @limit
    `
    )
    .all({ color, limit }) as ListingDbRow[];

  const out: MarketplaceListing[] = [];
  for (const row of rows) {
    const listing = listingFromDbRow(row);
    if (listing) out.push(listing);
  }
  return out;
}

export function getMarketplaceLiteListings(): MarketplaceLiteListing[] {
  return getDb()
    .prepare(
      `
      SELECT al.inscription_number, al.price_sats, al.marketplace, al.refreshed_at
      FROM active_listings al
      JOIN inscriptions i ON i.inscription_number = al.inscription_number
      WHERE i.collection_slug = 'omb'
      ORDER BY al.price_sats ASC, al.inscription_number ASC
    `
    )
    .all() as MarketplaceLiteListing[];
}

export function getMarketplaceListing(inscriptionNumber: number): MarketplaceListing | null {
  const row = getDb()
    .prepare(
      `
      SELECT al.*, i.color
      FROM active_listings al
      JOIN inscriptions i ON i.inscription_number = al.inscription_number
      WHERE i.collection_slug = 'omb'
        AND al.inscription_number = ?
    `
    )
    .get(inscriptionNumber) as ListingDbRow | undefined;
  return row ? listingFromDbRow(row) : null;
}

export function getMarketplaceStats(): MarketplaceStats {
  const db = getDb();
  const snapshot = db
    .prepare(
      `
      SELECT COUNT(*) AS listed_count,
             MIN(al.price_sats) AS floor_sats,
             MAX(al.refreshed_at) AS refreshed_at
      FROM active_listings al
      JOIN inscriptions i ON i.inscription_number = al.inscription_number
      WHERE i.collection_slug = 'omb'
    `
    )
    .get() as {
    listed_count: number;
    floor_sats: number | null;
    refreshed_at: number | null;
  };
  const volume = db
    .prepare(
      `
      SELECT COALESCE(SUM(e.sale_price_sats), 0) AS volume_24h_sats
      FROM events e
      JOIN inscriptions i ON i.inscription_number = e.inscription_number
      WHERE i.collection_slug = 'omb'
        AND e.event_type = 'sold'
        AND e.sale_price_sats IS NOT NULL
        AND e.block_timestamp >= @since
    `
    )
    .get({ since: Math.floor(Date.now() / 1000) - 86_400 }) as { volume_24h_sats: number };

  return {
    floor_sats: snapshot.floor_sats,
    listed_count: snapshot.listed_count,
    refreshed_at: snapshot.refreshed_at,
    volume_24h_sats: volume.volume_24h_sats,
  };
}

function listingFromDbRow(row: ListingDbRow): MarketplaceListing | null {
  const hit = lookupInscription(row.inscription_number);
  if (!hit || hit.kind !== 'omb') return null;
  return {
    inscription_number: row.inscription_number,
    inscription_id: row.inscription_id,
    listing_id: row.satflow_id,
    satflow_id: row.satflow_id,
    price_sats: row.price_sats,
    seller: row.seller,
    marketplace: row.marketplace,
    listed_at: row.listed_at,
    refreshed_at: row.refreshed_at,
    color: normalizeColor(row.color),
    thumbnail: hit.thumbnail,
    full: hit.full,
    description: hit.description,
  };
}

function normalizeColor(value: string | null | undefined): MarketplaceListing['color'] | null {
  if (
    value === 'red' ||
    value === 'blue' ||
    value === 'green' ||
    value === 'orange' ||
    value === 'black'
  ) {
    return value;
  }
  return null;
}
