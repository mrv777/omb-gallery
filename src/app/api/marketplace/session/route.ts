import { NextRequest, NextResponse } from 'next/server';
import {
  BUYER_COOKIE_NAME,
  BUYER_NONCE_COOKIE_NAME,
  BUYER_NONCE_MAX_AGE_SEC,
  BUYER_SESSION_MAX_AGE_SEC,
  ORDNET_SESSION_COOKIE_NAME,
  buyerSessionSecretConfigured,
  createBuyerNonce,
  mintBuyerSession,
  parseBuyerNonce,
  parseBuyerSession,
  signInMessage,
  verifyBuyerSignature,
} from '@/lib/buyerSession';
import { marketplaceMockEnabled } from '@/lib/marketplace/listings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type SessionBody = {
  ord_addr?: unknown;
  pay_addr?: unknown;
  ord_pubkey?: unknown;
  pay_pubkey?: unknown;
  signature?: unknown;
  message?: unknown;
  mock?: unknown;
};

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const ordAddr = cleanString(url.searchParams.get('ord_addr'));
  const payAddr = cleanString(url.searchParams.get('pay_addr'));
  if (ordAddr) {
    if (!buyerSessionSecretConfigured()) {
      return NextResponse.json({ error: 'buyer session secret not configured' }, { status: 500 });
    }
    const nonce = createBuyerNonce(ordAddr, payAddr);
    if (!nonce.cookieValue) {
      return NextResponse.json({ error: 'buyer session secret not configured' }, { status: 500 });
    }
    const res = NextResponse.json({ message: nonce.message, expires_in: BUYER_NONCE_MAX_AGE_SEC });
    res.cookies.set(
      BUYER_NONCE_COOKIE_NAME,
      nonce.cookieValue,
      cookieOptions(BUYER_NONCE_MAX_AGE_SEC)
    );
    return res;
  }

  const session = parseBuyerSession(req.cookies.get(BUYER_COOKIE_NAME)?.value);
  return NextResponse.json({ session });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as SessionBody | null;
  if (!body) return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  if (!buyerSessionSecretConfigured()) {
    return NextResponse.json({ error: 'buyer session secret not configured' }, { status: 500 });
  }

  const ordAddr = cleanString(body.ord_addr);
  const payAddr = cleanString(body.pay_addr);
  const ordPubkey = cleanString(body.ord_pubkey);
  const payPubkey = cleanString(body.pay_pubkey);
  if (!ordAddr) return NextResponse.json({ error: 'ordinals address required' }, { status: 400 });

  if (body.mock === true && marketplaceMockEnabled()) {
    return mintAndRespond({
      ord_addr: ordAddr,
      pay_addr: payAddr,
      ord_pubkey: ordPubkey,
      pay_pubkey: payPubkey,
      accepted_terms_at: null,
    });
  }

  const nonce = parseBuyerNonce(req.cookies.get(BUYER_NONCE_COOKIE_NAME)?.value);
  const message = cleanString(body.message);
  const signature = cleanString(body.signature);
  if (!nonce || nonce.ord_addr !== ordAddr || nonce.pay_addr !== payAddr) {
    return NextResponse.json({ error: 'sign-in nonce expired' }, { status: 401 });
  }
  if (!message || message !== signInMessage(nonce.nonce)) {
    return NextResponse.json({ error: 'invalid sign-in message' }, { status: 400 });
  }
  if (!signature || !verifyBuyerSignature({ address: ordAddr, message, signature })) {
    return NextResponse.json({ error: 'signature verification failed' }, { status: 401 });
  }

  const res = mintAndRespond({
    ord_addr: ordAddr,
    pay_addr: payAddr,
    ord_pubkey: ordPubkey,
    pay_pubkey: payPubkey,
    accepted_terms_at: null,
  });
  res.cookies.delete(BUYER_NONCE_COOKIE_NAME);
  return res;
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { accept_terms?: unknown } | null;
  if (!body || body.accept_terms !== true) {
    return NextResponse.json({ error: 'accept_terms required' }, { status: 400 });
  }
  const session = parseBuyerSession(req.cookies.get(BUYER_COOKIE_NAME)?.value);
  if (!session) return NextResponse.json({ error: 'wallet session required' }, { status: 401 });
  return mintAndRespond({
    ord_addr: session.ord_addr,
    pay_addr: session.pay_addr,
    ord_pubkey: session.ord_pubkey,
    pay_pubkey: session.pay_pubkey,
    accepted_terms_at: Math.floor(Date.now() / 1000),
    issued_at: session.issued_at,
  });
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(BUYER_COOKIE_NAME);
  res.cookies.delete(BUYER_NONCE_COOKIE_NAME);
  res.cookies.delete(ORDNET_SESSION_COOKIE_NAME);
  return res;
}

function mintAndRespond(session: Parameters<typeof mintBuyerSession>[0]): NextResponse {
  const cookieValue = mintBuyerSession(session);
  if (!cookieValue) {
    return NextResponse.json({ error: 'buyer session secret not configured' }, { status: 500 });
  }
  const res = NextResponse.json({
    session: {
      v: 1,
      ...session,
      issued_at: session.issued_at ?? Math.floor(Date.now() / 1000),
    },
  });
  res.cookies.set(BUYER_COOKIE_NAME, cookieValue, cookieOptions(BUYER_SESSION_MAX_AGE_SEC));
  return res;
}

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  };
}

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
