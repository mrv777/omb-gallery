import { NextRequest, NextResponse } from 'next/server';
import {
  BUYER_COOKIE_NAME,
  ORDNET_SESSION_COOKIE_NAME,
  parseBuyerSession,
  parseOrdnetBuyerSession,
} from '@/lib/buyerSession';
import { OrdError, fetchInscriptionDetail, fetchOutputsBatch } from '@/lib/ord';
import { OrdnetError, createOrdnetListingPreflight, ordnetErrorResponse } from '@/lib/ordnet';
import { withOrdnetListingDreyContexts } from '@/lib/marketplace/dreyContext';
import {
  createListingIntent,
  getSellerInscription,
  listActiveListingsForInscription,
} from '@/lib/marketplace/listingIntentsStore';
import {
  ListingPsbtValidationError,
  unsignedPsbtHash,
  validateOrdnetListingPreflight,
} from '@/lib/marketplace/listingPsbt';
import {
  marketplaceRateLimit,
  ordnetSellerProfileRateLimit,
  requireExactOrigin,
  requireMarketplaceEnabled,
  requireMarketplaceSellingEnabled,
} from '@/lib/marketplace/apiGuards';
import {
  parseListingPriceSats,
  parseOrdnetListingDuration,
  parseOrdnetSellerProvider,
  signingInputsByAddress,
  type OrdnetSellerSigningInput,
} from '@/lib/marketplace/sellerTypes';
import type { PurchasePsbtToSign } from '@/lib/marketplace/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Body = {
  inscription_number?: unknown;
  price_sats?: unknown;
  duration_days?: unknown;
  provider_id?: unknown;
};

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
  if (!session.pay_addr || !session.ord_pubkey) {
    return sellerError(
      'An ordinals public key and payment address are required.',
      'unsupported-wallet',
      428
    );
  }
  const body = (await req.json().catch(() => null)) as Body | null;
  const resolvedProvider = parseOrdnetSellerProvider(body?.provider_id);
  const inscriptionNumber =
    typeof body?.inscription_number === 'number' && Number.isSafeInteger(body.inscription_number)
      ? body.inscription_number
      : null;
  const priceSats = parseListingPriceSats(body?.price_sats);
  const durationDays = parseOrdnetListingDuration(body?.duration_days);
  if (inscriptionNumber == null || priceSats == null || durationDays == null) {
    return sellerError('invalid listing request', 'invalid-request', 400);
  }
  if (!resolvedProvider) {
    return sellerError('wallet is not supported for listing', 'unsupported-wallet', 400);
  }
  const ordnetSession = parseOrdnetBuyerSession(req.cookies.get(ORDNET_SESSION_COOKIE_NAME)?.value);
  if (
    !ordnetSession ||
    ordnetSession.ord_addr !== session.ord_addr ||
    ordnetSession.pay_addr !== session.pay_addr
  ) {
    return sellerError('ORD.NET wallet authorization required.', 'auth-required', 428);
  }
  const ipLimited = marketplaceRateLimit(req, 'ordnet-seller-write', 15, 300);
  if (ipLimited) return withRateCode(ipLimited);
  const profileLimited = ordnetSellerProfileRateLimit(session.ord_addr);
  if (profileLimited) return profileLimited;

  const indexed = getSellerInscription(inscriptionNumber, session.ord_addr);
  if (!indexed || !indexed.inscription_id || !indexed.current_output) {
    return sellerError('ownership data is stale', 'stale-ownership', 409);
  }
  if (indexed.active_loan_count > 0) {
    return sellerError('OMB is currently in a loan', 'unsafe-utxo', 409);
  }
  if (listActiveListingsForInscription(inscriptionNumber).length > 0) {
    return sellerError(
      'This OMB is already listed. Delist it before changing the price.',
      'existing-listing',
      409
    );
  }

  try {
    const detail = await fetchInscriptionDetail(indexed.inscription_id);
    if (
      detail.inscription_id !== indexed.inscription_id ||
      detail.inscription_number !== indexed.inscription_number ||
      detail.address !== session.ord_addr ||
      detail.output !== indexed.current_output
    ) {
      return sellerError('on-chain ownership changed', 'stale-ownership', 409);
    }
    if (!detail.satpoint || satpointOffset(detail.satpoint) !== 0) {
      return sellerError('inscription is not at offset zero', 'unsafe-utxo', 409);
    }
    const outputs = await fetchOutputsBatch([indexed.current_output]);
    const output = outputs.length === 1 ? outputs[0]! : null;
    if (
      !output ||
      output.outpoint !== indexed.current_output.toLowerCase() ||
      output.spent ||
      output.confirmations < 1 ||
      output.runeIds.length > 0 ||
      output.inscriptionIds.length !== 1 ||
      output.inscriptionIds[0] !== indexed.inscription_id
    ) {
      return sellerError(
        'The inscription output is spent, unconfirmed, shared, or contains runes.',
        'unsafe-utxo',
        409
      );
    }
    const postageSats = Number(output.valueSats);
    if (!Number.isSafeInteger(postageSats) || postageSats <= 0) {
      return sellerError('inscription postage is invalid', 'unsafe-utxo', 409);
    }

    const preflight = await createOrdnetListingPreflight({
      inscriptionId: indexed.inscription_id,
      priceSats,
      durationDays,
      ordinalsPublicKey: session.ord_pubkey,
      walletBindingId: ordnetSession.wallet_binding_id,
      sessionToken: ordnetSession.session_token,
    });
    const item = preflight.response.listings[0]!;
    const rawSigningSteps = [
      toSigningStep(item.psbts[0]!, 'escrow transfer'),
      toSigningStep(item.psbts[1]!, 'settlement authorization'),
      toSigningStep(preflight.response.recoveryPsbt, 'recovery transaction'),
    ];
    const validated = validateOrdnetListingPreflight({
      steps: rawSigningSteps,
      currentOutpoint: indexed.current_output,
      sellerOrdAddress: session.ord_addr,
      sellerPayAddress: session.pay_addr,
      sellerPublicKey: session.ord_pubkey,
      priceSats,
    });
    if (validated.postageSats !== postageSats) {
      return sellerError('ORD.NET preflight changed the inscription postage.', 'unsafe-utxo', 502);
    }
    const hashes = rawSigningSteps.map(step => unsignedPsbtHash(step.psbt));
    let intentId: number;
    try {
      intentId = createListingIntent({
        sellerOrdAddr: session.ord_addr,
        sellerPayAddr: session.pay_addr,
        inscriptionId: indexed.inscription_id,
        inscriptionNumber: indexed.inscription_number,
        currentOutput: indexed.current_output,
        priceSats,
        durationDays,
        providerId: resolvedProvider,
        walletBindingId: ordnetSession.wallet_binding_id,
        preflight,
        unsignedPsbtHashes: hashes,
      });
    } catch (error) {
      if (isUniqueConstraint(error)) {
        return sellerError('A listing attempt is already active.', 'existing-listing', 409);
      }
      throw error;
    }
    const signingSteps =
      resolvedProvider === 'drey'
        ? withOrdnetListingDreyContexts({
            psbts: rawSigningSteps,
            intentId,
            inscriptionId: indexed.inscription_id,
            inscriptionOutpoint: indexed.current_output,
            anchorUtxoId: item.anchorUtxoId,
            priceSats,
            sellerProceedsSats: validated.sellerProceedsSats,
            marketplaceFeeSats: validated.marketplaceFeeSats,
            payoutAddress: session.pay_addr,
            inscriptionDestination: session.ord_addr,
          })
        : rawSigningSteps;
    const inputs = [
      item.psbts[0]!.inputsToSign,
      item.psbts[1]!.inputsToSign,
      preflight.response.recoveryPsbt.inputsToSign,
    ];
    return NextResponse.json({
      intent_id: intentId,
      signing_steps: signingSteps.map((step, index) => ({
        ...step,
        // Preserve ord.net's complete signing contract for wallet adapters.
        inputs_to_sign: inputs[index],
      })),
      preview: {
        inscription_number: indexed.inscription_number,
        inscription_id: indexed.inscription_id,
        current_output: indexed.current_output,
        postage_sats: postageSats,
        payout_address: session.pay_addr,
        price_sats: priceSats,
        seller_proceeds_sats: validated.sellerProceedsSats,
        marketplace_fee_sats: validated.marketplaceFeeSats,
        duration_days: durationDays,
        expires_at: Math.floor(Date.now() / 1000) + durationDays * 86_400,
      },
    });
  } catch (error) {
    if (error instanceof OrdError) {
      return sellerError(
        'Could not verify current on-chain ownership. Try again shortly.',
        'stale-ownership',
        503
      );
    }
    if (error instanceof ListingPsbtValidationError) {
      return sellerError(error.message, 'unsafe-utxo', 502);
    }
    if (error instanceof OrdnetError && error.status === 401) {
      return sellerError('ORD.NET wallet authorization expired.', 'auth-required', 428);
    }
    const mapped = ordnetErrorResponse(error);
    return NextResponse.json(
      {
        error: mapped.message,
        code:
          error instanceof OrdnetError && error.status === 429 ? 'rate-limit' : 'invalid-request',
      },
      { status: mapped.status }
    );
  }
}

