import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import SubpageShell from '@/components/SubpageShell';
import HeaderColorSwatches from '@/components/HeaderColorSwatches';
import Leaderboard from '@/components/Explorer/Leaderboard';
import { LEADERBOARDS, type LeaderboardKey } from '@/components/Explorer/types';
import { getStmts, type GroupedHolderRow, type InscriptionRow } from '@/lib/db';
import type { ApiHolder } from '@/components/Activity/types';
import { colorParamForSql, parseColorParam } from '@/lib/colorFilter';

const VALID: LeaderboardKey[] = [
  'most-transferred',
  'longest-unmoved',
  'top-volume',
  'highest-sale',
  'top-holders',
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
  searchParams,
}: {
  params: Promise<{ type: string }>;
  searchParams: Promise<{ color?: string }>;
}) {
  const { type: typeRaw } = await params;
  if (!VALID.includes(typeRaw as LeaderboardKey)) notFound();
  const type = typeRaw as LeaderboardKey;

  const sp = await searchParams;
  const color = parseColorParam(sp.color);
  const colorParam = colorParamForSql(color);

  const stmts = getStmts();
  const collection = 'omb';
  const limit = 100;
  const items: InscriptionRow[] | ApiHolder[] = (() => {
    switch (type) {
      case 'most-transferred':
        return stmts.topByTransfers.all({ limit, collection, color: colorParam }) as InscriptionRow[];
      case 'longest-unmoved':
        return stmts.topByLongestUnmoved.all({
          limit,
          collection,
          color: colorParam,
        }) as InscriptionRow[];
      case 'top-volume':
        return stmts.topByVolume.all({ limit, collection, color: colorParam }) as InscriptionRow[];
      case 'highest-sale':
        return stmts.topByHighestSale.all({
          limit,
          collection,
          color: colorParam,
        }) as InscriptionRow[];
      case 'top-holders': {
        const rows = stmts.topHoldersGrouped.all({
          limit,
          collection,
          color: colorParam,
        }) as GroupedHolderRow[];
        return rows.map(
          (r): ApiHolder => ({
            group_key: r.group_key,
            is_user: r.is_user === 1,
            username: r.username,
            avatar_url: r.avatar_url,
            wallets: (r.wallets_csv ?? '').split(',').filter(Boolean),
            inscription_count: r.inscription_count,
            updated_at: r.updated_at,
          })
        );
      }
      default:
        return [] as InscriptionRow[];
    }
  })();

  return (
    <SubpageShell active="explorer" color={color} headerControls={<HeaderColorSwatches />}>
      <section className="px-4 sm:px-6 pb-16">
        <div className="max-w-2xl">
          <Leaderboard type={type} items={items} color={color} />
        </div>
      </section>
    </SubpageShell>
  );
}
