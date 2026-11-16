import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchOrdnetProfile } from '@/lib/ordnet';

afterEach(() => vi.unstubAllGlobals());

describe('ORD.NET authenticated profile contract', () => {
  it('uses only the user bearer token and disables caching', async () => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            profile: { id: 'profile-a', username: 'alice', avatarUrl: 'https://example.com/a.png' },
            walletBindings: [
              {
                walletBindingId: 'binding',
                label: 'wallet',
                provider: 'xverse',
                ordinalsAddress: 'ordinal',
                paymentAddress: 'payment',
                isPublic: true,
              },
            ],
          })
        )
    );
    vi.stubGlobal('fetch', request);
    const result = await fetchOrdnetProfile('user-session');
    expect(result.profile).toEqual({
      id: 'profile-a',
      username: 'alice',
      avatarUrl: 'https://example.com/a.png',
    });
    expect(result.walletBindings[0]?.isPublic).toBe(true);
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ord.net/api/v1/me');
    expect(init.cache).toBe('no-store');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer user-session' });
  });

  it.each([false, 'true', 'false', 1, null, undefined])(
    'never treats %s as public consent',
    async isPublic => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                profile: { id: 'profile-a' },
                walletBindings: [
                  {
                    walletBindingId: 'binding',
                    label: 'wallet',
                    provider: 'xverse',
                    ordinalsAddress: 'ordinal',
                    paymentAddress: 'payment',
                    isPublic,
                  },
                ],
              })
            )
        )
      );
      const result = await fetchOrdnetProfile('user-session');
      expect(result.walletBindings[0]?.isPublic).toBe(false);
    }
  );

  it('rejects a missing stable profile id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ profile: {}, walletBindings: [] })))
    );
    await expect(fetchOrdnetProfile('user-session')).rejects.toThrow();
  });
});
