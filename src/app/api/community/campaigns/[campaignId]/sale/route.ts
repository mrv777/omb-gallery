import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import type { CommunityVaultPolicyV1 } from '@drey/core/domain/community-vault/contracts';
import type { CommunityVaultSalePlanV1 } from '@drey/core/domain/community-vault/sale-contracts';
import type { CreateSaleOfferPayloadV1 } from '@/lib/community-purchases/contracts';
import {
  authenticatedCommunityAction,
  communityErrorResponse,
  communityRateLimit,
  requireCommunityBuyerSession,
  requireCommunityEnabled,
} from '@/lib/community-purchases/api';
import {
  prepareCommunitySaleOffer,
  refreshCommunitySalePlanPreflight,
} from '@/lib/community-purchases/saleOffers';
import { publishCommunitySale, refreshCommunitySale } from '@/lib/community-purchases/saleStore';
import { CommunityPurchaseError } from '@/lib/community-purchases/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ campaignId: string }> }
) {
  const disabled = requireCommunityEnabled();
  if (disabled) return disabled;
  const limited = communityRateLimit(request, 'sale-refresh', 20, 200);
  if (limited) return limited;
  try {
    requireCommunityBuyerSession(request);
    const { campaignId } = await context.params;
    return NextResponse.json(
      { campaign: await refreshCommunitySale({ campaignId }) },
      { headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (error) {
    return communityErrorResponse(error);
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ campaignId: string }> }
) {
  const disabled = requireCommunityEnabled();
  if (disabled) return disabled;
  const limited = communityRateLimit(request, 'sale-offer', 5, 30);
  if (limited) return limited;
  try {
    const session = requireCommunityBuyerSession(request);
    const { campaignId } = await context.params;
    const body = (await request.json().catch(() => null)) as {
      action?: unknown;
      gross_offer_sats?: unknown;
      duration_hours?: unknown;
      payload?: CreateSaleOfferPayloadV1;
      signature?: unknown;
      policy?: unknown;
      plan?: unknown;
      buyer_funded_psbt?: unknown;
    } | null;
    if (body?.action === 'prepare') {
      if (typeof body.gross_offer_sats !== 'string' || typeof body.duration_hours !== 'number') {
        throw new CommunityPurchaseError(
          'offer-request-invalid',
          'Enter an offer amount and duration.'
        );
      }
      const prepared = await prepareCommunitySaleOffer({
        campaignId,
        session,
        grossOfferSats: body.gross_offer_sats,
        durationHours: body.duration_hours,
      });
      return NextResponse.json(
        { offer: prepared },
        { headers: { 'Cache-Control': 'private, no-store' } }
      );
    }
    if (body?.action !== 'publish') {
      throw new CommunityPurchaseError('offer-action-invalid', 'Choose an offer action.');
    }
    const action = authenticatedCommunityAction<CreateSaleOfferPayloadV1>(request, body);
    const policy = body.policy as CommunityVaultPolicyV1 | undefined;
    const plan = body.plan as CommunityVaultSalePlanV1 | undefined;
    if (!policy || !plan || typeof body.buyer_funded_psbt !== 'string') {
      throw new CommunityPurchaseError(
        'offer-package-invalid',
        'The funded offer package is incomplete.'
      );
    }
    const psbtBytes = decodeBase64(body.buyer_funded_psbt);
    validatePublishPayload({
      payload: action.payload,
      campaignId,
      walletAddress: action.walletAddress,
      plan,
      psbtBytes,
    });
    const preflight = await refreshCommunitySalePlanPreflight({ policy, plan });
    const campaign = publishCommunitySale({
      campaignId,
      policy,
      plan,
      preflight,
      buyerFundedPsbtHex: psbtBytes.toString('hex'),
      buyerAuthorization: {
        walletAddress: action.walletAddress,
        payload: action.payload,
        signature: action.signature,
      },
    });
    return NextResponse.json(
      { campaign },
      { status: 201, headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (error) {
    return communityErrorResponse(error);
  }
}

function validatePublishPayload(args: {
  payload: CreateSaleOfferPayloadV1;
  campaignId: string;
  walletAddress: string;
  plan: CommunityVaultSalePlanV1;
  psbtBytes: Buffer;
}) {
  const now = Math.floor(Date.now() / 1_000);
  const payload = args.payload;
  if (
    payload.protocol !== 'omb-community-purchases' ||
    payload.version !== 1 ||
    payload.network !== 'mainnet' ||
    payload.action !== 'create-sale-offer' ||
    payload.campaignId !== args.campaignId ||
    payload.buyerDestinationAddress !== args.walletAddress ||
    payload.buyerId !== args.plan.buyerId ||
    payload.buyerDestinationAddress !== args.plan.buyerDestinationAddress ||
    payload.offerDigest !== args.plan.offerDigest ||
    payload.grossOfferSats !== args.plan.grossOfferSats ||
    payload.offerExpiresAtMs !== args.plan.expiresAtMs ||
    payload.signedPsbtHash !== createHash('sha256').update(args.psbtBytes).digest('hex') ||
    !Number.isInteger(payload.createdAt) ||
    !Number.isInteger(payload.expiresAt) ||
    payload.createdAt > now + 60 ||
    payload.expiresAt < now ||
    payload.expiresAt - payload.createdAt > 15 * 60 ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(payload.nonce)
  ) {
    throw new CommunityPurchaseError(
      'offer-signature-binding-invalid',
      'The signed offer no longer matches the exact Drey transaction.',
      409
    );
  }
}

function decodeBase64(value: string): Buffer {
  if (value.length === 0 || value.length > 3_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new CommunityPurchaseError(
      'offer-psbt-invalid',
      'Drey returned an invalid offer package.'
    );
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0) {
    throw new CommunityPurchaseError(
      'offer-psbt-invalid',
      'Drey returned an invalid offer package.'
    );
  }
  return decoded;
}
