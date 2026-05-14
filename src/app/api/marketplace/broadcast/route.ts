import { NextRequest, NextResponse } from 'next/server';
import {
  BUYER_COOKIE_NAME,
  ORDNET_SESSION_COOKIE_NAME,
  parseBuyerSession,
  parseOrdnetBuyerSession,
} from '@/lib/buyerSession';
import {
  getBuyIntent,
  markIntentBroadcast,
  markIntentFailed,
  markIntentSigned,
  updateIntentPreflightJson,
} from '@/lib/marketplace/buyIntentsStore';
import { marketplaceMockEnabled } from '@/lib/marketplace/listings';
import { marketplaceRateLimit, requireMarketplaceEnabled } from '@/lib/marketplace/apiGuards';
import { mockBroadcast } from '@/lib/marketplace/mock';
import { broadcastOrdnetPurchase, ordnetErrorResponse } from '@/lib/ordnet';
import { broadcastSatflowPurchase, satflowBuyErrorResponse } from '@/lib/marketplace/satflowBuy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Body = {
  intent_id?: unknown;
  signed_psbt?: unknown;
  signed_psbts?: unknown;
};

export async function POST(req: NextRequest) {
  const disabled = requireMarketplaceEnabled();
  if (disabled) return disabled;

  const session = parseBuyerSession(req.cookies.get(BUYER_COOKIE_NAME)?.value);
  if (!session) return NextResponse.json({ error: 'connect wallet first' }, { status: 401 });
  const limited = marketplaceRateLimit(req, 'broadcast', 20, 200);
  if (limited) return limited;

  const body = (await req.json().catch(() => null)) as Body | null;
  const intentId = body && typeof body.intent_id === 'number' ? Math.trunc(body.intent_id) : NaN;
  const signedPsbt = body && typeof body.signed_psbt === 'string' ? body.signed_psbt : null;
  const signedPsbts =
    body && Array.isArray(body.signed_psbts)
      ? body.signed_psbts.filter(
          (item): item is string => typeof item === 'string' && item.length > 0
        )
      : signedPsbt
        ? [signedPsbt]
        : [];
  if (!Number.isFinite(intentId) || intentId <= 0 || signedPsbts.length === 0) {
    return NextResponse.json({ error: 'intent_id and signed_psbt required' }, { status: 400 });
  }

  const intent = getBuyIntent(intentId);
  if (!intent || intent.buyer_ord_addr !== session.ord_addr) {
    return NextResponse.json({ error: 'intent not found' }, { status: 404 });
  }
  if (intent.status === 'broadcast' && intent.txid) {
    return NextResponse.json({
      intent_id: intent.id,
      txid: intent.txid,
      mock: intent.is_mock === 1,
    });
  }

  markIntentSigned(intentId);
  const firstSignedPsbt = signedPsbts[0]!;

  if (marketplaceMockEnabled() && intent.is_mock === 1) {
    const result = mockBroadcast(intentId);
    markIntentBroadcast(intentId, result.txid!);
    return NextResponse.json(result);
  }

  try {
    const marketplaceKey = intent.marketplace.toLowerCase();
    if (marketplaceKey === 'ord.net' || marketplaceKey === 'ordnet') {
      const result = await broadcastOrdnet(req, intent, firstSignedPsbt);
      markIntentBroadcast(intentId, result.txid);
      return NextResponse.json({ intent_id: intentId, txid: result.txid, mock: false });
    }

    const result = await broadcastSatflowPurchase(intent, signedPsbts);
    if (result.type === 'next') {
      updateIntentPreflightJson(intentId, result.preflightJson);
      return NextResponse.json({
        intent_id: intentId,
        psbt: result.psbt,
        sign_inputs: result.signInputs,
        psbts: result.psbts,
        step: result.step,
        mock: false,
      });
    }
    markIntentBroadcast(intentId, result.txid);
    return NextResponse.json({ intent_id: intentId, txid: result.txid, mock: false });
  } catch (err) {
    if (err instanceof OrdnetAuthRequiredError) {
      markIntentFailed(intentId, err.message);
      return NextResponse.json(
        { error: err.message, code: 'ordnet-auth-required' },
        { status: 428 }
      );
    }
    const mapped =
      intent.marketplace.toLowerCase() === 'ord.net' ||
      intent.marketplace.toLowerCase() === 'ordnet'
        ? ordnetErrorResponse(err)
        : satflowBuyErrorResponse(err);
    markIntentFailed(intentId, mapped.message);
    return NextResponse.json({ error: mapped.message }, { status: mapped.status });
  }
}

class OrdnetAuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrdnetAuthRequiredError';
  }
}

async function broadcastOrdnet(
  req: NextRequest,
  intent: NonNullable<ReturnType<typeof getBuyIntent>>,
  signedPsbt: string
) {
  const ordnetSession = parseOrdnetBuyerSession(req.cookies.get(ORDNET_SESSION_COOKIE_NAME)?.value);
  if (
    !ordnetSession ||
    ordnetSession.ord_addr !== intent.buyer_ord_addr ||
    ordnetSession.pay_addr !== intent.buyer_pay_addr
  ) {
    throw new OrdnetAuthRequiredError(
      'ORD.NET wallet authorization expired. Try confirm buy again.'
    );
  }
  return broadcastOrdnetPurchase({ intent, signedPsbt, ordnetSession });
}
