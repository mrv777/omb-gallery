import type { Metadata } from 'next';
import ActivityFeed from '@/components/Activity/ActivityFeed';
import SubpageShell from '@/components/SubpageShell';

export const metadata: Metadata = {
  title: 'Activity · OMB Archive',
  description: 'On-chain activity for Ordinal Maxi Biz: transfers, sales, and inscriptions.',
};

export default function ActivityPage() {
  return (
    <SubpageShell active="activity">
      <ActivityFeed />
    </SubpageShell>
  );
}
