import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

// HMAC-signed cookie binding a browser to a (channel, channel_target) pair.
// Once minted, subsequent /api/subscribe POSTs from the same browser create
// subs without going through Telegram /start or pasting a webhook URL again.
//
// Format: base64url(payload).base64url(hmac). Payload is `${channel}|${channel_target}|${issuedAt}`.
// channel_target is stored verbatim — for Discord that's the webhook URL, so
// the cookie value is sensitive. Hence HttpOnly + Secure in prod.

export const COOKIE_NAME = 'omb_sub_session';
const COOKIE_MAX_AGE_SEC = 365 * 24 * 60 * 60; // 1 year

export type SubscriberSession = {
  channel: 'telegram' | 'discord';
  channelTarget: string;
  issuedAt: number;
};

function secret(): Buffer | null {
  const s = process.env.SUBSCRIBER_SESSION_SECRET;
  if (!s || s.length < 16) return null;
  return Buffer.from(s, 'utf8');
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

export function mintSession(channel: SubscriberSession['channel'], channelTarget: string): string | null {
  const k = secret();
  if (!k) return null;
  const payload = `${channel}|${channelTarget}|${Math.floor(Date.now() / 1000)}`;
  const payloadB = Buffer.from(payload, 'utf8');
  const sig = createHmac('sha256', k).update(payloadB).digest();
  return `${b64uEncode(payloadB)}.${b64uEncode(sig)}`;
}

export function parseSession(raw: string | undefined | null): SubscriberSession | null {
  if (!raw) return null;
  const k = secret();
  if (!k) return null;
  const parts = raw.split('.');
  if (parts.length !== 2) return null;
  const payloadB = b64uDecode(parts[0]);
  const sigB = b64uDecode(parts[1]);
  if (!payloadB || !sigB) return null;
  const expected = createHmac('sha256', k).update(payloadB).digest();
  if (sigB.length !== expected.length) return null;
  if (!timingSafeEqual(sigB, expected)) return null;
  const payload = payloadB.toString('utf8');
  const fields = payload.split('|');
  if (fields.length !== 3) return null;
  const [channel, channelTarget, issuedAtStr] = fields;
  if (channel !== 'telegram' && channel !== 'discord') return null;
  const issuedAt = parseInt(issuedAtStr, 10);
  if (!Number.isFinite(issuedAt)) return null;
  // Soft expiry — server-side row is the source of truth, cookie just authorizes.
  if (Date.now() / 1000 - issuedAt > COOKIE_MAX_AGE_SEC) return null;
  return { channel, channelTarget, issuedAt };
}

export function cookieAttributes(): string {
  const isProd = process.env.NODE_ENV === 'production';
  const parts = [
    `Path=/`,
    `Max-Age=${COOKIE_MAX_AGE_SEC}`,
    `HttpOnly`,
    `SameSite=Lax`,
  ];
  if (isProd) parts.push('Secure');
  return parts.join('; ');
}

export function setCookieHeader(value: string): string {
  return `${COOKIE_NAME}=${value}; ${cookieAttributes()}`;
}

export function clearCookieHeader(): string {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}
