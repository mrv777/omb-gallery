import { NextRequest, NextResponse } from 'next/server';
import { BUYER_COOKIE_NAME, parseBuyerSession } from '@/lib/buyerSession';
import { listSellerOmbs } from '@/lib/marketplace/listingIntentsStore';
import {
  requireMarketplaceEnabled,
  requireMarketplaceSellingEnabled,
} from '@/lib/marketplace/apiGuards';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const disabled = requireMarketplaceEnabled() ?? requireMarketplaceSellingEnabled();
  if (disabled) return disabled;
  const session = parseBuyerSession(req.cookies.get(BUYER_COOKIE_NAME)?.value);
  if (!session) {
    return NextResponse.json(
      { error: 'connect wallet first', code: 'auth-required' },
      { status: 401 }
    );
  }
  const limitRaw = Number(req.nextUrl.searchParams.get('limit') ?? 100);
  const limit = Number.isSafeInteger(limitRaw) ? Math.max(1, Math.min(limitRaw, 100)) : 100;
  const cursorRaw = req.nextUrl.searchParams.get('cursor');
  const cursor = cursorRaw == null ? null : Number(cursorRaw);
  if (cursor != null && (!Number.isSafeInteger(cursor) || cursor < 0)) {
    return NextResponse.json({ error: 'invalid cursor', code: 'invalid-request' }, { status: 400 });
  }
  const page = listSellerOmbs({ sellerOrdAddr: session.ord_addr, cursor, limit });
  return NextResponse.json({
    items: page.items.map(item => {
      const active = item.listings.find(
        listing =>
          listing.seller === session.ord_addr &&
          listing.marketplace.toLowerCase().replace(/[^a-z0-9]/gu, '') === 'ordnet'
      );
      return {
        ...item,
        postage_sats: null,
        listability_reasons: item.listability_reason ? [item.listability_reason] : [],
        active_listing: active
          ? {
              ...active,
              status: active.status ?? 'active',
            }
          : null,
      };
    }),
    next_cursor: page.nextCursor == null ? null : String(page.nextCursor),
  });
}
