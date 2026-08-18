import { describe, expect, it, vi } from 'vitest';
import { DonationWalletError, sendDonation, type DonationRequest } from '@/lib/donationWallet';
import { DONATION_CONFIG } from '@/lib/donation';

const TXID = 'ab'.repeat(32);
const DREY_WINDOW = { drey: { request() {} } };
const XVERSE_WINDOW = { XverseProviders: { BitcoinProvider: { request() {} } } };
const DREY_BALANCE_PERMISSIONS = [
  {
    type: 'account',
    resourceId: 'active',
    actions: { read: true },
    dataCategories: ['account', 'addresses', 'balance'],
  },
];
const DREY_CONNECT_PARAMS = {
  addresses: ['payment'],
  message: 'Support the OMB site.',
  network: 'Mainnet',
  permissions: [
    {
      type: 'account',
      resourceId: 'active',
      actions: { read: true },
      dataCategories: ['balance'],
    },
  ],
};

describe('donation wallet handoff', () => {
  it('connects when permissions are empty, then sends the exact recipient and amount', async () => {
    const request = vi
      .fn<DonationRequest>()
      .mockResolvedValueOnce({ status: 'success', result: [] })
      .mockResolvedValueOnce({ status: 'success', result: { id: 'account' } })
      .mockResolvedValueOnce({ status: 'success', result: { txid: TXID } });

    await expect(
      sendDonation('drey', 50_000, { providerWindow: DREY_WINDOW, request })
    ).resolves.toEqual({ txid: TXID });
    expect(request.mock.calls.map(call => call[0])).toEqual([
      'wallet_getCurrentPermissions',
      'wallet_connect',
      'sendTransfer',
    ]);
    expect(request.mock.calls[1]).toEqual(['wallet_connect', DREY_CONNECT_PARAMS, 'drey']);
    expect(request.mock.calls[2]).toEqual([
      'sendTransfer',
      {
        recipients: [{ address: DONATION_CONFIG.address, amount: 50_000 }],
      },
      'drey',
    ]);
  });

  it('upgrades an existing Drey connection that lacks balance permission', async () => {
    const request = vi
      .fn<DonationRequest>()
      .mockResolvedValueOnce({
        status: 'success',
        result: [
          {
            type: 'account',
            resourceId: 'active',
            actions: { read: true },
            dataCategories: ['account', 'addresses'],
          },
        ],
      })
      .mockResolvedValueOnce({ status: 'success', result: { id: 'account' } })
      .mockResolvedValueOnce({ status: 'success', result: { txid: TXID } });

    await sendDonation('drey', 50_000, { providerWindow: DREY_WINDOW, request });
    expect(request.mock.calls.map(call => call[0])).toEqual([
      'wallet_getCurrentPermissions',
      'wallet_connect',
      'sendTransfer',
    ]);
    expect(request.mock.calls[1]).toEqual(['wallet_connect', DREY_CONNECT_PARAMS, 'drey']);
  });

  it('does not reconnect Drey when balance permission is already granted', async () => {
    const request = vi
      .fn<DonationRequest>()
      .mockResolvedValueOnce({ status: 'success', result: DREY_BALANCE_PERMISSIONS })
      .mockResolvedValueOnce({ status: 'success', result: { txid: TXID } });

    await sendDonation('drey', 50_000, { providerWindow: DREY_WINDOW, request });
    expect(request.mock.calls.map(call => call[0])).toEqual([
      'wallet_getCurrentPermissions',
      'sendTransfer',
    ]);
  });

  it('keeps Drey-specific permission fields out of the Xverse connection request', async () => {
    const request = vi
      .fn<DonationRequest>()
      .mockResolvedValueOnce({ status: 'success', result: [] })
      .mockResolvedValueOnce({ status: 'success', result: { id: 'account' } })
      .mockResolvedValueOnce({ status: 'success', result: { txid: TXID } });

    await sendDonation('xverse', 50_000, { providerWindow: XVERSE_WINDOW, request });
    expect(request.mock.calls[1]).toEqual([
      'wallet_connect',
      {
        addresses: ['payment'],
        message: 'Support the OMB site.',
        network: 'Mainnet',
      },
      'XverseProviders.BitcoinProvider',
    ]);
  });

  it('proceeds directly when an older provider does not support permission reads', async () => {
    const request = vi
      .fn<DonationRequest>()
      .mockResolvedValueOnce({
        status: 'error',
        error: { code: -32601, message: 'Method not found' },
      })
      .mockResolvedValueOnce({ status: 'success', result: { txid: TXID } });

    await sendDonation('drey', 10_000, { providerWindow: DREY_WINDOW, request });
    expect(request.mock.calls.map(call => call[0])).toEqual([
      'wallet_getCurrentPermissions',
      'sendTransfer',
    ]);
  });

  it('connects and retries once when Drey reports its exact missing-account error', async () => {
    const request = vi
      .fn<DonationRequest>()
      .mockResolvedValueOnce({
        status: 'error',
        error: { code: -32601, message: 'Unsupported method' },
      })
      .mockResolvedValueOnce({
        status: 'error',
        error: {
          code: -32002,
          message: 'No approved account is available',
          data: { dreyCode: 'ERR_NO_ACCOUNT' },
        },
      })
      .mockResolvedValueOnce({ status: 'success', result: { id: 'account' } })
      .mockResolvedValueOnce({ status: 'success', result: { txid: TXID } });

    await sendDonation('drey', 100_000, { providerWindow: DREY_WINDOW, request });
    expect(request.mock.calls.map(call => call[0])).toEqual([
      'wallet_getCurrentPermissions',
      'sendTransfer',
      'wallet_connect',
      'sendTransfer',
    ]);
    expect(request.mock.calls[2]).toEqual(['wallet_connect', DREY_CONNECT_PARAMS, 'drey']);
  });

  it('classifies unavailable, cancelled, rejected, and insufficient-funds failures', async () => {
    await expect(
      sendDonation('drey', 10_000, { providerWindow: {}, request: vi.fn() })
    ).rejects.toMatchObject({ kind: 'unavailable' });

    for (const [message, kind] of [
      ['Request cancelled', 'cancelled'],
      ['User rejected request', 'rejected'],
      ['Insufficient funds', 'insufficient-funds'],
    ] as const) {
      const request = vi
        .fn<DonationRequest>()
        .mockResolvedValueOnce({ status: 'success', result: DREY_BALANCE_PERMISSIONS })
        .mockResolvedValueOnce({ status: 'error', error: { message } });
      const error = await sendDonation('drey', 10_000, {
        providerWindow: DREY_WINDOW,
        request,
      }).catch(caught => caught);
      expect(error).toBeInstanceOf(DonationWalletError);
      expect(error).toMatchObject({ kind });
    }
  });

  it('rejects malformed success responses instead of claiming a broadcast', async () => {
    const request = vi
      .fn<DonationRequest>()
      .mockResolvedValueOnce({ status: 'success', result: DREY_BALANCE_PERMISSIONS })
      .mockResolvedValueOnce({ status: 'success', result: {} });
    await expect(
      sendDonation('drey', 10_000, { providerWindow: DREY_WINDOW, request })
    ).rejects.toMatchObject({ kind: 'unexpected' });
  });
});
