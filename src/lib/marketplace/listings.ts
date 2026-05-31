import 'server-only';

import { getDb, type ActiveListingRow } from '@/lib/db';
import { lookupInscription } from '@/lib/inscriptionLookup';
import type {
  MarketplaceListing,
  MarketplaceListingOption,
  MarketplaceLiteListing,
  MarketplaceSort,
  MarketplaceStats,
} from './types';

type ListingDbRow = ActiveListingRow & {
  color: string | null;
};

type ListingSourceSelector = {
  marketplace?: string | null;
  listingId?: string | null;
};

const GROUP_SORT_SQL: Record<MarketplaceSort, string> = {
  'price-asc': 'primary_price ASC, inscription_number ASC',
  'price-desc': 'primary_price DESC, inscription_number ASC',
  recent: 'latest_listed_at DESC, inscription_number ASC',
};
const OUTER_GROUP_SORT_SQL: Record<MarketplaceSort, string> = {
  'price-asc': 'g.primary_price ASC, g.inscription_number ASC',
  'price-desc': 'g.primary_price DESC, g.inscription_number ASC',
  recent: 'g.latest_listed_at DESC, g.inscription_number ASC',
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
      WITH grouped AS (
        SELECT al.inscription_number,
               MIN(al.price_sats) AS primary_price,
               MAX(al.listed_at)  AS latest_listed_at
        FROM active_listings al
        JOIN inscriptions i ON i.inscription_number = al.inscription_number
        WHERE i.collection_slug = 'omb'
          AND (@color IS NULL OR i.color = @color)
        GROUP BY al.inscription_number
        ORDER BY ${GROUP_SORT_SQL[sort]}
        LIMIT @limit
      )
      SELECT al.*, i.color
      FROM grouped g
      JOIN active_listings al ON al.inscription_number = g.inscription_number
      JOIN inscriptions i ON i.inscription_number = al.inscription_number
      ORDER BY ${OUTER_GROUP_SORT_SQL[sort]},
               al.price_sats ASC,
               ${marketplacePrioritySql('al.marketplace')} ASC,
               al.listed_at DESC,
               al.satflow_id ASC
    `
    )
    .all({ color, limit }) as ListingDbRow[];

  return groupedListingsFromRows(rows);
}

export function getMarketplaceLiteListings(): MarketplaceLiteListing[] {
  const listings = groupedListingsFromRows(
    getDb()
      .prepare(
        `
        SELECT al.*, i.color
        FROM active_listings al
        JOIN inscriptions i ON i.inscription_number = al.inscription_number
        WHERE i.collection_slug = 'omb'
        ORDER BY al.inscription_number ASC,
                 al.price_sats ASC,
                 ${marketplacePrioritySql('al.marketplace')} ASC,
                 al.listed_at DESC,
                 al.satflow_id ASC
      `
      )
      .all() as ListingDbRow[]
  );

  return listings.map(listing => ({
    inscription_number: listing.inscription_number,
    price_sats: listing.price_sats,
    marketplace: listing.marketplace,
    marketplaces: listing.options.map(option => option.marketplace),
    listing_count: listing.options.length,
    refreshed_at: Math.max(...listing.options.map(option => option.refreshed_at)),
  }));
}

export function getMarketplaceListing(
  inscriptionNumber: number,
  source?: ListingSourceSelector
): MarketplaceListing | null {
  const rows = getDb()
    .prepare(
      `
      SELECT al.*, i.color
      FROM active_listings al
      JOIN inscriptions i ON i.inscription_number = al.inscription_number
      WHERE i.collection_slug = 'omb'
        AND al.inscription_number = ?
      ORDER BY al.price_sats ASC,
               ${marketplacePrioritySql('al.marketplace')} ASC,
               al.listed_at DESC,
               al.satflow_id ASC
    `
    )
    .all(inscriptionNumber) as ListingDbRow[];
  if (rows.length === 0) return null;
  if (source?.marketplace && source.listingId) {
    const requested = rows.find(
      row =>
        normalizeMarketplaceKey(row.marketplace) === normalizeMarketplaceKey(source.marketplace) &&
        row.satflow_id === source.listingId
    );
    if (!requested) return null;
  }
  return listingFromDbRows(rows, source);
}

export function getMarketplaceStats(): MarketplaceStats {
  const db = getDb();
  const snapshot = db
    .prepare(
      `
      SELECT COUNT(DISTINCT al.inscription_number) AS listed_count,
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

function groupedListingsFromRows(rows: ListingDbRow[]): MarketplaceListing[] {
  const byNumber = new Map<number, ListingDbRow[]>();
  for (const row of rows) {
    const list = byNumber.get(row.inscription_number) ?? [];
    list.push(row);
    byNumber.set(row.inscription_number, list);
  }

  const out: MarketplaceListing[] = [];
  for (const group of Array.from(byNumber.values())) {
    const listing = listingFromDbRows(group);
    if (listing) out.push(listing);
  }
  return out;
}

function listingFromDbRows(
  rows: ListingDbRow[],
  preferred?: ListingSourceSelector
): MarketplaceListing | null {
  const first = rows[0];
  if (!first) return null;
  const hit = lookupInscription(first.inscription_number);
  if (!hit || hit.kind !== 'omb') return null;

  const options = rows.map(optionFromDbRow).toSorted(compareOptions);
  const preferredOption =
    preferred?.marketplace && preferred.listingId
      ? options.find(
          option =>
            normalizeMarketplaceKey(option.marketplace) ===
              normalizeMarketplaceKey(preferred.marketplace) &&
            option.listing_id === preferred.listingId
        )
      : null;
  const primary = preferredOption ?? options[0];
  if (!primary) return null;

  return {
    inscription_number: first.inscription_number,
    inscription_id: first.inscription_id,
    listing_id: primary.listing_id,
    satflow_id: primary.satflow_id,
    price_sats: primary.price_sats,
    seller: primary.seller,
    marketplace: primary.marketplace,
    listed_at: primary.listed_at,
    refreshed_at: primary.refreshed_at,
    color: normalizeColor(first.color),
    thumbnail: hit.thumbnail,
    full: hit.full,
    description: hit.description,
    options,
  };
}

function optionFromDbRow(row: ListingDbRow): MarketplaceListingOption {
  return {
    listing_id: row.satflow_id,
    satflow_id: row.satflow_id,
    price_sats: row.price_sats,
    seller: row.seller,
    marketplace: row.marketplace,
    listed_at: row.listed_at,
    refreshed_at: row.refreshed_at,
  };
}

function compareOptions(a: MarketplaceListingOption, b: MarketplaceListingOption): number {
  return (
    a.price_sats - b.price_sats ||
    marketplacePriority(a.marketplace) - marketplacePriority(b.marketplace) ||
    b.listed_at - a.listed_at ||
    a.listing_id.localeCompare(b.listing_id)
  );
}

function marketplacePriority(marketplace: string): number {
  const key = normalizeMarketplaceKey(marketplace);
  if (key === 'ord.net' || key === 'ordnet' || key === 'ord-net') return 0;
  if (key === 'satflow') return 1;
  return 2;
}

function marketplacePrioritySql(expr: string): string {
  return `CASE ${expr}
    WHEN 'ord.net' THEN 0
    WHEN 'ordnet' THEN 0
    WHEN 'ord-net' THEN 0
    WHEN 'satflow' THEN 1
    ELSE 2
  END`;
}

function normalizeMarketplaceKey(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
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
