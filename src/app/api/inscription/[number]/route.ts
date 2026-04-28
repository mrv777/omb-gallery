import { NextRequest, NextResponse } from 'next/server';
import {
  getStmts,
  type EventRow,
  type InscriptionRow,
  type ActiveListingRow,
} from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ number: string }> }
) {
  const { number: numStr } = await ctx.params;
  const num = parseInt(numStr, 10);
  if (!Number.isFinite(num)) {
    return NextResponse.json({ error: 'invalid inscription number' }, { status: 400 });
  }
  const collection = new URL(req.url).searchParams.get('collection') || 'omb';

  const stmts = getStmts();
  // 404 covers two cases: number doesn't exist, or it exists in a different
  // collection than the one requested. Both are "not found" from the caller's
  // perspective — they get redirected/told to check the collection.
  const inscription = stmts.getInscription.get({
    inscription_number: num,
    collection,
  }) as InscriptionRow | undefined;
  if (!inscription) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const events = stmts.getInscriptionEvents.all(num) as EventRow[];
  const listing = stmts.getActiveListing.get(num) as ActiveListingRow | undefined;
  return NextResponse.json({
    inscription,
    events,
    current_listing: listing ?? null,
  });
}
