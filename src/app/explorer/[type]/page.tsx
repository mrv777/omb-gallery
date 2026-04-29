import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import SubpageShell from '@/components/SubpageShell';
import Leaderboard from '@/components/Explorer/Leaderboard';
import { LEADERBOARDS, type LeaderboardKey } from '@/components/Explorer/types';
import { getStmts, type InscriptionRow } from '@/lib/db';

const VALID: LeaderboardKey[] = [
  'most-transferred',
  'longest-unmoved',
  'top-volume',
  'highest-sale',
];

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ type: string }>;
}): Promise<Metadata> {
  const { type } = await params;
  const meta = LEADERBOARDS[type as LeaderboardKey];
  if (!meta) return { title: 'Explorer · OMB Archive' };
  return {
    title: `${meta.title} · OMB Archive`,
    description: meta.blurb,
  };
}

export default async function LeaderboardDetailPage({
  params,
}: {
  params: Promise<{ type: string }>;
}) {
  const { type: typeRaw } = await params;
  if (!VALID.includes(typeRaw as LeaderboardKey)) notFound();
  const type = typeRaw as LeaderboardKey;

  const stmts = getStmts();
  const collection = 'omb';
  const limit = 100;
  const items = (() => {
    switch (type) {
      case 'most-transferred':
        return stmts.topByTransfers.all({ limit, collection }) as InscriptionRow[];
      case 'longest-unmoved':
        return stmts.topByLongestUnmoved.all({ limit, collection }) as InscriptionRow[];
      case 'top-volume':
        return stmts.topByVolume.all({ limit, collection }) as InscriptionRow[];
      case 'highest-sale':
        return stmts.topByHighestSale.all({ limit, collection }) as InscriptionRow[];
      default:
        return [] as InscriptionRow[];
    }
  })();

  return (
    <SubpageShell active="explorer">
      <section className="px-4 sm:px-6 pb-16">
        <div className="max-w-2xl">
          <Leaderboard type={type} items={items} />
        </div>
      </section>
    </SubpageShell>
  );
}
