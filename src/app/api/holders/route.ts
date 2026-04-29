import { NextRequest, NextResponse } from 'next/server';
import { getStmts, type GroupedHolderRow } from '@/lib/db';
import { colorParamForSql, parseColorParam } from '@/lib/colorFilter';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

/** Output row: one identity per row. When `is_user`, `wallets` lists every
 * BTC address we've linked to that Matrica user; otherwise it's a single-element
 * array with the raw wallet. The route layer splits the SQL's GROUP_CONCAT for
 * stable downstream consumption (no CSV in the JSON contract). */
export type HolderItem = {
  /** Stable identity key — Matrica user_id when linked, else wallet_addr. */
  group_key: string;
  is_user: boolean;
  username: string | null;
  avatar_url: string | null;
  wallets: string[];
  inscription_count: number;
  updated_at: number;
};

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const limit = clamp(
    parseInt(url.searchParams.get('limit') ?? '', 10) || DEFAULT_LIMIT,
    1,
    MAX_LIMIT
  );
  const collection = url.searchParams.get('collection') || 'omb';
  const color = colorParamForSql(parseColorParam(url.searchParams.get('color')));

  const stmts = getStmts();
  const rows = stmts.topHoldersGrouped.all({ limit, collection, color }) as GroupedHolderRow[];
  const items: HolderItem[] = rows.map(r => ({
    group_key: r.group_key,
    is_user: r.is_user === 1,
    username: r.username,
    avatar_url: r.avatar_url,
    wallets: (r.wallets_csv ?? '').split(',').filter(Boolean),
    inscription_count: r.inscription_count,
    updated_at: r.updated_at,
  }));
  const total = (stmts.countHolderIdentities.get({ collection, color }) as { n: number }).n;

  return NextResponse.json(
    { items, total },
    { headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=300' } }
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
