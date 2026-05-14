import { NextRequest, NextResponse } from 'next/server';
import { BUYER_COOKIE_NAME, parseBuyerSession } from '@/lib/buyerSession';
import { listBuyerIntents } from '@/lib/marketplace/buyIntentsStore';
import { requireMarketplaceEnabled } from '@/lib/marketplace/apiGuards';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const disabled = requireMarketplaceEnabled();
  if (disabled) return disabled;

  const session = parseBuyerSession(req.cookies.get(BUYER_COOKIE_NAME)?.value);
  if (!session) return NextResponse.json({ error: 'connect wallet first' }, { status: 401 });
  return NextResponse.json({
    session,
    intents: listBuyerIntents(session.ord_addr),
  });
}
