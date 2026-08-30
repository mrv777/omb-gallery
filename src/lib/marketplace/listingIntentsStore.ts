import 'server-only';

import { getDb } from '@/lib/db';
import { lookupInscription } from '@/lib/inscriptionLookup';
import type { StoredOrdnetListingPreflight } from '@/lib/ordnet';
import type {
  OrdnetListingDurationDays,
  OrdnetSellerProvider,
  SellerListingSummary,
  SellerOmb,
} from './sellerTypes';

export type ListingIntentStatus =
  | 'created'
  | 'submitting'
  | 'active'
  | 'pending_indexing'
  | 'delisted'
  | 'failed'
  | 'ambiguous'
  | 'stale';

export type ListingIntentRow = {
  id: number;
  seller_ord_addr: string;
  seller_pay_addr: string;
  inscription_id: string;
  inscription_number: number;
  current_output: string;
  price_sats: number;
  duration_days: OrdnetListingDurationDays;
  provider_id: OrdnetSellerProvider;
  wallet_binding_id: string;
  anchor_utxo_id: string;
  preflight_json: string | null;
  unsigned_psbt_hashes_json: string | null;
  status: ListingIntentStatus;
  listing_id: string | null;
  claim_token: string | null;
  claimed_at: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};

export type SellerInscriptionRow = {
  inscription_number: number;
  inscription_id: string | null;
  current_owner: string | null;
  current_output: string | null;
  color: string | null;
  active_loan_count: number;
};

type ActiveListingDbRow = {
  inscription_number: number;
  inscription_id: string;
  satflow_id: string;
  price_sats: number;
  seller: string | null;
  marketplace: string;
  listed_at: number;
  expires_at: number | null;
};

type LiveListingIntent = {
  inscription_number: number;
  listing_id: string | null;
  price_sats: number;
  seller_ord_addr: string;
  created_at: number;
  duration_days: number;
  status: 'created' | 'submitting' | 'pending_indexing';
};

