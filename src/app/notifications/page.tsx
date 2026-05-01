import { headers } from 'next/headers';
import type { Metadata } from 'next';
import {
  discordWebhookParts,
  parseSessionV2,
  readCookieRaw,
} from '@/lib/subscriberSession';
import { listByTarget, type SubscriptionRow } from '@/lib/subscriptionStore';
import SubpageShell from '@/components/SubpageShell';
import NotificationsList from '@/components/Notifications/NotificationsList';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata: Metadata = {
  title: 'Notifications',
  description: 'Manage your notification subscriptions for OMB inscriptions.',
  robots: { index: false, follow: false },
};

function describeTarget(sub: SubscriptionRow): string {
  if (sub.kind === 'inscription') return `OMB #${sub.target_key}`;
  if (sub.kind === 'color') return `${sub.target_key} OMBs`;
  return 'all OMB activity';
}

export default async function NotificationsPage() {
  const h = await headers();
  const cookieRaw = readCookieRaw(h.get('cookie'));
  const sessionV2 = parseSessionV2(cookieRaw);

  // Iterate EVERY binding in the cookie so a user with both Telegram + Discord
  // sees both groups on one page. Dedupe by sub.id (defensive — the unique
  // (channel, channel_target, kind, target_key) constraint already prevents
  // the same row appearing under two bindings, but a future refactor that
  // changes that contract shouldn't double-render).
  const seen = new Set<number>();
  const subs: Array<{
    id: number;
    channel: 'telegram' | 'discord';
    kind: SubscriptionRow['kind'];
    targetKey: string;
    label: string;
    eventMask: number;
    status: SubscriptionRow['status'];
    unsubToken: string;
    /** Last 4 chars of the Discord webhook token, for the row badge. Only
     *  set on Discord rows where the URL parses to a valid webhook shape. */
    webhookSuffix?: string;
  }> = [];
  if (sessionV2) {
    for (const binding of sessionV2.sessions) {
      const parts =
        binding.channel === 'discord'
          ? discordWebhookParts(binding.channelTarget)
          : null;
      for (const s of listByTarget(binding.channel, binding.channelTarget)) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        subs.push({
          id: s.id,
          channel: s.channel,
          kind: s.kind,
          targetKey: s.target_key,
          label: describeTarget(s),
          eventMask: s.event_mask,
          status: s.status,
          unsubToken: s.unsub_token,
          ...(parts ? { webhookSuffix: parts.tokenSuffix } : {}),
        });
      }
    }
  }

  const channels = sessionV2
    ? Array.from(new Set(sessionV2.sessions.map(s => s.channel)))
    : [];

  return (
    <SubpageShell>
      <div className="px-4 sm:px-6 max-w-2xl mx-auto">
        <h1 className="font-mono text-sm uppercase tracking-[0.12em] text-bone mb-6">
          Notifications
        </h1>
        <NotificationsList
          hasSession={!!sessionV2}
          channels={channels}
          subs={subs}
        />
      </div>
    </SubpageShell>
  );
}
