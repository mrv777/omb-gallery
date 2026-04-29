import { NextRequest, NextResponse } from 'next/server';
import { getStmts, type HolderRow } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const limit = clamp(
    parseInt(url.searchParams.get('limit') ?? '', 10) || DEFAULT_LIMIT,
    1,
    MAX_LIMIT
  );
  const collection = url.searchParams.get('collection') || 'omb';

  const stmts = getStmts();
  const items = stmts.topHolders.all({ limit, collection }) as HolderRow[];
  const total = (stmts.countHolders.get({ collection }) as { n: number }).n;

  return NextResponse.json(
    { items, total },
    { headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=300' } }
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
