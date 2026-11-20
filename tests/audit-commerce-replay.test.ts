import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({ status: 'broadcast', claim: vi.fn() }));
vi.mock('@/lib/buyerSession', () => ({
  BUYER_COOKIE_NAME: 'buyer',
  ORDNET_SESSION_COOKIE_NAME: 'ordnet',
  parseBuyerSession: () => ({ ord_addr: 'buyer-address' }),
  parseOrdnetBuyerSession: () => null,
}));
vi.mock('@/lib/marketplace/apiGuards', () => ({
  requireMarketplaceEnabled: () => null,
  marketplaceRateLimit: () => null,
}));
vi.mock('@/lib/marketplace/buyIntentsStore', () => ({
  getBuyIntent: () => ({
    id: 1,
    status: state.status,
    txid: 'ab'.repeat(32),
    buyer_ord_addr: 'buyer-address',
    is_mock: 0,
  }),
  claimIntentBroadcast: state.claim,
  advanceIntentBroadcast: vi.fn(),
  completeIntentBroadcast: vi.fn(),
  failIntentBroadcast: vi.fn(),
}));
vi.mock('@/lib/marketplace/listings', () => ({ marketplaceMockEnabled: () => false }));
vi.mock('@/lib/marketplace/mock', () => ({ mockBroadcast: vi.fn() }));
vi.mock('@/lib/ordnet', () => ({ broadcastOrdnetPurchase: vi.fn(), ordnetErrorResponse: vi.fn() }));
vi.mock('@/lib/marketplace/satflowBuy', () => ({
  broadcastSatflowPurchase: vi.fn(),
  satflowBuyErrorResponse: vi.fn(),
}));
vi.mock('@/lib/marketplace/dreyContext', () => ({ withSatflowDreyContexts: vi.fn() }));
import { POST } from '@/app/api/marketplace/broadcast/route';

beforeEach(() => {
  state.claim.mockReset().mockReturnValue(false);
});
function request() {
  return new NextRequest('http://localhost/api/marketplace/broadcast', {
    method: 'POST',
    body: JSON.stringify({ intent_id: 1, signed_psbt: 'test-only-no-transaction' }),
    headers: { 'Content-Type': 'application/json' },
  });
}
describe('audit: marketplace purchase retry after confirmation', () => {
  it('replays a broadcast purchase with its saved transaction ID', async () => {
    state.status = 'broadcast';
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect((await response.json()).txid).toBe('ab'.repeat(32));
    expect(state.claim).not.toHaveBeenCalled();
  });
  it('replays a confirmed purchase with its saved transaction ID', async () => {
    state.status = 'confirmed';
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect((await response.json()).txid).toBe('ab'.repeat(32));
  });
});
