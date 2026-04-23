import { NextRequest, NextResponse } from 'next/server';
import { getStmts, type EventRow, type InscriptionRow } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ number: string }> }
) {
  const { number: numStr } = await ctx.params;
  const num = parseInt(numStr, 10);
  if (!Number.isFinite(num)) {
    return NextResponse.json({ error: 'invalid inscription number' }, { status: 400 });
  }

  const stmts = getStmts();
  const inscription = stmts.getInscription.get(num) as InscriptionRow | undefined;
  if (!inscription) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const events = stmts.getInscriptionEvents.all(num) as EventRow[];
  return NextResponse.json({ inscription, events });
}
