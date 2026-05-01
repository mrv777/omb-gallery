import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

// HMAC-signed cookie binding a browser to one or more (channel, channel_target)
// pairs. Once minted, subsequent /api/subscribe POSTs from the same browser
// create subs without going through Telegram /start or pasting a webhook URL
// again — and a user can hold a Telegram chat AND a Discord webhook side by
// side from the same browser.
//
// v2 format (current): base64url(payloadJson).base64url(hmac), where payload is
//   { "v": 2, "sessions": [ { "c": "telegram", "t": "12345", "i": 1714500000 }, ... ] }
//
// v1 format (legacy, still parsed): base64url(`${channel}|${channel_target}|${issuedAt}`).base64url(hmac).
// On any subscribe / magic-login click, the legacy cookie gets re-minted as v2
// with that single binding lifted into sessions[0]. No forced re-onboarding.
//
// channel_target is stored verbatim — for Discord that's the webhook URL, so
// the cookie value is sensitive. Hence HttpOnly + Secure in prod.

export const COOKIE_NAME = 'omb_sub_session';
const COOKIE_MAX_AGE_SEC = 365 * 24 * 60 * 60; // 1 year
const MAX_BINDINGS = 4;

export type SubscriberSession = {
  channel: 'telegram' | 'discord';
  channelTarget: string;
  issuedAt: number;
};

export type SubscriberSessionV2 = {
  sessions: SubscriberSession[];
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

function verifyAndExtractPayload(raw: string): Buffer | null {
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
  return payloadB;
}

// v1 (legacy): "telegram|chat_id|issuedAt"
function parseV1Payload(payload: string): SubscriberSession | null {
  const fields = payload.split('|');
  if (fields.length !== 3) return null;
  const [channel, channelTarget, issuedAtStr] = fields;
  if (channel !== 'telegram' && channel !== 'discord') return null;
  const issuedAt = parseInt(issuedAtStr, 10);
  if (!Number.isFinite(issuedAt)) return null;
  if (Date.now() / 1000 - issuedAt > COOKIE_MAX_AGE_SEC) return null;
  return { channel, channelTarget, issuedAt };
}

// v2: { v: 2, sessions: [{c, t, i}, ...] }
function parseV2Payload(payload: string): SubscriberSession[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { v?: unknown }).v !== 2 ||
    !Array.isArray((parsed as { sessions?: unknown }).sessions)
  ) {
    return null;
  }
  const out: SubscriberSession[] = [];
  for (const s of (parsed as { sessions: unknown[] }).sessions) {
    if (!s || typeof s !== 'object') continue;
    const o = s as { c?: unknown; t?: unknown; i?: unknown };
    if (
      (o.c !== 'telegram' && o.c !== 'discord') ||
      typeof o.t !== 'string' ||
      typeof o.i !== 'number'
    ) {
      continue;
    }
    if (Date.now() / 1000 - o.i > COOKIE_MAX_AGE_SEC) continue;
    out.push({ channel: o.c, channelTarget: o.t, issuedAt: o.i });
  }
  return out.length > 0 ? out : null;
}

export function parseSessionV2(raw: string | undefined | null): SubscriberSessionV2 | null {
  if (!raw) return null;
  const payloadB = verifyAndExtractPayload(raw);
  if (!payloadB) return null;
  const payload = payloadB.toString('utf8');
  // Try v2 JSON first; fall back to v1 single-binding format.
  if (payload.startsWith('{')) {
    const sessions = parseV2Payload(payload);
    return sessions ? { sessions } : null;
  }
  const single = parseV1Payload(payload);
  return single ? { sessions: [single] } : null;
}

// Legacy single-binding parser. Returns the FIRST binding (or matches the v1
// format directly). Kept for callers that haven't been migrated yet.
export function parseSession(raw: string | undefined | null): SubscriberSession | null {
  const v2 = parseSessionV2(raw);
  return v2?.sessions[0] ?? null;
}

export function mintSessionV2(sessions: SubscriberSession[]): string | null {
  const k = secret();
  if (!k) return null;
  const capped = sessions.slice(-MAX_BINDINGS);
  const payload = JSON.stringify({
    v: 2,
    sessions: capped.map(s => ({ c: s.channel, t: s.channelTarget, i: s.issuedAt })),
  });
  const payloadB = Buffer.from(payload, 'utf8');
  const sig = createHmac('sha256', k).update(payloadB).digest();
  return `${b64uEncode(payloadB)}.${b64uEncode(sig)}`;
}

export function mintSession(
  channel: SubscriberSession['channel'],
  channelTarget: string
): string | null {
  return mintSessionV2([{ channel, channelTarget, issuedAt: Math.floor(Date.now() / 1000) }]);
}

