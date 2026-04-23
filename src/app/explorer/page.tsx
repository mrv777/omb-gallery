import type { Metadata } from 'next';
import SubpageShell from '@/components/SubpageShell';
import Leaderboard from '@/components/Explorer/Leaderboard';

export const metadata: Metadata = {
  title: 'Explorer · OMB Archive',
  description:
    'Leaderboards for the Ordinal Maxi Biz collection: most-transferred, longest-held, top sale volume, top holders.',
};

export default function ExplorerPage() {
  return (
    <SubpageShell active="explorer">
      <section className="px-4 sm:px-6 pb-16">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Leaderboard type="most-transferred" limit={10} showSeeAll />
          <Leaderboard type="longest-unmoved" limit={10} showSeeAll />
          <Leaderboard type="top-volume" limit={10} showSeeAll />
          <Leaderboard type="highest-sale" limit={10} showSeeAll />
          <div className="md:col-span-2">
            <Leaderboard type="top-holders" limit={25} />
          </div>
        </div>
      </section>
    </SubpageShell>
  );
}