function toSigningStep(
  step: { psbtBase64: string; inputsToSign: OrdnetSellerSigningInput[] },
  label: string
): PurchasePsbtToSign {
  return {
    psbt: step.psbtBase64,
    sign_inputs: signingInputsByAddress(step.inputsToSign),
    label,
  };
}

function satpointOffset(value: string): number | null {
  const match = /^[0-9a-f]{64}:(?:0|[1-9][0-9]*):((?:0|[1-9][0-9]*))$/iu.exec(value);
  return match ? Number(match[1]) : null;
}

function sellerError(message: string, code: string, status: number) {
  return NextResponse.json(
    { error: message, code },
    { status, headers: { 'Cache-Control': 'private, no-store' } }
  );
}

function withRateCode(response: NextResponse): NextResponse {
  // marketplaceRateLimit already supplies retry headers; seller clients key on a stable code.
  const retryAfter = response.headers.get('retry-after') ?? '60';
  return NextResponse.json(
    { error: 'rate limited', code: 'rate-limit', retry_after_sec: Number(retryAfter) },
    { status: 429, headers: { 'retry-after': retryAfter } }
  );
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    ('code' in error
      ? String((error as Error & { code?: unknown }).code).startsWith('SQLITE_CONSTRAINT')
      : /unique constraint/iu.test(error.message))
  );
}
