import type { Metadata } from 'next';
import SubpageShell from '@/components/SubpageShell';
import HeaderColorSwatches from '@/components/HeaderColorSwatches';
import Leaderboard from '@/components/Explorer/Leaderboard';
import {
  getStmts,
  type GroupedHolderRow,
  type HolderDistributionBucketRow,
  type HoldingDurationBucketRow,
  type InscriptionRow,
} from '@/lib/db';
import type { ApiHolder } from '@/components/Activity/types';
import { colorParamForSql, parseColorParam } from '@/lib/colorFilter';
import HolderDistributionHistogram from '@/components/Charts/HolderDistributionHistogram';
import HoldingDurationHistogram from '@/components/Charts/HoldingDurationHistogram';

export const metadata: Metadata = {
  title: 'Explorer · OMB Archive',
  description:
    'Leaderboards for the Ordinal Maxi Biz collection: most-transferred, longest-unmoved, top sale volume, top holders.',
};

// Skip build-time pre-rendering — getDb() can't open /data/app.db in the build
// container. Per-request SSR is fast (~25ms for 5 SELECTs against a 9k-row
// SQLite) and the API routes the page no longer calls still have CF caching
// for whatever else might hit them.
export const dynamic = 'force-dynamic';

export default async function ExplorerPage({
  searchParams,
}: {
  searchParams: Promise<{ color?: string }>;
}) {
  const sp = await searchParams;
  const color = parseColorParam(sp.color);
  const colorParam = colorParamForSql(color);

  const stmts = getStmts();
  const collection = 'omb';
  const transfers = stmts.topByTransfers.all({
    limit: 10,
    collection,
    color: colorParam,
  }) as InscriptionRow[];
  const unmoved = stmts.topByLongestUnmoved.all({
    limit: 10,
    collection,
    color: colorParam,
  }) as InscriptionRow[];
  const volume = stmts.topByVolume.all({
    limit: 10,
    collection,
    color: colorParam,
  }) as InscriptionRow[];
  const highSale = stmts.topByHighestSale.all({
    limit: 10,
    collection,
    color: colorParam,
  }) as InscriptionRow[];
  const holderRows = stmts.topHoldersGrouped.all({
    limit: 25,
    collection,
    color: colorParam,
  }) as GroupedHolderRow[];
  const holderBuckets = stmts.holderDistributionBuckets.all({
    collection,
    color: colorParam,
  }) as HolderDistributionBucketRow[];
  const durationBuckets = stmts.holdingDurationBuckets.all({
    collection,
    color: colorParam,
  }) as HoldingDurationBucketRow[];
  const holders: ApiHolder[] = holderRows.map(r => ({
    group_key: r.group_key,
    is_user: r.is_user === 1,
    username: r.username,
    avatar_url: r.avatar_url,
    wallets: (r.wallets_csv ?? '').split(',').filter(Boolean),
    inscription_count: r.inscription_count,
    updated_at: r.updated_at,
  }));

  return (
    <SubpageShell active="explorer" color={color} headerControls={<HeaderColorSwatches />}>
      <section className="px-4 sm:px-6 pb-16">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <HolderDistributionHistogram buckets={holderBuckets} />
          <HoldingDurationHistogram buckets={durationBuckets} />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Leaderboard type="most-transferred" items={transfers} showSeeAll color={color} />
          <Leaderboard type="longest-unmoved" items={unmoved} showSeeAll color={color} />
          <Leaderboard type="top-volume" items={volume} showSeeAll color={color} />
          <Leaderboard type="highest-sale" items={highSale} showSeeAll color={color} />
          <div className="md:col-span-2">
            <Leaderboard type="top-holders" items={holders} showSeeAll color={color} />
          </div>
        </div>
      </section>
    </SubpageShell>
  );
}
