import 'server-only';

// Strict shape match against the public Discord webhook surface. Server-side
// enforcement is the SSRF defense — never relax this regex without thinking
// hard about what an attacker could point us at.
const WEBHOOK_RE = /^https:\/\/(discord\.com|discordapp\.com|canary\.discord\.com|ptb\.discord\.com)\/api\/webhooks\/\d{10,25}\/[\w-]{40,200}$/;

export function isValidWebhookUrl(raw: string): boolean {
  return typeof raw === 'string' && WEBHOOK_RE.test(raw);
}

export type DiscordEmbed = {
  title?: string;
  description?: string;
  url?: string;
  color?: number; // hex int, e.g. 0xff5544
  thumbnail?: { url: string };
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string; // ISO8601
};

export type DiscordPostError =
  | { kind: 'invalid-url' }
  | { kind: 'dead'; status: number } // 404 / 401 — drop the sub
  | { kind: 'rate-limit'; retryAfterSec: number }
  | { kind: 'http'; status: number; body: string }
  | { kind: 'network'; message: string };

export type DiscordPostResult = { ok: true } | { ok: false; error: DiscordPostError };

type Body = {
  content?: string;
  username?: string;
  avatar_url?: string;
  embeds?: DiscordEmbed[];
  allowed_mentions?: { parse: never[] };
};

// POST a message to a Discord webhook. We pass `wait=true` so a successful
// response means the message was actually delivered, not just queued.
// `redirect: 'manual'` plus the strict regex above means we never follow a
// redirect to an attacker-controlled host.
export async function postWebhook(url: string, body: Body): Promise<DiscordPostResult> {
  if (!isValidWebhookUrl(url)) return { ok: false, error: { kind: 'invalid-url' } };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${url}?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...body,
        // Never @-mention anyone — we're posting third-party content.
        allowed_mentions: { parse: [] },
      }),
      redirect: 'manual',
      signal: ctrl.signal,
    });
    if (res.status >= 200 && res.status < 300) return { ok: true };
    if (res.status === 404 || res.status === 401) {
      return { ok: false, error: { kind: 'dead', status: res.status } };
    }
    if (res.status === 429) {
      const txt = await res.text().catch(() => '');
      let retry = 1;
      try {
        const j = JSON.parse(txt) as { retry_after?: number };
        if (typeof j.retry_after === 'number') retry = Math.ceil(j.retry_after);
      } catch {
        /* ignore */
      }
      return { ok: false, error: { kind: 'rate-limit', retryAfterSec: retry } };
    }
    const txt = await res.text().catch(() => '');
    return { ok: false, error: { kind: 'http', status: res.status, body: txt.slice(0, 200) } };
  } catch (e) {
    return { ok: false, error: { kind: 'network', message: e instanceof Error ? e.message : String(e) } };
  } finally {
    clearTimeout(timer);
  }
}

// Fast canary: post a small confirmation message to verify the URL works
// before we persist a sub. If this fails, we don't write the row at all.
//
// `manageLink` is a magic-login URL that mints the subscriber_session cookie
// on whatever device clicks it — recovery path for users on a different
// browser or who cleared cookies. Suggest pinning the message in the channel
// so co-admins can manage subs later.
export async function pingWebhook(
  url: string,
  opts: { manageLink: string; burnLink: string; targetLabel: string }
): Promise<DiscordPostResult> {
  return postWebhook(url, {
    username: 'OMB Archive',
    embeds: [
      {
        title: 'Subscribed to OMB alerts',
        description: `This channel will now receive notifications for **${opts.targetLabel}**. Pin this message — the manage link works on any device.`,
        color: 0xff5544,
        fields: [
          { name: 'Manage', value: `[All subscriptions](${opts.manageLink})`, inline: true },
          { name: 'Not you?', value: `[Remove this webhook](${opts.burnLink})`, inline: true },
        ],
        footer: { text: 'ordinalmaxibiz.wiki' },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}
