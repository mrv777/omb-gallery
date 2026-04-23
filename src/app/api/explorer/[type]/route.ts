import { NextRequest, NextResponse } from 'next/server';
import { getStmts, type InscriptionRow } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const TYPES = ['most-transferred', 'longest-unmoved', 'top-volume', 'highest-sale'] as const;
type LeaderboardType = (typeof TYPES)[number];

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ type: string }> }
) {
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

  const stmts = getStmts();
  let rows: InscriptionRow[];
  switch (type) {
    case 'most-transferred':
      rows = stmts.topByTransfers.all({ limit }) as InscriptionRow[];
      break;
    case 'longest-unmoved':
      rows = stmts.topByLongestUnmoved.all({ limit }) as InscriptionRow[];
      break;
    case 'top-volume':
      rows = stmts.topByVolume.all({ limit }) as InscriptionRow[];
      break;
    case 'highest-sale':
      rows = stmts.topByHighestSale.all({ limit }) as InscriptionRow[];
      break;
  }

  return NextResponse.json({ type, items: rows });
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
