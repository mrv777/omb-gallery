import 'server-only';

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { Verifier } from 'bip322-js';

export const BUYER_COOKIE_NAME = 'omb_buyer_session';
export const BUYER_NONCE_COOKIE_NAME = 'omb_buyer_nonce';
export const ORDNET_SESSION_COOKIE_NAME = 'omb_ordnet_session';

export const BUYER_SESSION_MAX_AGE_SEC = 180 * 24 * 60 * 60;
export const BUYER_NONCE_MAX_AGE_SEC = 10 * 60;
export const ORDNET_SESSION_MAX_AGE_SEC = 60 * 60;

export type BuyerSession = {
  v: 1;
  ord_addr: string;
  pay_addr: string | null;
  ord_pubkey: string | null;
  pay_pubkey: string | null;
  accepted_terms_at: number | null;
  issued_at: number;
};

export type BuyerNonce = {
  v: 1;
  nonce: string;
  ord_addr: string;
  pay_addr: string | null;
  issued_at: number;
};

export type OrdnetBuyerSession = {
  v: 1;
  ord_addr: string;
  pay_addr: string;
  session_token: string;
  expires_at: number;
  wallet_binding_id: string;
  provider: string;
  issued_at: number;
};

export function buyerSessionSecretConfigured(): boolean {
  return !!rawSecret();
}

export function signInMessage(nonce: string): string {
  return `Sign in to OMB Wiki: ${nonce}`;
}

export function createBuyerNonce(
  ordAddr: string,
  payAddr: string | null
): {
  nonce: BuyerNonce;
  cookieValue: string | null;
  message: string;
} {
  const nonce: BuyerNonce = {
    v: 1,
    nonce: randomBytes(16).toString('hex'),
    ord_addr: ordAddr,
    pay_addr: payAddr,
    issued_at: Math.floor(Date.now() / 1000),
  };
  return {
    nonce,
    cookieValue: signPayload(nonce),
    message: signInMessage(nonce.nonce),
  };
}

export function parseBuyerNonce(raw: string | undefined | null): BuyerNonce | null {
  const payload = parseSignedJson(raw);
  if (!payload || payload.v !== 1 || typeof payload.nonce !== 'string') return null;
  if (typeof payload.ord_addr !== 'string' || payload.ord_addr.length === 0) return null;
  if (payload.pay_addr != null && typeof payload.pay_addr !== 'string') return null;
  if (typeof payload.issued_at !== 'number') return null;
  if (Math.floor(Date.now() / 1000) - payload.issued_at > BUYER_NONCE_MAX_AGE_SEC) return null;
  return {
    v: 1,
    nonce: payload.nonce,
    ord_addr: payload.ord_addr,
    pay_addr: payload.pay_addr ?? null,
    issued_at: payload.issued_at,
  };
}

export function mintBuyerSession(
  session: Omit<BuyerSession, 'v' | 'issued_at'> & {
    issued_at?: number;
  }
): string | null {
  return signPayload({
    v: 1,
    ...session,
    issued_at: session.issued_at ?? Math.floor(Date.now() / 1000),
  });
}

export function parseBuyerSession(raw: string | undefined | null): BuyerSession | null {
  const payload = parseSignedJson(raw);
  if (!payload || payload.v !== 1) return null;
  if (typeof payload.ord_addr !== 'string' || payload.ord_addr.length === 0) return null;
  if (payload.pay_addr != null && typeof payload.pay_addr !== 'string') return null;
  if (payload.ord_pubkey != null && typeof payload.ord_pubkey !== 'string') return null;
  if (payload.pay_pubkey != null && typeof payload.pay_pubkey !== 'string') return null;
  if (payload.accepted_terms_at != null && typeof payload.accepted_terms_at !== 'number') {
    return null;
  }
  if (typeof payload.issued_at !== 'number') return null;
  if (Math.floor(Date.now() / 1000) - payload.issued_at > BUYER_SESSION_MAX_AGE_SEC) return null;
  return {
    v: 1,
    ord_addr: payload.ord_addr,
    pay_addr: payload.pay_addr ?? null,
    ord_pubkey: payload.ord_pubkey ?? null,
    pay_pubkey: payload.pay_pubkey ?? null,
    accepted_terms_at: payload.accepted_terms_at ?? null,
    issued_at: payload.issued_at,
  };
}

