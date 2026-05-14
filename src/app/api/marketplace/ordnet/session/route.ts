import { NextRequest, NextResponse } from 'next/server';
import {
  BUYER_COOKIE_NAME,
  ORDNET_SESSION_COOKIE_NAME,
  ORDNET_SESSION_MAX_AGE_SEC,
  mintOrdnetBuyerSession,
  parseBuyerSession,
} from '@/lib/buyerSession';
import {
  createOrdnetAuthChallenge,
  ordnetErrorResponse,
  verifyOrdnetAuthChallenge,
} from '@/lib/ordnet';
import { marketplaceRateLimit, requireMarketplaceEnabled } from '@/lib/marketplace/apiGuards';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type VerifyBody = {
  auth_request_id?: unknown;
  verifications?: unknown;
};

export async function GET(req: NextRequest) {
  const disabled = requireMarketplaceEnabled();
  if (disabled) return disabled;

  const session = parseBuyerSession(req.cookies.get(BUYER_COOKIE_NAME)?.value);
  if (!session) return NextResponse.json({ error: 'connect wallet first' }, { status: 401 });
  if (!session.pay_addr) {
    return NextResponse.json(
      { error: 'ORD.NET requires a connected payment address.' },
      { status: 428 }
    );
  }
  const limited = marketplaceRateLimit(req, 'ordnet-session', 10, 100);
  if (limited) return limited;

  try {
    const challenge = await createOrdnetAuthChallenge({
      ordinalsAddress: session.ord_addr,
      paymentAddress: session.pay_addr,
    });
    return NextResponse.json({
      auth_request_id: challenge.authRequestId,
      challenges: challenge.challenges.map(ch => ({
        challenge_id: ch.challengeId,
        message: ch.message,
        address: ch.address,
        role: ch.role,
      })),
    });
  } catch (err) {
    const mapped = ordnetErrorResponse(err);
    return NextResponse.json({ error: mapped.message }, { status: mapped.status });
  }
}

export async function POST(req: NextRequest) {
  const disabled = requireMarketplaceEnabled();
  if (disabled) return disabled;

  const buyer = parseBuyerSession(req.cookies.get(BUYER_COOKIE_NAME)?.value);
  if (!buyer) return NextResponse.json({ error: 'connect wallet first' }, { status: 401 });
  if (!buyer.pay_addr) {
    return NextResponse.json(
      { error: 'ORD.NET requires a connected payment address.' },
      { status: 428 }
    );
  }
  const limited = marketplaceRateLimit(req, 'ordnet-session', 10, 100);
  if (limited) return limited;

  const body = (await req.json().catch(() => null)) as VerifyBody | null;
  const authRequestId = cleanString(body?.auth_request_id);
  const rawVerifications = Array.isArray(body?.verifications) ? body.verifications : null;
  if (!authRequestId || !rawVerifications) {
    return NextResponse.json(
      { error: 'auth_request_id and verifications required' },
      { status: 400 }
    );
  }

  const allowedAddresses = new Set([buyer.ord_addr, buyer.pay_addr]);
  const verifications = [];
  for (const raw of rawVerifications) {
    if (!raw || typeof raw !== 'object') {
      return NextResponse.json({ error: 'invalid verification item' }, { status: 400 });
    }
    const obj = raw as Record<string, unknown>;
    const challengeId = cleanString(obj.challenge_id);
    const address = cleanString(obj.address);
    const signature = cleanString(obj.signature);
    if (!challengeId || !address || !signature || !/^(?:[0-9a-fA-F]{2})+$/.test(signature)) {
      return NextResponse.json({ error: 'invalid verification item' }, { status: 400 });
    }
    if (!allowedAddresses.has(address)) {
      return NextResponse.json({ error: 'verification address mismatch' }, { status: 400 });
    }
    verifications.push({ challengeId, address, signature });
  }

  try {
    const verified = await verifyOrdnetAuthChallenge({
      authRequestId,
      verifications,
    });
    const binding = verified.walletBindings.find(
      item => item.ordinalsAddress === buyer.ord_addr && item.paymentAddress === buyer.pay_addr
    );
    if (!binding) {
      return NextResponse.json(
        { error: 'ORD.NET did not return a wallet binding for the connected addresses.' },
        { status: 502 }
      );
    }
    const expiresAt = Math.floor(Date.parse(verified.expiresAt) / 1000);
    if (!Number.isFinite(expiresAt)) {
      return NextResponse.json({ error: 'ORD.NET returned an invalid expiry.' }, { status: 502 });
    }
    const cookieValue = mintOrdnetBuyerSession({
      ord_addr: buyer.ord_addr,
      pay_addr: buyer.pay_addr,
      session_token: verified.sessionToken,
      expires_at: expiresAt,
      wallet_binding_id: binding.walletBindingId,
      provider: binding.provider,
    });
    if (!cookieValue) {
      return NextResponse.json({ error: 'buyer session secret not configured' }, { status: 500 });
    }
    const maxAge = Math.max(
      1,
      Math.min(ORDNET_SESSION_MAX_AGE_SEC, expiresAt - Math.floor(Date.now() / 1000))
    );
    const res = NextResponse.json({
      ok: true,
      expires_at: expiresAt,
      provider: binding.provider,
    });
    res.cookies.set(ORDNET_SESSION_COOKIE_NAME, cookieValue, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge,
    });
    return res;
  } catch (err) {
    const mapped = ordnetErrorResponse(err);
    return NextResponse.json({ error: mapped.message }, { status: mapped.status });
  }
}

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
