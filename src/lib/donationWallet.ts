'use client';

import { AddressPurpose, BitcoinNetworkType, request as requestWallet } from 'sats-connect';
import {
  DONATION_CONFIG,
  donationWalletInstalled,
  type DonationWalletKey,
  type ProviderWindow,
} from './donation';

type DonationMethod = 'wallet_getCurrentPermissions' | 'wallet_connect' | 'sendTransfer';

type DonationRpcResponse =
  | { status: 'success'; result: unknown }
  | { status: 'error'; error: { code?: number; message?: string; data?: unknown } };

export type DonationRequest = (
  method: DonationMethod,
  params: unknown,
  providerId: string
) => Promise<DonationRpcResponse>;

export type DonationWalletErrorKind =
  | 'cancelled'
  | 'rejected'
  | 'insufficient-funds'
  | 'unavailable'
  | 'unexpected';

export class DonationWalletError extends Error {
  constructor(
    readonly kind: DonationWalletErrorKind,
    message: string
  ) {
    super(message);
    this.name = 'DonationWalletError';
  }
}

export async function sendDonation(
  wallet: DonationWalletKey,
  sats: number,
  options: {
    providerWindow?: ProviderWindow;
    request?: DonationRequest;
  } = {}
): Promise<{ txid: string }> {
  const providerWindow = options.providerWindow ?? (window as unknown as ProviderWindow);
  const provider = DONATION_CONFIG.wallets[wallet];
  if (!donationWalletInstalled(wallet, providerWindow)) {
    throw new DonationWalletError('unavailable', `${provider.name} is not installed.`);
  }

  const request = options.request ?? (requestWallet as unknown as DonationRequest);
  let connectionAttempted = false;

  const permissionResponse = await safePermissionRead(request, provider.id);
  if (permissionResponse === 'connect') {
    await connectWallet(request, provider.id);
    connectionAttempted = true;
  }

  let response = await request(
    'sendTransfer',
    {
      recipients: [{ address: DONATION_CONFIG.address, amount: sats }],
    },
    provider.id
  );

  // Some providers do not expose a useful permissions read while disconnected.
  // An authorization failure is safe to retry after one explicit connection:
  // no transfer was approved or broadcast by the failed call.
  if (response.status === 'error' && !connectionAttempted && isAuthorizationError(response.error)) {
    await connectWallet(request, provider.id);
    response = await request(
      'sendTransfer',
      {
        recipients: [{ address: DONATION_CONFIG.address, amount: sats }],
      },
      provider.id
    );
  }

  if (response.status === 'error') throw toDonationWalletError(response.error);
  const result = response.result as { txid?: unknown };
  if (typeof result?.txid !== 'string' || !/^[0-9a-f]{64}$/i.test(result.txid)) {
    throw new DonationWalletError('unexpected', 'The wallet did not return a transaction ID.');
  }
  return { txid: result.txid };
}

async function safePermissionRead(
  request: DonationRequest,
  providerId: string
): Promise<'connected' | 'connect' | 'unknown'> {
  try {
    const response = await request('wallet_getCurrentPermissions', undefined, providerId);
    if (response.status === 'success') {
      return Array.isArray(response.result) && response.result.length > 0 ? 'connected' : 'connect';
    }
    return isUnsupportedMethodError(response.error)
      ? 'unknown'
      : isAuthorizationError(response.error)
        ? 'connect'
        : 'unknown';
  } catch {
    // Older Xverse providers may not implement the permissions read. The
    // transfer request itself still owns review and authorization.
    return 'unknown';
  }
}

async function connectWallet(request: DonationRequest, providerId: string): Promise<void> {
  const response = await request(
    'wallet_connect',
    {
      addresses: [AddressPurpose.Payment],
      message: 'Support OMB Archive.',
      network: BitcoinNetworkType.Mainnet,
    },
    providerId
  );
  if (response.status === 'error') throw toDonationWalletError(response.error);
}

function isUnsupportedMethodError(error: { code?: number; message?: string }): boolean {
  return (
    error.code === -32601 ||
    /method (?:is )?not (?:found|supported)|unsupported method/i.test(error.message ?? '')
  );
}

function isAuthorizationError(error: { code?: number; message?: string; data?: unknown }): boolean {
  const raw = `${error.message ?? ''} ${JSON.stringify(error.data ?? '')}`;
  return /not connected|connect(?:ion)? required|unauthori[sz]ed|permission required|access denied/i.test(
    raw
  );
}

function toDonationWalletError(error: {
  code?: number;
  message?: string;
  data?: unknown;
}): DonationWalletError {
  const raw = `${error.message ?? ''} ${JSON.stringify(error.data ?? '')}`.trim();
  if (/cancel(?:led|ed)|window closed|request closed/i.test(raw)) {
    return new DonationWalletError('cancelled', 'Payment was cancelled in the wallet.');
  }
  if (/reject(?:ed|ion)|denied|declined/i.test(raw)) {
    return new DonationWalletError('rejected', 'The wallet rejected the payment request.');
  }
  if (/insufficient|not enough|balance too low/i.test(raw)) {
    return new DonationWalletError(
      'insufficient-funds',
      'The wallet does not have enough spendable bitcoin for this payment and its fee.'
    );
  }
  return new DonationWalletError(
    'unexpected',
    error.message?.trim() || 'The wallet could not complete the payment.'
  );
}
