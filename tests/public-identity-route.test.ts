import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  buyer: vi.fn(),
  providerSession: vi.fn(),
  fetchProfile: vi.fn(),
  sharing: vi.fn(),
  share: vi.fn(),
  remove: vi.fn(),
  walletLink: vi.fn(),
  roles: vi.fn(),
  rate: vi.fn(),
}));

vi.mock('@/lib/buyerSession', () => ({
  BUYER_COOKIE_NAME: 'omb_buyer_session',
  ORDNET_SESSION_COOKIE_NAME: 'omb_ordnet_session',
  parseBuyerSession: mocks.buyer,
  parseOrdnetBuyerSession: mocks.providerSession,
}));
vi.mock('@/lib/db', () => ({
  getStmts: () => ({ getWalletLink: { get: mocks.walletLink } }),
}));
vi.mock('@/lib/ordnet', () => ({
  fetchOrdnetProfile: mocks.fetchProfile,
  OrdnetError: class OrdnetError extends Error {
    constructor(
      message: string,
      readonly status: number
    ) {
      super(message);
    }
  },
}));
vi.mock('@/lib/publicIdentityStore', () => ({
  getOrdnetIdentitySharing: mocks.sharing,
  shareOrdnetIdentity: mocks.share,
  removeOrdnetIdentity: mocks.remove,
}));
vi.mock('@/lib/rolesStore', () => ({ runRolesTick: mocks.roles }));
vi.mock('@/lib/marketplace/apiGuards', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/marketplace/apiGuards')>();
  return { ...original, requireMarketplaceEnabled: () => null, marketplaceRateLimit: mocks.rate };
});

import { GET, POST, DELETE } from '@/app/api/profile/ordnet/route';
import { OrdnetError } from '@/lib/ordnet';

const profile = { id: 'profile-alice', username: 'Alice', avatarUrl: 'https://example.com/a.png' };
const binding = {
  walletBindingId: 'binding-1',
  ordinalsAddress: 'bc1p-ord',
  paymentAddress: 'bc1q-pay',
  isPublic: true,
  provider: 'xverse',
  label: 'Main',
};
const buyer = { ord_addr: binding.ordinalsAddress, pay_addr: binding.paymentAddress };
const provider = {
  ...buyer,
  session_token: 'private-bearer',
  wallet_binding_id: binding.walletBindingId,
};

