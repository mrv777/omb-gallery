import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  BUYER_COOKIE_NAME,
  ORDNET_SESSION_COOKIE_NAME,
  parseBuyerSession,
  parseOrdnetBuyerSession,
} from '@/lib/buyerSession';
import {
  claimListingIntent,
  finishListingIntent,
  getListingIntent,
  getSellerInscription,
  listActiveListingsForInscription,
  releaseListingIntent,
  upsertConfirmedOrdnetListing,
} from '@/lib/marketplace/listingIntentsStore';
import {
  ListingPsbtValidationError,
  assertSignedPsbtPreservesPreflight,
  unsignedPsbtHash,
} from '@/lib/marketplace/listingPsbt';
import {
  marketplaceRateLimit,
  ordnetSellerProfileRateLimit,
  requireExactOrigin,
  requireMarketplaceEnabled,
  requireMarketplaceSellingEnabled,
} from '@/lib/marketplace/apiGuards';
import { parseOrdnetSellerProvider } from '@/lib/marketplace/sellerTypes';
import { OrdError, fetchInscriptionDetail, fetchOutputsBatch } from '@/lib/ord';
import {
  OrdnetError,
  fetchOrdnetSellerListings,
  ordnetErrorResponse,
  parseStoredOrdnetListingPreflight,
  submitOrdnetListing,
  type OrdnetListing,
} from '@/lib/ordnet';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Body = { intent_id?: unknown; signed_psbts?: unknown; provider_id?: unknown };

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
  const intentId =
    typeof body?.intent_id === 'number' &&
    Number.isSafeInteger(body.intent_id) &&
    body.intent_id > 0
      ? body.intent_id
      : null;
  const signedPsbts = Array.isArray(body?.signed_psbts)
    ? body.signed_psbts.filter(
        (item): item is string => typeof item === 'string' && item.length > 0
      )
    : [];
  const provider = parseOrdnetSellerProvider(body?.provider_id);
  if (intentId == null || signedPsbts.length !== 3 || !provider) {
    return sellerError(
      'intent_id, provider_id, and exactly three signed_psbts are required',
      'invalid-request',
      400
    );
  }
  if (signedPsbts.some(psbt => psbt.length > 2_000_000)) {
    return sellerError('signed PSBT is too large', 'invalid-request', 413);
  }
  const intent = getListingIntent(intentId);
  if (!intent || intent.seller_ord_addr !== session.ord_addr) {
    return sellerError('listing intent not found', 'stale-preflight', 404);
  }
  if (intent.provider_id !== provider) {
    return sellerError('wallet provider changed during signing', 'unsupported-wallet', 409);
  }
  if (intent.status === 'active' || intent.status === 'pending_indexing') {
    return NextResponse.json({
      intent_id: intent.id,
      listing_id: intent.listing_id,
      status: intent.status,
    });
  }
  if (intent.status === 'ambiguous') {
    return sellerError(
      'ORD.NET may already have received this listing.',
      'ambiguous-upstream-state',
      409
    );
  }
  if (intent.status !== 'created' && intent.status !== 'submitting') {
    return sellerError('listing preflight is no longer usable', 'stale-preflight', 409);
  }
  if (
    intent.wallet_binding_id !== ordnetSession.wallet_binding_id ||
    intent.seller_pay_addr !== session.pay_addr
  ) {
    return sellerError('ORD.NET wallet authorization changed.', 'auth-required', 428);
  }
  const ipLimited = marketplaceRateLimit(req, 'ordnet-seller-write', 15, 300);
  if (ipLimited) return rateError(ipLimited);
  const profileLimited = ordnetSellerProfileRateLimit(session.ord_addr);
  if (profileLimited) return profileLimited;

  const claimToken = randomUUID();
  if (!claimListingIntent(intent.id, claimToken)) {
    return NextResponse.json(
      { error: 'This listing is already being submitted.', code: 'stale-preflight' },
      { status: 409, headers: { 'Retry-After': '2' } }
    );
  }

  const stored = parseStoredOrdnetListingPreflight(intent.preflight_json);
  const indexed = getSellerInscription(intent.inscription_number, session.ord_addr);
  if (
    !stored ||
    stored.createdAt < Math.floor(Date.now() / 1000) - 5 * 60 ||
    stored.request.walletBindingId !== intent.wallet_binding_id ||
    stored.request.items[0]?.inscriptionId !== intent.inscription_id ||
    stored.request.items[0]?.priceSats !== intent.price_sats ||
    stored.durationDays !== intent.duration_days ||
    !indexed ||
    indexed.inscription_id !== intent.inscription_id ||
    indexed.current_output !== intent.current_output ||
    indexed.active_loan_count > 0 ||
    listActiveListingsForInscription(intent.inscription_number).length > 0
  ) {
    finishListingIntent({
      id: intent.id,
      token: claimToken,
      status: 'stale',
      error: 'listing preflight expired or ownership changed',
      clearPreflight: true,
    });
    return sellerError('listing details changed; start again', 'stale-preflight', 409);
  }

  try {
    await assertFreshOnChainOwnership({
      inscriptionId: intent.inscription_id,
      inscriptionNumber: intent.inscription_number,
      currentOutput: intent.current_output,
      seller: intent.seller_ord_addr,
    });
    const unsigned = [
      stored.response.listings[0]!.psbts[0]!,
      stored.response.listings[0]!.psbts[1]!,
      stored.response.recoveryPsbt,
    ];
    const expectedHashes = parseHashList(intent.unsigned_psbt_hashes_json);
    for (let index = 0; index < 3; index += 1) {
      const source = unsigned[index]!;
      const actualHash = unsignedPsbtHash(source.psbtBase64);
      if (expectedHashes[index] !== actualHash) {
        throw new ListingPsbtValidationError('Stored preflight PSBT hash changed.');
      }
      assertSignedPsbtPreservesPreflight({
        unsignedPsbt: source.psbtBase64,
        signedPsbt: signedPsbts[index]!,
        selectedInputIndexes: source.inputsToSign.flatMap(input => input.signingIndexes),
      });
    }

    const submitted = await submitOrdnetListing({
      stored,
      signedPsbts: signedPsbts as [string, string, string],
      sessionToken: ordnetSession.session_token,
    });
    const confirmed = await reconcileCreatedListing({
      sessionToken: ordnetSession.session_token,
      seller: session.ord_addr,
      inscriptionId: intent.inscription_id,
      listingId: submitted.listingId,
      priceSats: intent.price_sats,
    }).catch(() => null);
    if (confirmed) persistConfirmed(intent, confirmed);
    finishListingIntent({
      id: intent.id,
      token: claimToken,
      status: confirmed ? 'active' : 'pending_indexing',
      listingId: submitted.listingId,
      clearPreflight: true,
    });
    return NextResponse.json({
      intent_id: intent.id,
      listing_id: submitted.listingId,
      status: confirmed ? 'active' : 'pending_indexing',
    });
  } catch (error) {
    if (error instanceof OrdError) {
      releaseListingIntent({ id: intent.id, token: claimToken, error: error.message });
      return sellerError(
        'Could not re-verify on-chain ownership. Retry this signed submission shortly.',
        'stale-ownership',
        503
      );
    }
    if (error instanceof ListingPsbtValidationError) {
      finishListingIntent({
        id: intent.id,
        token: claimToken,
        status: 'stale',
        error: error.message,
        clearPreflight: true,
      });
      return sellerError(error.message, 'stale-preflight', 409);
    }
    if (error instanceof OrdnetError && error.status === 401) {
      releaseListingIntent({ id: intent.id, token: claimToken, error: error.message });
      return sellerError('ORD.NET wallet authorization expired.', 'auth-required', 428);
    }
    if (error instanceof OrdnetError && error.status === 429) {
      releaseListingIntent({ id: intent.id, token: claimToken, error: error.message });
      return sellerError(error.message, 'rate-limit', 429);
    }
    if (error instanceof OrdnetError && error.status === 409) {
      finishListingIntent({
        id: intent.id,
        token: claimToken,
        status: 'stale',
        error: error.message,
        clearPreflight: true,
      });
      return sellerError('listing state changed; start again', 'stale-preflight', 409);
    }
    if (isAmbiguousOrdnetFailure(error)) {
      const reconciliation = await reconcileCreatedListingOutcome({
        sessionToken: ordnetSession.session_token,
        seller: session.ord_addr,
        inscriptionId: intent.inscription_id,
        priceSats: intent.price_sats,
      });
      if (reconciliation.ok && reconciliation.listing) {
        persistConfirmed(intent, reconciliation.listing);
        finishListingIntent({
          id: intent.id,
          token: claimToken,
          status: 'active',
          listingId: reconciliation.listing.listing_id,
          clearPreflight: true,
        });
        return NextResponse.json({
          intent_id: intent.id,
          listing_id: reconciliation.listing.listing_id,
          status: 'active',
          reconciled: true,
        });
      }
      if (reconciliation.ok) {
        finishListingIntent({
          id: intent.id,
          token: claimToken,
          status: 'stale',
          error: 'ORD.NET confirmed that no listing exists after submit failure.',
          clearPreflight: true,
        });
        return sellerError(
          'ORD.NET did not create the listing; start with a fresh preflight.',
          'stale-preflight',
          409
        );
      }
      finishListingIntent({
        id: intent.id,
        token: claimToken,
        status: 'ambiguous',
        error: error instanceof Error ? error.message : String(error),
        clearPreflight: true,
      });
      return sellerError(
        'ORD.NET may have received the listing; refresh before trying again.',
        'ambiguous-upstream-state',
        502
      );
    }
    const mapped = ordnetErrorResponse(error);
    finishListingIntent({
      id: intent.id,
      token: claimToken,
      status: 'failed',
      error: mapped.message,
      clearPreflight: true,
    });
    return sellerError(mapped.message, 'stale-preflight', mapped.status);
  }
}

