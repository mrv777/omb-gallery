import type { Metadata } from 'next';
import SubpageShell from '@/components/SubpageShell';
import Leaderboard from '@/components/Explorer/Leaderboard';
import { getStmts, type GroupedHolderRow, type InscriptionRow } from '@/lib/db';
import type { ApiHolder } from '@/components/Activity/types';

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

export default function ExplorerPage() {
  const stmts = getStmts();
  const collection = 'omb';
  const transfers = stmts.topByTransfers.all({ limit: 10, collection }) as InscriptionRow[];
  const unmoved = stmts.topByLongestUnmoved.all({ limit: 10, collection }) as InscriptionRow[];
  const volume = stmts.topByVolume.all({ limit: 10, collection }) as InscriptionRow[];
  const highSale = stmts.topByHighestSale.all({ limit: 10, collection }) as InscriptionRow[];
  const holderRows = stmts.topHoldersGrouped.all({
    limit: 25,
    collection,
  }) as GroupedHolderRow[];
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
    <SubpageShell active="explorer">
      <section className="px-4 sm:px-6 pb-16">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Leaderboard type="most-transferred" items={transfers} showSeeAll />
          <Leaderboard type="longest-unmoved" items={unmoved} showSeeAll />
          <Leaderboard type="top-volume" items={volume} showSeeAll />
          <Leaderboard type="highest-sale" items={highSale} showSeeAll />
          <div className="md:col-span-2">
            <Leaderboard type="top-holders" items={holders} />
          </div>
        </div>
      </section>
    </SubpageShell>
  );
}
