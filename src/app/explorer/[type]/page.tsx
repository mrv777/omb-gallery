import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import SubpageShell from '@/components/SubpageShell';
import Leaderboard from '@/components/Explorer/Leaderboard';
import { LEADERBOARDS, type LeaderboardKey } from '@/components/Explorer/types';

const VALID: LeaderboardKey[] = [
  'most-transferred',
  'longest-unmoved',
  'top-volume',
  'highest-sale',
];

export async function generateMetadata(
  { params }: { params: Promise<{ type: string }> }
): Promise<Metadata> {
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
  return (
    <SubpageShell active="explorer">
      <section className="px-4 sm:px-6 pb-16">
        <div className="max-w-2xl">
          <Leaderboard type={type} limit={100} />
        </div>
      </section>
    </SubpageShell>
  );
}
