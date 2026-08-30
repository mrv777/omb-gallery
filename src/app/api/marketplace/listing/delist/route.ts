import { NextRequest, NextResponse } from 'next/server';
import {
  BUYER_COOKIE_NAME,
  ORDNET_SESSION_COOKIE_NAME,
  parseBuyerSession,
  parseOrdnetBuyerSession,
} from '@/lib/buyerSession';
import {
  deleteConfirmedOrdnetListing,
  getSellerInscriptionById,
  listActiveListingsForInscription,
  markListingDelisted,
} from '@/lib/marketplace/listingIntentsStore';
import {
  marketplaceRateLimit,
  ordnetSellerProfileRateLimit,
  requireExactOrigin,
  requireMarketplaceEnabled,
  requireMarketplaceSellingEnabled,
} from '@/lib/marketplace/apiGuards';
import {
  OrdnetError,
  delistOrdnetListing,
  fetchOrdnetSellerListings,
  ordnetErrorResponse,
  type OrdnetListing,
} from '@/lib/ordnet';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Body = { inscription_id?: unknown; listing_id?: unknown };

export async function POST(req: NextRequest) {
  const disabled = requireMarketplaceEnabled() ?? requireMarketplaceSellingEnabled();
  if (disabled) return disabled;
  const wrongOrigin = requireExactOrigin(req);
  if (wrongOrigin) return wrongOrigin;
  const session = parseBuyerSession(req.cookies.get(BUYER_COOKIE_NAME)?.value);
  if (!session) return sellerError('connect wallet first', 'auth-required', 401);
  if (!session.accepted_terms_at) {
    return sellerError('terms acceptance required', 'terms-required', 428);
  }
  const ordnetSession = parseOrdnetBuyerSession(req.cookies.get(ORDNET_SESSION_COOKIE_NAME)?.value);
  if (
    !ordnetSession ||
    ordnetSession.ord_addr !== session.ord_addr ||
    ordnetSession.pay_addr !== session.pay_addr
  ) {
    return sellerError('ORD.NET wallet authorization required.', 'auth-required', 428);
  }
  const body = (await req.json().catch(() => null)) as Body | null;
  const inscriptionId = cleanIdentifier(body?.inscription_id, 128);
  const listingId = cleanIdentifier(body?.listing_id, 128);
  if (!inscriptionId || !listingId) {
    return sellerError('inscription_id and listing_id are required', 'invalid-request', 400);
  }
  const indexed = findSellerInscriptionById(inscriptionId, session.ord_addr);
  if (!indexed) return sellerError('on-chain ownership changed', 'stale-ownership', 409);
  const local = listActiveListingsForInscription(indexed.inscription_number).find(
    listing =>
      listing.inscription_id === inscriptionId &&
      listing.satflow_id === listingId &&
      listing.seller === session.ord_addr &&
      normalizeMarketplace(listing.marketplace) === 'ordnet'
  );
  if (!local) {
    return sellerError('ord.net listing not found for this seller', 'existing-listing', 404);
  }
  const ipLimited = marketplaceRateLimit(req, 'ordnet-seller-write', 15, 300);
  if (ipLimited) return rateError(ipLimited);
  const profileLimited = ordnetSellerProfileRateLimit(session.ord_addr);
  if (profileLimited) return profileLimited;

  try {
    const before = await fetchExactListing({
      sessionToken: ordnetSession.session_token,
      inscriptionId,
      listingId,
      seller: session.ord_addr,
    });
    if (!before) {
      persistAbsent(inscriptionId, listingId);
      return NextResponse.json({
        inscription_id: inscriptionId,
        listing_id: listingId,
        status: 'absent',
      });
    }
    await delistOrdnetListing({
      inscriptionId,
      listingId,
      walletBindingId: ordnetSession.wallet_binding_id,
      sessionToken: ordnetSession.session_token,
    });
    const after = await fetchExactListing({
      sessionToken: ordnetSession.session_token,
      inscriptionId,
      listingId,
      seller: session.ord_addr,
    }).catch(() => before);
    if (!after) {
      persistAbsent(inscriptionId, listingId);
      return NextResponse.json({
        inscription_id: inscriptionId,
        listing_id: listingId,
        status: 'absent',
      });
    }
    return NextResponse.json({
      inscription_id: inscriptionId,
      listing_id: listingId,
      status: 'pending_removal',
    });
  } catch (error) {
    if (error instanceof OrdnetError && error.status === 401) {
      return sellerError('ORD.NET wallet authorization expired.', 'auth-required', 428);
    }
    if (error instanceof OrdnetError && error.status === 429) {
      return sellerError(error.message, 'rate-limit', 429);
    }
    if (error instanceof OrdnetError && (error.status === 409 || isAmbiguous(error))) {
      const remaining = await fetchExactListing({
        sessionToken: ordnetSession.session_token,
        inscriptionId,
        listingId,
        seller: session.ord_addr,
      }).catch(() => undefined);
      if (remaining === null) {
        persistAbsent(inscriptionId, listingId);
        return NextResponse.json({
          inscription_id: inscriptionId,
          listing_id: listingId,
          status: 'absent',
          reconciled: true,
        });
      }
      if (error.status === 409 && remaining) {
        return sellerError('listing state changed; refresh and try again', 'stale-preflight', 409);
      }
      return sellerError(
        'ORD.NET may have received the delist; refresh before trying again.',
        'ambiguous-upstream-state',
        502
      );
    }
    const mapped = ordnetErrorResponse(error);
    return sellerError(mapped.message, 'invalid-request', mapped.status);
  }
}

function findSellerInscriptionById(inscriptionId: string, seller: string) {
  return getSellerInscriptionById(inscriptionId, seller);
}

async function fetchExactListing(args: {
  sessionToken: string;
  inscriptionId: string;
  listingId: string;
  seller: string;
}): Promise<OrdnetListing | null> {
  const page = await fetchOrdnetSellerListings({
    sessionToken: args.sessionToken,
    inscriptionId: args.inscriptionId,
    sellerAddress: args.seller,
    limit: 20,
  });
  return (
    page.items.find(
      listing => listing.listing_id === args.listingId && listing.seller === args.seller
    ) ?? null
  );
}

function persistAbsent(inscriptionId: string, listingId: string) {
  deleteConfirmedOrdnetListing(inscriptionId, listingId);
  markListingDelisted(inscriptionId, listingId);
}

function cleanIdentifier(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function normalizeMarketplace(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function isAmbiguous(error: OrdnetError) {
  return error.status == null || error.status >= 500;
}

function sellerError(message: string, code: string, status: number) {
  return NextResponse.json(
    { error: message, code },
    { status, headers: { 'Cache-Control': 'private, no-store' } }
  );
}

function rateError(response: NextResponse) {
  const retryAfter = response.headers.get('retry-after') ?? '60';
  return NextResponse.json(
    { error: 'rate limited', code: 'rate-limit', retry_after_sec: Number(retryAfter) },
    { status: 429, headers: { 'retry-after': retryAfter } }
  );
}
