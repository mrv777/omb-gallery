import { headers } from 'next/headers';
import type { Metadata } from 'next';
import { COOKIE_NAME, parseSession } from '@/lib/subscriberSession';
import { listByTarget, type SubscriptionRow } from '@/lib/subscriptionStore';
import SubpageShell from '@/components/SubpageShell';
import NotificationsList from '@/components/Notifications/NotificationsList';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata: Metadata = {
  title: 'Notifications · OMB Archive',
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
  const cookie = h.get('cookie') ?? '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  const session = parseSession(m?.[1]);

  const subs = session
    ? listByTarget(session.channel, session.channelTarget).map(s => ({
        id: s.id,
        kind: s.kind,
        targetKey: s.target_key,
        label: describeTarget(s),
        eventMask: s.event_mask,
        status: s.status,
        unsubToken: s.unsub_token,
      }))
    : [];

  return (
    <SubpageShell>
      <div className="px-4 sm:px-6 max-w-2xl mx-auto">
        <h1 className="font-mono text-sm uppercase tracking-[0.12em] text-bone mb-6">
          Notifications
        </h1>
        <NotificationsList
          hasSession={!!session}
          channel={session?.channel ?? null}
          subs={subs}
        />
      </div>
    </SubpageShell>
  );
}
