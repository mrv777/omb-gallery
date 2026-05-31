import { NextRequest, NextResponse } from 'next/server';
import { getStmts, type EventRow, type InscriptionRow } from '@/lib/db';
import { estimateLoanExpiration, type LoanExpirationEstimate } from '@/lib/loanExpiration';
import { getMarketplaceListing } from '@/lib/marketplace/listings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest, ctx: { params: Promise<{ number: string }> }) {
  const { number: numStr } = await ctx.params;
  const num = parseInt(numStr, 10);
  if (!Number.isFinite(num)) {
    return NextResponse.json({ error: 'invalid inscription number' }, { status: 400 });
  }
  const collection = new URL(req.url).searchParams.get('collection') || 'omb';

  const stmts = getStmts();
  // 404 covers two cases: number doesn't exist, or it exists in a different
  // collection than the one requested. Both are "not found" from the caller's
  // perspective — they get redirected/told to check the collection.
  const inscription = stmts.getInscription.get({
    inscription_number: num,
    collection,
  }) as InscriptionRow | undefined;
  if (!inscription) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const events = stmts.getInscriptionEvents.all(num) as EventRow[];
  const listing = collection === 'omb' ? getMarketplaceListing(num) : null;

  // For an inscription with an open loan, look up the most recent
  // origination's lender_addr + block_timestamp from the events list and
  // attach an estimated expiration. The events array is already loaded so we
  // don't need an extra DB hit.
  let active_loan_estimate:
    | (LoanExpirationEstimate & { started_at: number; lender_vault: string | null })
    | null = null;
  if ((inscription.active_loan_count ?? 0) > 0) {
    const lastOrig = [...events]
      .filter(e => e.event_type === 'loan-originated')
      .sort((a, b) => b.id - a.id)[0];
    if (lastOrig && typeof lastOrig.block_timestamp === 'number') {
      let lender: string | null = null;
      try {
        const rj = JSON.parse(lastOrig.raw_json ?? 'null') as { lender_addr?: unknown };
        if (typeof rj?.lender_addr === 'string') lender = rj.lender_addr;
      } catch {
        // raw_json shouldn't be malformed here, but we never want to 500 the
        // detail page over a parse fluke — fall back to the global estimate.
      }
      const est = estimateLoanExpiration({
        originationTs: lastOrig.block_timestamp,
        lenderVault: lender,
      });
      if (est) {
        active_loan_estimate = {
          ...est,
          started_at: lastOrig.block_timestamp,
          lender_vault: lender,
        };
      }
    }
  }

  return NextResponse.json({
    inscription,
    events,
    current_listing: listing ? listingOptionToApiRow(listing, listing.options[0]!) : null,
    current_listings: listing
      ? listing.options.map(option => listingOptionToApiRow(listing, option))
      : [],
    active_loan_estimate,
  });
}

function listingOptionToApiRow(
  listing: NonNullable<ReturnType<typeof getMarketplaceListing>>,
  option: NonNullable<ReturnType<typeof getMarketplaceListing>>['options'][number]
) {
  return {
    inscription_number: listing.inscription_number,
    inscription_id: listing.inscription_id,
    satflow_id: option.satflow_id,
    listing_id: option.listing_id,
    price_sats: option.price_sats,
    seller: option.seller,
    marketplace: option.marketplace,
    listed_at: option.listed_at,
    refreshed_at: option.refreshed_at,
  };
}
