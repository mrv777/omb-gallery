import { NextRequest, NextResponse } from 'next/server';
import { getStmts, type GroupedHolderRow, type InscriptionRow } from '@/lib/db';
import type { ApiHolder } from '@/components/Activity/types';
import { colorParamForSql, parseColorParam } from '@/lib/colorFilter';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const TYPES = [
  'most-transferred',
  'longest-unmoved',
  'top-volume',
  'highest-sale',
  'top-holders',
] as const;
type LeaderboardType = (typeof TYPES)[number];

export async function GET(req: NextRequest, ctx: { params: Promise<{ type: string }> }) {
  const { type: typeRaw } = await ctx.params;
  if (!TYPES.includes(typeRaw as LeaderboardType)) {
    return NextResponse.json({ error: `unknown leaderboard type: ${typeRaw}` }, { status: 404 });
  }
  const type = typeRaw as LeaderboardType;

  const url = new URL(req.url);
  const limit = clamp(
    parseInt(url.searchParams.get('limit') ?? '', 10) || DEFAULT_LIMIT,
    1,
    MAX_LIMIT
  );
  const collection = url.searchParams.get('collection') || 'omb';
  const color = colorParamForSql(parseColorParam(url.searchParams.get('color')));

  // Cursor format: "<primary>:<secondary>". Primary is always an integer
  // (the leaderboard's main metric — count, timestamp, or sats). Secondary
  // is the unique tie-breaker — inscription_number for inscription
  // leaderboards, group_key for top-holders. Split on the FIRST colon so
  // group_keys with embedded colons (none today, but future-proof) survive.
  const cursorParam = url.searchParams.get('cursor');
  const cursor = parseCursor(cursorParam, type);

  const stmts = getStmts();

  if (type === 'top-holders') {
    const rows = stmts.topHoldersGroupedPaged.all({
      limit,
      collection,
      color,
      cursor_primary: cursor?.primary ?? null,
      cursor_secondary: cursor ? (cursor.secondary as string) : null,
    }) as GroupedHolderRow[];
    const items: ApiHolder[] = rows.map(r => ({
      group_key: r.group_key,
      is_user: r.is_user === 1,
      username: r.username,
      avatar_url: r.avatar_url,
      wallets: (r.wallets_csv ?? '').split(',').filter(Boolean),
      inscription_count: r.inscription_count,
      updated_at: r.updated_at,
    }));
    const next_cursor =
      items.length === limit
        ? `${items[items.length - 1].inscription_count}:${items[items.length - 1].group_key}`
        : null;
    return NextResponse.json(
      { type, items, next_cursor },
      { headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=300' } }
    );
  }

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
    }
  })();

  const rows = stmt.all({
    limit,
    collection,
    color,
    cursor_primary: cursor?.primary ?? null,
    cursor_secondary: cursor ? (cursor.secondary as number) : null,
  }) as InscriptionRow[];

  const next_cursor =
    rows.length === limit ? buildInscriptionCursor(rows[rows.length - 1], type) : null;

  return NextResponse.json(
    { type, items: rows, next_cursor },
    { headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=300' } }
  );
}

type ParsedCursor = { primary: number; secondary: number | string };

function parseCursor(raw: string | null, type: LeaderboardType): ParsedCursor | null {
  if (!raw) return null;
  const idx = raw.indexOf(':');
  if (idx <= 0 || idx === raw.length - 1) return null;
  const primaryStr = raw.slice(0, idx);
  const secondaryStr = raw.slice(idx + 1);
  const primary = parseInt(primaryStr, 10);
  if (!Number.isFinite(primary)) return null;
  if (type === 'top-holders') {
    return { primary, secondary: secondaryStr };
  }
  const secondary = parseInt(secondaryStr, 10);
  if (!Number.isFinite(secondary)) return null;
  return { primary, secondary };
}

function buildInscriptionCursor(
  row: InscriptionRow,
  type: Exclude<LeaderboardType, 'top-holders'>
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

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
