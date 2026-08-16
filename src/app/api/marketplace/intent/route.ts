import { NextRequest, NextResponse } from 'next/server';
import {
  BUYER_COOKIE_NAME,
  ORDNET_SESSION_COOKIE_NAME,
  parseBuyerSession,
  parseOrdnetBuyerSession,
} from '@/lib/buyerSession';
import { createBuyIntent, markIntentFailed } from '@/lib/marketplace/buyIntentsStore';
import {
  getMarketplaceListing,
  marketplaceFixtureListingsEnabled,
  marketplaceMockEnabled,
} from '@/lib/marketplace/listings';
import { marketplaceRateLimit, requireMarketplaceEnabled } from '@/lib/marketplace/apiGuards';
import { mockIntentResponse, mockListing } from '@/lib/marketplace/mock';
import {
  createOrdnetPurchaseIntent,
  ordnetErrorResponse,
  type OrdnetPurchaseIntent,
} from '@/lib/ordnet';
import {
  createSatflowPurchaseIntent,
  satflowBuyErrorResponse,
  type SatflowPurchaseIntent,
} from '@/lib/marketplace/satflowBuy';
import { withOrdnetDreyContext, withSatflowDreyContexts } from '@/lib/marketplace/dreyContext';
import type { PurchasePsbtToSign } from '@/lib/marketplace/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Body = {
  inscription_number?: unknown;
  marketplace?: unknown;
  listing_id?: unknown;
  provider_id?: unknown;
};

