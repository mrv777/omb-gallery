import { NextRequest, NextResponse } from 'next/server';
import { clientIpKey } from '@/lib/clientIp';
import { checkAndConsumePerIp } from '@/lib/rateLimit';
import { verifyTurnstileToken } from '@/lib/turnstile';
import { randomBytes } from 'node:crypto';
import { isValidWebhookUrl, pingWebhook } from '@/lib/discord';
import { deepLink, isConfigured as telegramConfigured } from '@/lib/telegram';
import {
  createActive,
  createPending,
  getExistingUnsubToken,
  MASK_SOLD,
  MASK_TRANSFERRED,
  type Channel,
  type SubKind,
} from '@/lib/subscriptionStore';
import {
  COOKIE_NAME,
  mintSession,
  parseSession,
  setCookieHeader,
} from '@/lib/subscriberSession';
import { log } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PER_MIN = 10;
const PER_DAY = 50;

const VALID_KINDS: SubKind[] = ['inscription', 'color', 'collection'];
const VALID_CHANNELS: Channel[] = ['telegram', 'discord'];
const VALID_COLORS = new Set(['red', 'blue', 'green', 'orange', 'black']);
const VALID_COLLECTIONS = new Set(['omb']);
const INSCRIPTION_RE = /^\d{1,8}$/;

type Body = {
  channel?: unknown;
  kind?: unknown;
  targetKey?: unknown;
  eventMask?: unknown;
  webhookUrl?: unknown;
  turnstileToken?: unknown;
};

function bad(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}

function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || 'https://ordinalmaxibiz.wiki').replace(/\/$/, '');
}

function readKindAndTarget(body: Body): { kind: SubKind; targetKey: string } | { error: string } {
  if (typeof body.kind !== 'string' || !VALID_KINDS.includes(body.kind as SubKind)) {
    return { error: 'kind-invalid' };
  }
  const kind = body.kind as SubKind;
  if (typeof body.targetKey !== 'string' || !body.targetKey) return { error: 'target-required' };
  const targetKey = body.targetKey;
  if (kind === 'inscription' && !INSCRIPTION_RE.test(targetKey)) return { error: 'target-invalid' };
  if (kind === 'color' && !VALID_COLORS.has(targetKey)) return { error: 'target-invalid' };
  if (kind === 'collection' && !VALID_COLLECTIONS.has(targetKey)) return { error: 'target-invalid' };
  return { kind, targetKey };
}

function readEventMask(body: Body, kind: SubKind): number {
  // Default sub gets transfers + sales. Collection-kind defaults to sales-only
  // (volume guard) — explicit transferred bit must be opted in.
  const raw = typeof body.eventMask === 'number' ? body.eventMask : null;
  if (raw === null) {
    return kind === 'collection' ? MASK_SOLD : MASK_TRANSFERRED | MASK_SOLD;
  }
  const masked = raw & (MASK_TRANSFERRED | MASK_SOLD);
  if (masked === 0) return kind === 'collection' ? MASK_SOLD : MASK_TRANSFERRED | MASK_SOLD;
  return masked;
}

function targetLabel(kind: SubKind, targetKey: string): string {
  if (kind === 'inscription') return `OMB #${targetKey}`;
  if (kind === 'color') return `${targetKey} OMBs`;
  return 'all OMB activity';
}

function unsubLink(unsubToken: string): string {
  return `${siteUrl()}/api/unsubscribe?token=${unsubToken}`;
}

