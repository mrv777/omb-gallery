import { NextRequest, NextResponse } from 'next/server';
import { runSearch } from '@/lib/search';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 8;
const MAX_QUERY_LENGTH = 200;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const rawQ = (url.searchParams.get('q') ?? '').slice(0, MAX_QUERY_LENGTH);
  const limit = clamp(
    parseInt(url.searchParams.get('limit') ?? '', 10) || DEFAULT_LIMIT,
    1,
    MAX_LIMIT
  );

  const results = runSearch(rawQ, { limit, allowRedirect: false });
  // Strip the `redirect` field from the dropdown payload — autocomplete never
  // navigates on its own, the user's Enter does.
  const { redirect: _redirect, ...payload } = results;
  void _redirect;

  return NextResponse.json(payload, {
    headers: { 'Cache-Control': 'private, max-age=15' },
  });
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
