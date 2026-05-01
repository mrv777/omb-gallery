import { NextRequest, NextResponse } from 'next/server';
import {
  decodeCursor,
  encodeCursor,
  fetchHolderEventsPage,
  resolveAggregatedWallets,
} from '@/lib/holderEvents';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_ADDR_LEN = 100;

type Params = { address: string };

export async function GET(req: NextRequest, { params }: { params: Promise<Params> }) {
  const { address } = await params;
  if (!address || address.length > MAX_ADDR_LEN) {
    return NextResponse.json({ error: 'invalid address' }, { status: 400 });
  }

  const url = new URL(req.url);
  const limit = clamp(
    parseInt(url.searchParams.get('limit') ?? '', 10) || DEFAULT_LIMIT,
    1,
    MAX_LIMIT
  );
  const cursor = decodeCursor(url.searchParams.get('cursor'));

  const { wallets } = resolveAggregatedWallets(address);
  const { events, nextCursor } = fetchHolderEventsPage(wallets, cursor, limit);

  return NextResponse.json({
    events,
    next_cursor: nextCursor ? encodeCursor(nextCursor) : null,
  });
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