function burnLink(unsubToken: string): string {
  return `${siteUrl()}/api/unsubscribe?token=${unsubToken}&burn=1`;
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return bad(400, 'invalid-json');
  }

  if (typeof body.channel !== 'string' || !VALID_CHANNELS.includes(body.channel as Channel)) {
    return bad(400, 'channel-invalid');
  }
  const channel = body.channel as Channel;

  const kt = readKindAndTarget(body);
  if ('error' in kt) return bad(400, kt.error);
  const { kind, targetKey } = kt;
  const eventMask = readEventMask(body, kind);

  const ip = clientIpKey(req.headers);

  // Re-use a session cookie if present and matches the requested channel.
  const cookieHeader = req.headers.get('cookie') ?? '';
  const cookieMatch = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  const session = parseSession(cookieMatch?.[1]);

  if (session && session.channel === channel) {
    // Fast path: trusted session, no Turnstile / no round-trip needed.
    const r = createActive({
      channel,
      channelTarget: session.channelTarget,
      kind,
      targetKey,
      eventMask,
      creatorIp: ip,
    });
    if (!r.ok) return bad(429, r.error);
    log.info('subscribe', 'created via session', { channel, kind, target: targetKey });
    return NextResponse.json({
      status: 'active',
      id: r.row.id,
      unsubToken: r.row.unsub_token,
    });
  }

  // No session — go through the full per-channel onboarding flow.
  const perIp = checkAndConsumePerIp(ip, PER_MIN, PER_DAY);
  if (!perIp.ok) {
    return new NextResponse(JSON.stringify({ error: 'rate-limited' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': String(perIp.retryAfterSec) },
    });
  }

  if (channel === 'telegram') {
    if (!telegramConfigured()) return bad(503, 'not-configured');
    const { row, claimToken } = createPending({
      channel: 'telegram',
      kind,
      targetKey,
      eventMask,
      creatorIp: ip,
    });
    return NextResponse.json({
      status: 'pending',
      claimToken,
      deepLink: deepLink(claimToken),
      pendingId: row.id,
    });
  }

  // channel === 'discord'
  if (typeof body.webhookUrl !== 'string' || !isValidWebhookUrl(body.webhookUrl)) {
    return bad(400, 'webhook-invalid');
  }
  const webhookUrl = body.webhookUrl;

  const token = typeof body.turnstileToken === 'string' ? body.turnstileToken : '';
  if (!token) return bad(403, 'turnstile-missing');
  const verify = await verifyTurnstileToken(token, ip !== 'unknown' ? ip : undefined);
  if (!verify.ok) {
    return NextResponse.json({ error: 'turnstile-failed', codes: verify.errors }, { status: 403 });
  }

  // Ping FIRST, persist SECOND. If we wrote the row before pinging and the
  // webhook turned out to be dead, the user would have an active subscription
  // they can't reach (no session cookie minted, no confirmation arriving).
  // Reuse an existing unsub_token if this URL+target already has a row, so
  // previously-emitted unsub links stay valid.
  const existingToken = getExistingUnsubToken('discord', webhookUrl, kind, targetKey);
  const unsubToken = existingToken ?? randomBytes(16).toString('hex');

  const ping = await pingWebhook(webhookUrl, {
    unsubLink: unsubLink(unsubToken),
    burnLink: burnLink(unsubToken),
    targetLabel: targetLabel(kind, targetKey),
  });
  if (!ping.ok) {
    log.warn('subscribe', 'webhook ping failed', { error: ping.error });
    return bad(502, 'webhook-unreachable');
  }

  const created = createActive({
    channel: 'discord',
    channelTarget: webhookUrl,
    kind,
    targetKey,
    eventMask,
    creatorIp: ip,
    unsubToken,
  });
  if (!created.ok) return bad(429, created.error);
  const { row } = created;

  // Mint the session cookie so subsequent subscribes from this browser are one-click.
  const sessionValue = mintSession('discord', webhookUrl);
  const headers = new Headers({ 'content-type': 'application/json' });
  if (sessionValue) headers.append('set-cookie', setCookieHeader(sessionValue));
  log.info('subscribe', 'discord active', { kind, target: targetKey });
  return new NextResponse(
    JSON.stringify({ status: 'active', id: row.id, unsubToken: row.unsub_token }),
    { status: 200, headers }
  );
}