export async function POST(req: NextRequest) {
  const disabled = requireMarketplaceEnabled();
  if (disabled) return disabled;

  const session = parseBuyerSession(req.cookies.get(BUYER_COOKIE_NAME)?.value);
  if (!session) return NextResponse.json({ error: 'connect wallet first' }, { status: 401 });
  if (!session.accepted_terms_at) {
    return NextResponse.json({ error: 'terms acceptance required' }, { status: 428 });
  }
  const limited = marketplaceRateLimit(req, 'intent', 6, 80);
  if (limited) return limited;

  const body = (await req.json().catch(() => null)) as Body | null;
  const inscriptionNumber =
    body && typeof body.inscription_number === 'number'
      ? Math.trunc(body.inscription_number)
      : Number.NaN;
  if (!Number.isFinite(inscriptionNumber)) {
    return NextResponse.json({ error: 'invalid inscription number' }, { status: 400 });
  }
  const marketplace = typeof body?.marketplace === 'string' ? body.marketplace : null;
  const listingId = typeof body?.listing_id === 'string' ? body.listing_id : null;
  if ((marketplace && !listingId) || (!marketplace && listingId)) {
    return NextResponse.json(
      { error: 'marketplace and listing_id must be provided together' },
      { status: 400 }
    );
  }
  const requestedSource = marketplace && listingId ? { marketplace, listingId } : undefined;
  const wantsDreyContext = body?.provider_id === 'drey';

  const mockPurchase = marketplaceMockEnabled();
  const listing = marketplaceFixtureListingsEnabled()
    ? mockListing(inscriptionNumber)
    : getMarketplaceListing(inscriptionNumber, requestedSource);
  if (!listing) {
    return NextResponse.json(
      { error: 'listing unavailable or already sold', code: 'listing-stale' },
      { status: 409 }
    );
  }

  if (mockPurchase) {
    const intentId = createBuyIntent({
      inscription_id: listing.inscription_id,
      inscription_number: listing.inscription_number,
      buyer_ord_addr: session.ord_addr,
      buyer_pay_addr: session.pay_addr,
      marketplace: listing.marketplace,
      price_sats: listing.price_sats,
      is_mock: true,
    });
    return NextResponse.json(mockIntentResponse({ intentId, listing }));
  }

  let intentId: number | null = null;
  try {
    const marketplaceKey = listing.marketplace.toLowerCase();
    const intent =
      marketplaceKey === 'ord.net' || marketplaceKey === 'ordnet'
        ? await createOrdnetIntent(req, listing, session)
        : await createSatflowPurchaseIntent({
            listing,
            buyerOrdAddr: session.ord_addr,
            buyerPayAddr: session.pay_addr,
            buyerOrdPubkey: session.ord_pubkey,
            buyerPayPubkey: session.pay_pubkey,
          });
    const maybePreflightJson = (intent as unknown as { preflightJson?: unknown }).preflightJson;
    const maybePsbts = (
      intent as unknown as {
        psbts?: Array<{ psbt: string; sign_inputs?: Record<string, number[]>; label?: string }>;
      }
    ).psbts;
    const maybeStep = (intent as unknown as { step?: unknown }).step;
    const preflightJson = typeof maybePreflightJson === 'string' ? maybePreflightJson : null;
    intentId = createBuyIntent({
      inscription_id: listing.inscription_id,
      inscription_number: listing.inscription_number,
      buyer_ord_addr: session.ord_addr,
      buyer_pay_addr: session.pay_addr,
      marketplace: listing.marketplace,
      listing_id: listing.listing_id,
      price_sats: listing.price_sats,
      preflight_json: preflightJson,
      is_mock: false,
    });
    const basePsbts: PurchasePsbtToSign[] =
      maybePsbts && maybePsbts.length > 0
        ? maybePsbts
        : [
            {
              psbt: intent.psbt,
              sign_inputs: intent.signInputs,
              label: typeof maybeStep === 'string' ? maybeStep : undefined,
            },
          ];
    const responsePsbts = wantsDreyContext
      ? isOrdnetMarketplace(listing.marketplace)
        ? [
            withOrdnetDreyContext({
              item: basePsbts[0]!,
              intentId,
              listing,
              buyerOrdAddr: session.ord_addr,
              buyerPayAddr: session.pay_addr,
              purchaseAnchorUtxoId: (intent as OrdnetPurchaseIntent).raw.purchaseAnchorUtxoId,
              expectedTxids: [
                (intent as OrdnetPurchaseIntent).raw.expectedSettlementTxid,
                ...(intent as OrdnetPurchaseIntent).raw.expectedListingTransferTxids,
              ],
            }),
          ]
        : withSatflowDreyContexts({
            psbts: basePsbts,
            intentId,
            listing,
            buyerOrdAddr: session.ord_addr,
            buyerPayAddr: session.pay_addr,
            stage: (intent as SatflowPurchaseIntent).secureStage,
            preflightJson: preflightJson ?? '',
          })
      : toWirePsbts(maybePsbts);
    return NextResponse.json({
      intent_id: intentId,
      psbt: intent.psbt,
      sign_inputs: intent.signInputs,
      psbts: responsePsbts,
      step: typeof maybeStep === 'string' ? maybeStep : undefined,
      listing,
      mock: false,
    });
  } catch (err) {
    if (err instanceof OrdnetAuthRequiredError) {
      return NextResponse.json(
        { error: err.message, code: 'ordnet-auth-required' },
        { status: 428 }
      );
    }
    const mapped = isOrdnetMarketplace(listing.marketplace)
      ? ordnetErrorResponse(err)
      : satflowBuyErrorResponse(err);
    if (intentId != null) markIntentFailed(intentId, mapped.message);
    const quote = 'quote' in mapped ? mapped.quote : undefined;
    return NextResponse.json(
      { error: mapped.message, ...(quote ? { quote } : {}) },
      { status: mapped.status }
    );
  }
}

function toWirePsbts(psbts: PurchasePsbtToSign[] | undefined) {
  return psbts && psbts.length > 0 ? psbts : undefined;
}

class OrdnetAuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrdnetAuthRequiredError';
  }
}

function isOrdnetMarketplace(marketplace: string): boolean {
  const key = marketplace.toLowerCase();
  return key === 'ord.net' || key === 'ordnet';
}

async function createOrdnetIntent(
  req: NextRequest,
  listing: NonNullable<ReturnType<typeof getMarketplaceListing>>,
  session: NonNullable<ReturnType<typeof parseBuyerSession>>
) {
  const ordnetSession = parseOrdnetBuyerSession(req.cookies.get(ORDNET_SESSION_COOKIE_NAME)?.value);
  if (
    !ordnetSession ||
    ordnetSession.ord_addr !== session.ord_addr ||
    ordnetSession.pay_addr !== session.pay_addr
  ) {
    throw new OrdnetAuthRequiredError('ORD.NET wallet authorization required.');
  }
  return createOrdnetPurchaseIntent({
    listing,
    buyerPayAddr: session.pay_addr,
    buyerPayPubkey: session.pay_pubkey,
    ordnetSession,
  });
}
