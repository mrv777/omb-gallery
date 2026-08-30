import { describe, expect, it, vi } from 'vitest';
import {
  authorizeOrdnet,
  retryAfterOrdnetAuthorization,
} from '@/lib/marketplace/ordnetAuthorization';

function response(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

describe('shared ord.net authorization', () => {
  it('signs every challenge and verifies them in order', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          auth_request_id: 'auth-1',
          challenges: [
            { challenge_id: 'ord', address: 'bc1pord', message: 'ord-message', role: 'ordinals' },
            { challenge_id: 'pay', address: 'bc1qpay', message: 'pay-message', role: 'payment' },
          ],
        })
      )
      .mockResolvedValueOnce(response({ ok: true }));
    const signMessage = vi.fn(async (_address: string, message: string) =>
      message === 'ord-message' ? 'aabb' : 'ccdd'
    );

    await authorizeOrdnet(signMessage, fetcher);

    expect(signMessage.mock.calls).toEqual([
      ['bc1pord', 'ord-message'],
      ['bc1qpay', 'pay-message'],
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual({
      auth_request_id: 'auth-1',
      verifications: [
        { challenge_id: 'ord', address: 'bc1pord', signature: 'aabb' },
        { challenge_id: 'pay', address: 'bc1qpay', signature: 'ccdd' },
      ],
    });
  });

  it('retries an operation once only when authorization is required', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          auth_request_id: 'auth-1',
          challenges: [
            { challenge_id: 'ord', address: 'bc1pord', message: 'message', role: 'ordinals' },
          ],
        })
      )
      .mockResolvedValueOnce(response({ ok: true }));
    const request = vi
      .fn<() => Promise<{ ok: boolean; code?: string }>>()
      .mockResolvedValueOnce({ ok: false, code: 'ordnet-auth-required' })
      .mockResolvedValueOnce({ ok: true });

    await expect(
      retryAfterOrdnetAuthorization(
        request,
        result => result.code === 'ordnet-auth-required',
        async () => 'aabb',
        fetcher
      )
    ).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