async function reconcileCreatedListingOutcome(args: {
  sessionToken: string;
  seller: string;
  inscriptionId: string;
  priceSats: number;
}): Promise<{ ok: true; listing: OrdnetListing | null } | { ok: false }> {
  try {
    return { ok: true, listing: await reconcileCreatedListing(args) };
  } catch {
    return { ok: false };
  }
}

async function assertFreshOnChainOwnership(args: {
  inscriptionId: string;
  inscriptionNumber: number;
  currentOutput: string;
  seller: string;
}): Promise<void> {
  const detail = await fetchInscriptionDetail(args.inscriptionId);
  const offsetMatch = detail.satpoint
    ? /^[0-9a-f]{64}:(?:0|[1-9][0-9]*):((?:0|[1-9][0-9]*))$/iu.exec(detail.satpoint)
    : null;
  if (
    detail.inscription_id !== args.inscriptionId ||
    detail.inscription_number !== args.inscriptionNumber ||
    detail.address !== args.seller ||
    detail.output !== args.currentOutput ||
    !offsetMatch ||
    Number(offsetMatch[1]) !== 0
  ) {
    throw new ListingPsbtValidationError('On-chain ownership changed after preflight.');
  }
  const outputs = await fetchOutputsBatch([args.currentOutput]);
  const output = outputs.length === 1 ? outputs[0]! : null;
  if (
    !output ||
    output.outpoint !== args.currentOutput.toLowerCase() ||
    output.spent ||
    output.confirmations < 1 ||
    output.runeIds.length > 0 ||
    output.inscriptionIds.length !== 1 ||
    output.inscriptionIds[0] !== args.inscriptionId
  ) {
    throw new ListingPsbtValidationError('Inscription output is no longer safe to list.');
  }
}