export function mintOrdnetBuyerSession(
  session: Omit<OrdnetBuyerSession, 'v' | 'issued_at'> & { issued_at?: number }
): string | null {
  return encryptPayload({
    v: 1,
    ...session,
    issued_at: session.issued_at ?? Math.floor(Date.now() / 1000),
  });
}

export function parseOrdnetBuyerSession(raw: string | undefined | null): OrdnetBuyerSession | null {
  const payload = parseEncryptedJson(raw);
  if (!payload || payload.v !== 1) return null;
  if (typeof payload.ord_addr !== 'string' || payload.ord_addr.length === 0) return null;
  if (typeof payload.pay_addr !== 'string' || payload.pay_addr.length === 0) return null;
  if (typeof payload.session_token !== 'string' || payload.session_token.length === 0) return null;
  if (typeof payload.expires_at !== 'number') return null;
  if (typeof payload.wallet_binding_id !== 'string' || payload.wallet_binding_id.length === 0) {
    return null;
  }
  if (typeof payload.provider !== 'string') return null;
  if (typeof payload.issued_at !== 'number') return null;
  const now = Math.floor(Date.now() / 1000);
  if (payload.expires_at <= now + 15) return null;
  if (now - payload.issued_at > ORDNET_SESSION_MAX_AGE_SEC) return null;
  return {
    v: 1,
    ord_addr: payload.ord_addr,
    pay_addr: payload.pay_addr,
    session_token: payload.session_token,
    expires_at: payload.expires_at,
    wallet_binding_id: payload.wallet_binding_id,
    provider: payload.provider,
    issued_at: payload.issued_at,
  };
}

export function verifyBuyerSignature(args: {
  address: string;
  message: string;
  signature: string;
}): boolean {
  try {
    return Verifier.verifySignature(args.address, args.message, args.signature) === true;
  } catch {
    return false;
  }
}

function signPayload(payload: unknown): string | null {
  const secret = getSecret();
  if (!secret) return null;
  const payloadB = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = createHmac('sha256', secret).update(payloadB).digest();
  return `${b64uEncode(payloadB)}.${b64uEncode(sig)}`;
}

function parseSignedJson(raw: string | undefined | null): Record<string, unknown> | null {
  if (!raw) return null;
  const secret = getSecret();
  if (!secret) return null;
  const parts = raw.split('.');
  if (parts.length !== 2) return null;
  const payloadB = b64uDecode(parts[0]);
  const sigB = b64uDecode(parts[1]);
  if (!payloadB || !sigB) return null;
  const expected = createHmac('sha256', secret).update(payloadB).digest();
  if (sigB.length !== expected.length || !timingSafeEqual(sigB, expected)) return null;
  try {
    const parsed = JSON.parse(payloadB.toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function encryptPayload(payload: unknown): string | null {
  const secret = getSecret();
  if (!secret) return null;
  const key = createHash('sha256').update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc.${b64uEncode(iv)}.${b64uEncode(tag)}.${b64uEncode(encrypted)}`;
}

function parseEncryptedJson(raw: string | undefined | null): Record<string, unknown> | null {
  if (!raw) return null;
  const secret = getSecret();
  if (!secret) return null;
  const parts = raw.split('.');
  if (parts.length !== 4 || parts[0] !== 'enc') return null;
  const iv = b64uDecode(parts[1]);
  const tag = b64uDecode(parts[2]);
  const encrypted = b64uDecode(parts[3]);
  if (!iv || !tag || !encrypted) return null;
  try {
    const key = createHash('sha256').update(secret).digest();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const parsed = JSON.parse(plaintext.toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function getSecret(): Buffer | null {
  const secret = rawSecret();
  if (!secret) return null;
  return Buffer.from(secret, 'utf8');
}

function rawSecret(): string | null {
  const configured = process.env.BUYER_SESSION_SECRET || process.env.SUBSCRIBER_SESSION_SECRET;
  if (configured && configured.length >= 16) return configured;
  if (process.env.NODE_ENV !== 'production') return 'dev-only-omb-buyer-session-secret';
  return null;
}

function b64uEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uDecode(s: string): Buffer | null {
  try {
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
  } catch {
    return null;
  }
}