function request(method = 'GET', body?: unknown, origin = 'https://archive.test', query = '') {
  return new NextRequest(`https://archive.test/api/profile/ordnet${query}`, {
    method,
    headers: {
      origin,
      cookie: 'omb_buyer_session=buyer; omb_ordnet_session=provider',
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const target = { expected_wallet_address: buyer.ord_addr };
const consent = { publish: true, expected_profile_id: profile.id, ...target };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://archive.test');
  mocks.buyer.mockReturnValue(buyer);
  mocks.providerSession.mockReturnValue(provider);
  mocks.fetchProfile.mockResolvedValue({ profile, walletBindings: [binding] });
  mocks.walletLink.mockReturnValue(undefined);
  mocks.sharing.mockReturnValue(null);
  mocks.rate.mockReturnValue(null);
});

describe('ORD.NET publication API boundaries', () => {
  it('reads local sharing without needing an upstream session and never returns tokens', async () => {
    mocks.providerSession.mockReturnValue(null);
    const response = await GET(request());
    expect(await response.json()).toEqual({
      wallet_address: buyer.ord_addr,
      sharing: null,
      matrica_linked: false,
    });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.fetchProfile).not.toHaveBeenCalled();
  });

  it('requires a signed local wallet session', async () => {
    mocks.buyer.mockReturnValue(null);
    expect((await GET(request())).status).toBe(401);
    expect((await POST(request('POST', consent))).status).toBe(401);
    expect((await DELETE(request('DELETE', target))).status).toBe(401);
    expect(mocks.fetchProfile).not.toHaveBeenCalled();
  });

  it.each([
    ['Alice', true],
    [null, true],
    ['', true],
    ['a'.repeat(30), true],
    ['bc1p' + 'a'.repeat(55), false],
    ['a'.repeat(31), false],
  ])('reports claimed Matrica priority accurately for username %j', async (username, expected) => {
    mocks.walletLink.mockReturnValue({ matrica_user_id: 'matrica-user', username });
    const response = await GET(request());
    expect((await response.json()).matrica_linked).toBe(expected);
  });

  it.each(['POST', 'DELETE'])('rejects a cross-origin %s before mutation', async method => {
    const response =
      method === 'POST'
        ? await POST(request(method, consent, 'https://other.test'))
        : await DELETE(request(method, undefined, 'https://other.test'));
    expect(response.status).toBe(403);
    expect(mocks.share).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.fetchProfile).not.toHaveBeenCalled();
  });

  it.each(['POST', 'DELETE'])(
    'pins %s consent to the displayed wallet across tabs',
    async method => {
      // Another tab has signed in to wallet B, which can share the same provider profile.
      mocks.buyer.mockReturnValue({ ...buyer, ord_addr: 'bc1p-wallet-b' });
      mocks.providerSession.mockReturnValue({ ...provider, ord_addr: 'bc1p-wallet-b' });
      const response =
        method === 'POST'
          ? await POST(request(method, consent))
          : await DELETE(request(method, target));
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe('wallet-changed');
      expect(mocks.fetchProfile).not.toHaveBeenCalled();
      expect(mocks.share).not.toHaveBeenCalled();
      expect(mocks.remove).not.toHaveBeenCalled();
      expect(mocks.roles).not.toHaveBeenCalled();
    }
  );

  it('requires an explicit wallet target before withdrawal', async () => {
    const response = await DELETE(request('DELETE'));
    expect(response.status).toBe(400);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('previews only matched binding metadata, never private addresses or bearer credentials', async () => {
    mocks.fetchProfile.mockResolvedValue({
      profile,
      walletBindings: [
        binding,
        { ...binding, ordinalsAddress: 'private-other-wallet', isPublic: false },
      ],
    });
    const response = await GET(request('GET', undefined, undefined, '?preview=true'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.preview).toEqual({
      profile_id: profile.id,
      username: 'Alice',
      avatar_url: null,
      is_public: true,
    });
    expect(JSON.stringify(body)).not.toContain('private-other-wallet');
    expect(JSON.stringify(body)).not.toContain('private-bearer');
    expect(JSON.stringify(body)).not.toContain('bc1q-pay');
  });

  it('publishes authoritative upstream metadata and ignores client supplied profile and wallets', async () => {
    mocks.sharing.mockReturnValue({ profile_id: profile.id, username: 'Alice' });
    const response = await POST(
      request('POST', {
        ...consent,
        profile: { id: 'attacker', username: 'Injected' },
        walletAddress: 'victim',
        walletBindings: [{ ...binding, ordinalsAddress: 'victim' }],
      })
    );
    expect(response.status).toBe(200);
    expect(mocks.share).toHaveBeenCalledWith({
      walletAddress: buyer.ord_addr,
      profile,
      walletBindings: [binding],
    });
    expect(await response.json()).toEqual({
      wallet_address: buyer.ord_addr,
      sharing: { profile_id: profile.id, username: 'Alice' },
      matrica_linked: false,
    });
  });

  it.each([
    { publish: false },
    { publish: true },
    { publish: true, expected_profile_id: 1 },
    { publish: true, expected_profile_id: profile.id },
  ])('requires explicit publication and preview confirmation %j', async body => {
    expect((await POST(request('POST', body))).status).toBe(400);
    expect(mocks.fetchProfile).not.toHaveBeenCalled();
    expect(mocks.share).not.toHaveBeenCalled();
  });

  it('requires re-preview if the authenticated profile changes', async () => {
    mocks.fetchProfile.mockResolvedValue({
      profile: { ...profile, id: 'changed-profile' },
      walletBindings: [binding],
    });
    expect((await POST(request('POST', consent))).status).toBe(409);
    expect(mocks.share).not.toHaveBeenCalled();
  });

  it.each([false, 'false'])('refuses private binding flag %j at publication', async flag => {
    mocks.fetchProfile.mockResolvedValue({
      profile,
      walletBindings: [{ ...binding, isPublic: flag }],
    });
    const response = await POST(request('POST', consent));
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('private-wallet');
    expect(mocks.share).not.toHaveBeenCalled();
  });

  it.each([{ ord_addr: 'other-ordinal' }, { pay_addr: 'other-payment' }])(
    'rejects provider cookie wallet mismatch %j',
    async change => {
      mocks.providerSession.mockReturnValue({ ...provider, ...change });
      expect((await POST(request('POST', consent))).status).toBe(428);
      expect(mocks.fetchProfile).not.toHaveBeenCalled();
    }
  );

  it.each([
    { walletBindingId: 'other-binding' },
    { ordinalsAddress: 'other-ordinal' },
    { paymentAddress: 'other-payment' },
  ])('rejects stale or mismatched upstream binding %j', async change => {
    mocks.fetchProfile.mockResolvedValue({ profile, walletBindings: [{ ...binding, ...change }] });
    expect((await POST(request('POST', consent))).status).toBe(409);
    expect(mocks.share).not.toHaveBeenCalled();
  });

  it('turns an expired upstream token into reauthorization', async () => {
    mocks.fetchProfile.mockRejectedValue(new OrdnetError('private account data', 401, false));
    const response = await POST(request('POST', consent));
    expect(response.status).toBe(428);
    expect((await response.json()).code).toBe('ordnet-auth-required');
    expect(mocks.share).not.toHaveBeenCalled();
  });

  it('does not expose upstream account data on provider failure', async () => {
    mocks.fetchProfile.mockRejectedValue(new Error('private upstream profile dump'));
    const response = await POST(request('POST', consent));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('private upstream');
    expect(mocks.share).not.toHaveBeenCalled();
  });

  it('withdraws only the authenticated wallet even with no provider session or upstream service', async () => {
    mocks.providerSession.mockReturnValue(null);
    mocks.fetchProfile.mockRejectedValue(new Error('offline'));
    const response = await DELETE(request('DELETE', target));
    expect(response.status).toBe(200);
    expect(mocks.remove).toHaveBeenCalledWith(buyer.ord_addr);
    expect(mocks.fetchProfile).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      wallet_address: buyer.ord_addr,
      sharing: null,
      matrica_linked: false,
    });
  });
});