async function reconcileCreatedListing(args: {
  sessionToken: string;
  seller: string;
  inscriptionId: string;
  listingId?: string;
  priceSats: number;
}): Promise<OrdnetListing | null> {
  const result = await fetchOrdnetSellerListings({
    sessionToken: args.sessionToken,
    inscriptionId: args.inscriptionId,
    sellerAddress: args.seller,
    limit: 20,
  });
  return (
    result.items.find(
      listing =>
        listing.inscription_id === args.inscriptionId &&
        listing.seller === args.seller &&
        listing.price_sats === args.priceSats &&
        (!args.listingId || listing.listing_id === args.listingId)
    ) ?? null
  );
}

function persistConfirmed(
  intent: NonNullable<ReturnType<typeof getListingIntent>>,
  listing: OrdnetListing
) {
  upsertConfirmedOrdnetListing({
    inscriptionNumber: intent.inscription_number,
    inscriptionId: intent.inscription_id,
    listingId: listing.listing_id,
    priceSats: listing.price_sats,
    seller: intent.seller_ord_addr,
    listedAt: listing.listed_at,
  });
}

function parseHashList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

function isAmbiguousOrdnetFailure(error: unknown): boolean {
  return error instanceof OrdnetError && (error.status == null || error.status >= 500);
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