// Append a binding to the existing cookie (if any). Dedupes by
// (channel, channelTarget) — re-subscribing with the same target updates the
// issuedAt timestamp rather than producing a duplicate. For Discord, also
// dedupes by webhook id so a token rotation (same id, new token) replaces
// the older binding instead of leaving both in the list (which would let the
// picker silently target a stale/dead webhook). If the cookie's binding list
// grows past MAX_BINDINGS, the oldest are evicted.
export function addBinding(
  existingRaw: string | undefined | null,
  channel: SubscriberSession['channel'],
  channelTarget: string
): string | null {
  const existing = parseSessionV2(existingRaw);
  const now = Math.floor(Date.now() / 1000);
  const newDiscordId =
    channel === 'discord' ? (discordWebhookParts(channelTarget)?.id ?? null) : null;
  const next: SubscriberSession[] = [];
  if (existing) {
    for (const s of existing.sessions) {
      if (s.channel === channel && s.channelTarget === channelTarget) continue;
      if (newDiscordId && s.channel === 'discord') {
        const sParts = discordWebhookParts(s.channelTarget);
        if (sParts && sParts.id === newDiscordId) continue;
      }
      next.push(s);
    }
  }
  next.push({ channel, channelTarget, issuedAt: now });
  return mintSessionV2(next);
}

export function findBinding(
  v2: SubscriberSessionV2 | null,
  channel: SubscriberSession['channel'],
  channelTarget: string
): SubscriberSession | undefined {
  if (!v2) return undefined;
  return v2.sessions.find(s => s.channel === channel && s.channelTarget === channelTarget);
}

export function findBindingByChannel(
  v2: SubscriberSessionV2 | null,
  channel: SubscriberSession['channel']
): SubscriberSession | undefined {
  if (!v2) return undefined;
  // Last binding for that channel wins (most recently added).
  for (let i = v2.sessions.length - 1; i >= 0; i--) {
    if (v2.sessions[i].channel === channel) return v2.sessions[i];
  }
  return undefined;
}

// Discord webhook URLs look like:
//   https://discord.com/api/webhooks/<numeric_id>/<token>
// The numeric id alone is public-ish (Discord exposes it in URLs) and useless
// without the token, so we surface it to the client as a stable identifier
// for picker UI without leaking the secret token. The token suffix gives the
// human something memorable.
const WEBHOOK_PATH_RE = /\/api\/webhooks\/(\d{10,25})\/([\w-]{40,200})$/;

export function discordWebhookParts(url: string): { id: string; tokenSuffix: string } | null {
  const m = WEBHOOK_PATH_RE.exec(url);
  if (!m) return null;
  return { id: m[1], tokenSuffix: m[2].slice(-4) };
}

// Pull every Discord binding's id+suffix out of the cookie for the picker UI.
// Iterates from the END so the most recent token wins for any duplicate ids
// (defense for pre-existing dupes; addBinding now prevents new ones).
export function discordWebhookSummaries(
  v2: SubscriberSessionV2 | null
): Array<{ id: string; tokenSuffix: string }> {
  if (!v2) return [];
  const out: Array<{ id: string; tokenSuffix: string }> = [];
  const seen = new Set<string>();
  for (let i = v2.sessions.length - 1; i >= 0; i--) {
    const s = v2.sessions[i];
    if (s.channel !== 'discord') continue;
    const parts = discordWebhookParts(s.channelTarget);
    if (!parts) continue;
    if (seen.has(parts.id)) continue;
    seen.add(parts.id);
    out.push(parts);
  }
  // Reverse so the rendered order matches insertion order (oldest first),
  // keeping the picker stable across reloads while the dedupe still picks
  // the newest token per id.
  return out.reverse();
}

export function findBindingByDiscordWebhookId(
  v2: SubscriberSessionV2 | null,
  webhookId: string
): SubscriberSession | undefined {
  if (!v2) return undefined;
  if (!/^\d{10,25}$/.test(webhookId)) return undefined;
  // Walk backwards so the newest binding for this id wins.
  for (let i = v2.sessions.length - 1; i >= 0; i--) {
    const s = v2.sessions[i];
    if (s.channel !== 'discord') continue;
    const parts = discordWebhookParts(s.channelTarget);
    if (parts && parts.id === webhookId) return s;
  }
  return undefined;
}

export function cookieAttributes(): string {
  const isProd = process.env.NODE_ENV === 'production';
  const parts = [`Path=/`, `Max-Age=${COOKIE_MAX_AGE_SEC}`, `HttpOnly`, `SameSite=Lax`];
  if (isProd) parts.push('Secure');
  return parts.join('; ');
}

export function setCookieHeader(value: string): string {
  return `${COOKIE_NAME}=${value}; ${cookieAttributes()}`;
}

export function clearCookieHeader(): string {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

export function readCookieRaw(cookieHeader: string | null | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  const m = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  return m?.[1];
}