export function listSellerOmbs(args: {
  sellerOrdAddr: string;
  cursor?: number | null;
  limit: number;
}): { items: SellerOmb[]; nextCursor: number | null } {
  const limit = Math.max(1, Math.min(Math.trunc(args.limit), 100));
  const rows = getDb()
    .prepare(
      `
      SELECT inscription_number, inscription_id, current_owner, current_output,
             color, active_loan_count
      FROM inscriptions
      WHERE collection_slug = 'omb'
        AND current_owner = @seller
        AND inscription_number > @cursor
      ORDER BY inscription_number ASC
      LIMIT @limit
    `
    )
    .all({
      seller: args.sellerOrdAddr,
      cursor: args.cursor ?? -1,
      limit: limit + 1,
    }) as SellerInscriptionRow[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const listings = listListingsForInscriptionNumbers(page.map(row => row.inscription_number));
  const liveIntents = listLiveIntentsForInscriptionNumbers(
    page.map(row => row.inscription_number),
    args.sellerOrdAddr
  );
  const liveByNumber = new Map(liveIntents.map(intent => [intent.inscription_number, intent]));
  const byNumber = new Map<number, SellerListingSummary[]>();
  for (const listing of listings) {
    const list = byNumber.get(listing.inscription_number) ?? [];
    list.push({
      listing_id: listing.satflow_id,
      marketplace: listing.marketplace,
      price_sats: listing.price_sats,
      seller: listing.seller,
      listed_at: listing.listed_at,
      expires_at: listing.expires_at,
    });
    byNumber.set(listing.inscription_number, list);
  }

  const items = page.map(row => {
    const intent = liveByNumber.get(row.inscription_number) ?? null;
    const summaries = byNumber.get(row.inscription_number) ?? [];
    if (
      intent?.status === 'pending_indexing' &&
      intent.listing_id &&
      !summaries.some(item => item.listing_id === intent.listing_id)
    ) {
      summaries.push({
        listing_id: intent.listing_id,
        marketplace: 'ord.net',
        price_sats: intent.price_sats,
        seller: intent.seller_ord_addr,
        listed_at: intent.created_at,
        expires_at: intent.created_at + intent.duration_days * 86_400,
        status: 'pending_indexing',
      });
    }
    return sellerOmbFromRow(row, summaries, intent);
  });
  return {
    items,
    nextCursor: hasMore ? (page.at(-1)?.inscription_number ?? null) : null,
  };
}

export function getSellerInscription(
  inscriptionNumber: number,
  sellerOrdAddr: string
): SellerInscriptionRow | null {
  const row = getDb()
    .prepare(
      `
      SELECT inscription_number, inscription_id, current_owner, current_output,
             color, active_loan_count
      FROM inscriptions
      WHERE collection_slug = 'omb'
        AND inscription_number = ?
        AND current_owner = ?
    `
    )
    .get(inscriptionNumber, sellerOrdAddr) as SellerInscriptionRow | undefined;
  return row ?? null;
}

export function getSellerInscriptionById(
  inscriptionId: string,
  sellerOrdAddr: string
): SellerInscriptionRow | null {
  const row = getDb()
    .prepare(
      `
      SELECT inscription_number, inscription_id, current_owner, current_output,
             color, active_loan_count
      FROM inscriptions
      WHERE collection_slug = 'omb'
        AND inscription_id = ?
        AND current_owner = ?
      LIMIT 1
    `
    )
    .get(inscriptionId, sellerOrdAddr) as SellerInscriptionRow | undefined;
  return row ?? null;
}

export function listActiveListingsForInscription(inscriptionNumber: number): ActiveListingDbRow[] {
  return getDb()
    .prepare(
      `
      SELECT al.*,
             (SELECT li.created_at + li.duration_days * 86400
                FROM listing_intents li
               WHERE li.listing_id = al.satflow_id
               ORDER BY li.id DESC LIMIT 1) AS expires_at
      FROM active_listings al
      WHERE al.inscription_number = ?
      ORDER BY al.listed_at DESC, al.satflow_id ASC
    `
    )
    .all(inscriptionNumber) as ActiveListingDbRow[];
}

export function createListingIntent(args: {
  sellerOrdAddr: string;
  sellerPayAddr: string;
  inscriptionId: string;
  inscriptionNumber: number;
  currentOutput: string;
  priceSats: number;
  durationDays: OrdnetListingDurationDays;
  providerId: OrdnetSellerProvider;
  walletBindingId: string;
  preflight: StoredOrdnetListingPreflight;
  unsignedPsbtHashes: string[];
}): number {
  const listing = args.preflight.response.listings[0];
  if (!listing) throw new Error('listing preflight missing item');
  const db = getDb();
  const replaceCreated = db.transaction(() => {
    // A wallet rejection or closed prompt never reaches /submit. A deliberate
    // fresh preflight supersedes that unsigned attempt atomically, so the old
    // intent cannot block the seller forever or race the new PSBT set.
    db.prepare(
      `
      UPDATE listing_intents
      SET status = 'stale', preflight_json = NULL, unsigned_psbt_hashes_json = NULL,
          claim_token = NULL, claimed_at = NULL,
          error = 'superseded by a fresh preflight', updated_at = unixepoch()
      WHERE inscription_id = @inscription_id AND status = 'created'
    `
    ).run({ inscription_id: args.inscriptionId });
    return db
      .prepare(
        `
      INSERT INTO listing_intents (
        seller_ord_addr, seller_pay_addr, inscription_id, inscription_number,
        current_output, price_sats, duration_days, provider_id, wallet_binding_id,
        anchor_utxo_id, preflight_json, unsigned_psbt_hashes_json, status,
        created_at, updated_at
      ) VALUES (
        @seller_ord_addr, @seller_pay_addr, @inscription_id, @inscription_number,
        @current_output, @price_sats, @duration_days, @provider_id, @wallet_binding_id,
        @anchor_utxo_id, @preflight_json, @unsigned_psbt_hashes_json, 'created',
        unixepoch(), unixepoch()
      )
    `
      )
      .run({
        seller_ord_addr: args.sellerOrdAddr,
        seller_pay_addr: args.sellerPayAddr,
        inscription_id: args.inscriptionId,
        inscription_number: args.inscriptionNumber,
        current_output: args.currentOutput,
        price_sats: args.priceSats,
        duration_days: args.durationDays,
        provider_id: args.providerId,
        wallet_binding_id: args.walletBindingId,
        anchor_utxo_id: listing.anchorUtxoId,
        preflight_json: JSON.stringify(args.preflight),
        unsigned_psbt_hashes_json: JSON.stringify(args.unsignedPsbtHashes),
      });
  });
  const result = replaceCreated();
  return Number(result.lastInsertRowid);
}

export function getListingIntent(id: number): ListingIntentRow | null {
  const row = getDb().prepare(`SELECT * FROM listing_intents WHERE id = ?`).get(id) as
    | ListingIntentRow
    | undefined;
  return row ?? null;
}

export function claimListingIntent(id: number, token: string, staleAfterSeconds = 120): boolean {
  const result = getDb()
    .prepare(
      `
      UPDATE listing_intents
      SET status = 'submitting', claim_token = @token, claimed_at = unixepoch(),
          error = NULL, updated_at = unixepoch()
      WHERE id = @id
        AND status IN ('created', 'submitting')
        AND (status = 'created' OR claimed_at IS NULL OR claimed_at < unixepoch() - @stale_after)
    `
    )
    .run({ id, token, stale_after: Math.max(30, Math.trunc(staleAfterSeconds)) });
  return result.changes === 1;
}

export function finishListingIntent(args: {
  id: number;
  token: string;
  status: Exclude<ListingIntentStatus, 'created' | 'submitting'>;
  listingId?: string | null;
  error?: string | null;
  clearPreflight?: boolean;
}): boolean {
  const result = getDb()
    .prepare(
      `
      UPDATE listing_intents
      SET status = @status,
          listing_id = COALESCE(@listing_id, listing_id),
          error = @error,
          preflight_json = CASE WHEN @clear_preflight = 1 THEN NULL ELSE preflight_json END,
          unsigned_psbt_hashes_json = CASE WHEN @clear_preflight = 1 THEN NULL ELSE unsigned_psbt_hashes_json END,
          claim_token = NULL, claimed_at = NULL, updated_at = unixepoch()
      WHERE id = @id AND status = 'submitting' AND claim_token = @token
    `
    )
    .run({
      id: args.id,
      token: args.token,
      status: args.status,
      listing_id: args.listingId ?? null,
      error: args.error?.slice(0, 500) ?? null,
      clear_preflight: args.clearPreflight === true ? 1 : 0,
    });
  return result.changes === 1;
}

export function releaseListingIntent(args: {
  id: number;
  token: string;
  error?: string | null;
}): boolean {
  const result = getDb()
    .prepare(
      `
      UPDATE listing_intents
      SET status = 'created', error = @error, claim_token = NULL, claimed_at = NULL,
          updated_at = unixepoch()
      WHERE id = @id AND status = 'submitting' AND claim_token = @token
    `
    )
    .run({ id: args.id, token: args.token, error: args.error?.slice(0, 500) ?? null });
  return result.changes === 1;
}

export function markListingDelisted(inscriptionId: string, listingId: string): void {
  getDb()
    .prepare(
      `
      UPDATE listing_intents
      SET status = 'delisted', preflight_json = NULL, unsigned_psbt_hashes_json = NULL,
          error = NULL, claim_token = NULL, claimed_at = NULL, updated_at = unixepoch()
      WHERE inscription_id = ? AND listing_id = ? AND status IN ('active','pending_indexing')
    `
    )
    .run(inscriptionId, listingId);
}

export function upsertConfirmedOrdnetListing(args: {
  inscriptionNumber: number;
  inscriptionId: string;
  listingId: string;
  priceSats: number;
  seller: string;
  listedAt: number;
}): void {
  getDb()
    .prepare(
      `
      INSERT INTO active_listings (
        inscription_number, inscription_id, satflow_id, price_sats,
        seller, marketplace, listed_at, refreshed_at
      ) VALUES (
        @inscription_number, @inscription_id, @listing_id, @price_sats,
        @seller, 'ord.net', @listed_at, unixepoch()
      )
      ON CONFLICT(marketplace, satflow_id) DO UPDATE SET
        inscription_number = excluded.inscription_number,
        inscription_id = excluded.inscription_id,
        price_sats = excluded.price_sats,
        seller = excluded.seller,
        listed_at = excluded.listed_at,
        refreshed_at = excluded.refreshed_at
    `
    )
    .run({
      inscription_number: args.inscriptionNumber,
      inscription_id: args.inscriptionId,
      listing_id: args.listingId,
      price_sats: args.priceSats,
      seller: args.seller,
      listed_at: args.listedAt,
    });
}

export function deleteConfirmedOrdnetListing(inscriptionId: string, listingId: string): void {
  getDb()
    .prepare(
      `DELETE FROM active_listings
       WHERE marketplace = 'ord.net' AND inscription_id = ? AND satflow_id = ?`
    )
    .run(inscriptionId, listingId);
}

function listListingsForInscriptionNumbers(numbers: number[]): ActiveListingDbRow[] {
  if (numbers.length === 0) return [];
  const placeholders = numbers.map(() => '?').join(',');
  return getDb()
    .prepare(
      `
      SELECT al.*,
             (SELECT li.created_at + li.duration_days * 86400
                FROM listing_intents li
               WHERE li.listing_id = al.satflow_id
               ORDER BY li.id DESC LIMIT 1) AS expires_at
      FROM active_listings al
      WHERE al.inscription_number IN (${placeholders})
      ORDER BY al.inscription_number ASC, al.listed_at DESC
    `
    )
    .all(...numbers) as ActiveListingDbRow[];
}

function sellerOmbFromRow(
  row: SellerInscriptionRow,
  listings: SellerListingSummary[],
  liveIntent: LiveListingIntent | null
): SellerOmb {
  const lookup = lookupInscription(row.inscription_number);
  const hasOrdnetListing = listings.some(
    item => normalizeMarketplace(item.marketplace) === 'ordnet'
  );
  const hasOtherListing = listings.some(
    item => normalizeMarketplace(item.marketplace) !== 'ordnet'
  );
  const code = !row.inscription_id
    ? 'missing-inscription-id'
    : !row.current_output
      ? 'missing-output'
      : row.active_loan_count > 0
        ? 'active-loan'
        : liveIntent && liveIntent.status !== 'created'
          ? 'listing-pending'
          : hasOrdnetListing
            ? 'listed-ordnet'
            : hasOtherListing
              ? 'listed-elsewhere'
              : 'listable';
  const reasons = {
    'missing-inscription-id': 'Waiting for the inscription index to catch up.',
    'missing-output': 'Waiting for current ownership data.',
    'active-loan': 'This OMB is currently in a loan.',
    'listed-ordnet': 'This OMB is already listed on ord.net.',
    'listing-pending': 'A listing for this OMB is being prepared or indexed.',
    'listed-elsewhere': 'Cancel the existing marketplace listing first.',
    listable: null,
  } as const;
  return {
    inscription_number: row.inscription_number,
    inscription_id: row.inscription_id ?? '',
    current_output: row.current_output ?? '',
    current_owner: row.current_owner ?? '',
    color: row.color,
    thumbnail: lookup?.thumbnail ?? '',
    full: lookup?.full ?? '',
    description: lookup?.description ?? '',
    active_loan: row.active_loan_count > 0,
    listings,
    listable: code === 'listable',
    listability_code: code,
    listability_reason: reasons[code],
    listing_intent_status: liveIntent?.status ?? null,
  };
}

function listLiveIntentsForInscriptionNumbers(
  numbers: number[],
  seller: string
): LiveListingIntent[] {
  if (numbers.length === 0) return [];
  const placeholders = numbers.map(() => '?').join(',');
  return getDb()
    .prepare(
      `
      SELECT inscription_number, listing_id, price_sats, seller_ord_addr,
             created_at, duration_days, status
      FROM listing_intents
      WHERE seller_ord_addr = ?
        AND inscription_number IN (${placeholders})
        AND status IN ('created','submitting','pending_indexing')
      ORDER BY created_at DESC, id DESC
    `
    )
    .all(seller, ...numbers) as LiveListingIntent[];
}

function normalizeMarketplace(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, '');
}
