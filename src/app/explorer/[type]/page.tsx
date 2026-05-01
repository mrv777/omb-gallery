import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import SubpageShell from '@/components/SubpageShell';
import HeaderColorSwatches from '@/components/HeaderColorSwatches';
import LeaderboardFeed from '@/components/Explorer/LeaderboardFeed';
import { LEADERBOARDS, type LeaderboardKey } from '@/components/Explorer/types';
import { getStmts, type GroupedHolderRow, type InscriptionRow } from '@/lib/db';
import type { ApiHolder, ApiInscription } from '@/components/Activity/types';
import type { LeaderboardItem } from '@/components/Explorer/useLeaderboardFeed';
import { colorParamForSql, parseColorParam } from '@/lib/colorFilter';

const VALID: LeaderboardKey[] = [
  'most-transferred',
  'longest-unmoved',
  'top-volume',
  'highest-sale',
  'top-holders',
];

// Page-1 size matches the client hook's PAGE_SIZE so the initial SSR render
// fills exactly one page worth of rows; the client picks up paginating from
// there with the cursor we attach to `initial`.
const PAGE_SIZE = 50;

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

  // Fetch the first page using the same paginated statements the API route
  // uses. Passing `null` cursors selects the first page; we then derive a
  // next_cursor from the last row so the client can keep paginating without
  // a wasted re-fetch of page 1 on mount.
  let items: LeaderboardItem[];
  let nextCursor: string | null;

  if (type === 'top-holders') {
    const rows = stmts.topHoldersGroupedPaged.all({
      limit: PAGE_SIZE,
      collection,
      color: colorParam,
      cursor_primary: null,
      cursor_secondary: null,
    }) as GroupedHolderRow[];
    const holders: ApiHolder[] = rows.map(r => ({
      group_key: r.group_key,
      is_user: r.is_user === 1,
      username: r.username,
      avatar_url: r.avatar_url,
      wallets: (r.wallets_csv ?? '').split(',').filter(Boolean),
      inscription_count: r.inscription_count,
      updated_at: r.updated_at,
    }));
    items = holders;
    nextCursor =
      holders.length === PAGE_SIZE
        ? `${holders[holders.length - 1].inscription_count}:${holders[holders.length - 1].group_key}`
        : null;
  } else {
    const stmt = (() => {
      switch (type) {
        case 'most-transferred':
          return stmts.topByTransfersPaged;
        case 'longest-unmoved':
          return stmts.topByLongestUnmovedPaged;
        case 'top-volume':
          return stmts.topByVolumePaged;
        case 'highest-sale':
          return stmts.topByHighestSalePaged;
        default:
          throw new Error(`unhandled type ${type}`);
      }
    })();
    const rows = stmt.all({
      limit: PAGE_SIZE,
      collection,
      color: colorParam,
      cursor_primary: null,
      cursor_secondary: null,
    }) as InscriptionRow[];
    const inscriptions: ApiInscription[] = rows;
    items = inscriptions;
    nextCursor =
      inscriptions.length === PAGE_SIZE
        ? buildInscriptionCursor(inscriptions[inscriptions.length - 1], type)
        : null;
  }

  return (
    <SubpageShell active="explorer" color={color} headerControls={<HeaderColorSwatches />}>
      <section className="px-4 sm:px-6 pb-16">
        <div className="max-w-6xl">
          <LeaderboardFeed type={type} color={color} initial={{ items, next_cursor: nextCursor }} />
        </div>
      </section>
    </SubpageShell>
  );
}

function buildInscriptionCursor(
  row: ApiInscription,
  type: Exclude<LeaderboardKey, 'top-holders'>
): string | null {
  const num = row.inscription_number;
  switch (type) {
    case 'most-transferred':
      return `${row.transfer_count + row.sale_count}:${num}`;
    case 'longest-unmoved':
      return row.last_movement_at != null ? `${row.last_movement_at}:${num}` : null;
    case 'top-volume':
      return `${row.total_volume_sats}:${num}`;
    case 'highest-sale':
      return `${row.highest_sale_sats}:${num}`;
  }
}
