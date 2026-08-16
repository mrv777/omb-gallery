import { beforeEach, describe, expect, it, vi } from 'vitest';

const sats = vi.hoisted(() => ({
  getSupportedWallets: vi.fn(),
  request: vi.fn(),
  setDefaultProvider: vi.fn(),
  getDefaultProvider: vi.fn(),
  removeDefaultProvider: vi.fn(),
}));

vi.mock('sats-connect', () => ({
  AddressPurpose: { Ordinals: 'ordinals', Payment: 'payment' },
  MessageSigningProtocols: { BIP322: 'BIP322' },
  ...sats,
}));

import {
  DREY_MIN_BUY_VERSION,
  connectSatsWallet,
  getSatsWalletOptions,
  isDreyBuySupported,
  listenForDreyInitialization,
  probeDreyConnection,
  signPurchasePsbt,
  type ConnectedWallet,
} from '@/lib/wallet/satsConnect';

const addresses = [
  { address: 'bc1pordinal', publicKey: '02aa', purpose: 'ordinals' },
  { address: 'bc1qpayment', publicKey: '02bb', purpose: 'payment' },
];

function dreyWallet(overrides: Partial<ConnectedWallet> = {}): ConnectedWallet {
  return {
    ordAddr: addresses[0]!.address,
    payAddr: addresses[1]!.address,
    ordPubkey: addresses[0]!.publicKey,
    payPubkey: addresses[1]!.publicKey,
    providerId: 'drey',
    providerVersion: DREY_MIN_BUY_VERSION,
    providerPlatform: 'web',
    ...overrides,
  };
}

function installDrey(handler: (method: string, params?: unknown) => unknown) {
  const request = vi.fn(async (method: string, params?: unknown) => ({
    result: handler(method, params),
  }));
  vi.stubGlobal('window', {
    drey: { request },
    btc_providers: [{ id: 'drey', name: 'Drey', icon: 'drey-icon' }],
    wbip_providers: [{ id: 'drey', name: 'Drey duplicate', icon: 'other-icon' }],
  });
  return request;
}

describe('Drey wallet adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    sats.getSupportedWallets.mockReturnValue([
      {
        id: 'XverseProviders.BitcoinProvider',
        name: 'Xverse',
        icon: 'xverse-icon',
        isInstalled: true,
      },
    ]);
  });

  it('merges both discovery registries, suppresses duplicates, and keeps Drey first', () => {
    installDrey(() => null);
    const options = getSatsWalletOptions();
    expect(options.map(option => option.id)).toEqual(['drey', 'XverseProviders.BitcoinProvider']);
    expect(options.filter(option => option.id === 'drey')).toHaveLength(1);
    expect(options[0]).toMatchObject({ name: 'Drey', isInstalled: true });
  });

  it('refreshes discovery when late Drey injection announces initialization', () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const refresh = vi.fn();
    const unsubscribe = listenForDreyInitialization(refresh);
    target.dispatchEvent(new Event('drey#initialized'));
    expect(refresh).toHaveBeenCalledOnce();
    unsubscribe();
    target.dispatchEvent(new Event('drey#initialized'));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('connects directly with the exact mainnet address purposes and records provider metadata', async () => {
    const request = installDrey(method => {
      if (method === 'getInfo') return { version: '0.11.2', platform: 'web' };
      if (method === 'wallet_connect') return { addresses };
      throw new Error(`unexpected method ${method}`);
    });
    await expect(connectSatsWallet('drey')).resolves.toEqual(
      dreyWallet({ providerVersion: '0.11.2' })
    );
    expect(request).toHaveBeenNthCalledWith(2, 'wallet_connect', {
      network: 'Mainnet',
      addresses: ['ordinals', 'payment'],
      message: 'Connect to OMB Wiki marketplace.',
    });
    expect(sats.request).not.toHaveBeenCalled();
  });

  it('revalidates the active account and passes marketplace context only to Drey', async () => {
    const marketplaceContext = {
      version: 1 as const,
      marketplaceId: 'ordnet' as const,
      templateVersion: 'omb-wiki-ordnet-buy-v1',
      action: 'buy' as const,
      role: 'buyer' as const,
      assetKind: 'inscription' as const,
      workflowId: 'omb-wiki-buy-1',
      step: 1,
      stepCount: 1,
      identifiers: { listingId: 'listing', inscriptionId: `${'a'.repeat(64)}i0` },
      economics: {
        priceSats: '1000',
        totalSats: '1100',
        buyerDebitSats: '1100',
        assetDestination: addresses[0]!.address,
      },
      selectedInputIndexes: [1],
      expiresAt: Date.now() + 60_000,
      broadcaster: 'site' as const,
    };
    const request = installDrey(method => {
      if (method === 'getAccounts') return addresses;
      if (method === 'signPsbt') return { psbt: 'signed' };
      throw new Error(`unexpected method ${method}`);
    });
    await expect(
      signPurchasePsbt({
        wallet: dreyWallet(),
        psbt: 'unsigned',
        signInputs: { bc1qpayment: [1] },
        marketplaceContext,
      })
    ).resolves.toEqual({ signedPsbt: 'signed', txid: undefined });
    expect(request).toHaveBeenLastCalledWith('signPsbt', {
      psbt: 'unsigned',
      signInputs: { bc1qpayment: [1] },
      broadcast: false,
      marketplaceContext,
    });

    sats.request.mockResolvedValue({ status: 'success', result: { psbt: 'xverse-signed' } });
    await signPurchasePsbt({
      wallet: dreyWallet({ providerId: 'XverseProviders.BitcoinProvider' }),
      psbt: 'unsigned',
      signInputs: { bc1qpayment: [1] },
      marketplaceContext,
    });
    expect(sats.request).toHaveBeenCalledWith(
      'signPsbt',
      { psbt: 'unsigned', signInputs: { bc1qpayment: [1] }, broadcast: false },
      'XverseProviders.BitcoinProvider'
    );
  });

  it('fails closed when the Drey account changed before signing', async () => {
    const request = installDrey(method => {
      if (method === 'getAccounts')
        return [{ ...addresses[0], address: 'bc1pchanged' }, addresses[1]];
      throw new Error(`unexpected method ${method}`);
    });
    await expect(signPurchasePsbt({ wallet: dreyWallet(), psbt: 'unsigned' })).rejects.toThrow(
      /account changed/
    );
    expect(request).not.toHaveBeenCalledWith('signPsbt', expect.anything());
  });

  it('treats permissions as document-bound when probing a cached connection', async () => {
    installDrey(method => {
      if (method === 'wallet_getCurrentPermissions') return [];
      throw new Error(`unexpected method ${method}`);
    });
    await expect(probeDreyConnection(dreyWallet())).resolves.toBe(false);

    installDrey(method => {
      if (method === 'wallet_getCurrentPermissions') return [{ type: 'wallet' }];
      if (method === 'getAccounts') return addresses;
      throw new Error(`unexpected method ${method}`);
    });
    await expect(probeDreyConnection(dreyWallet())).resolves.toBe(true);
  });

  it('allows viewing on old versions but gates buying at 0.11.0', () => {
    expect(isDreyBuySupported(dreyWallet({ providerVersion: '0.10.10' }))).toBe(false);
    expect(isDreyBuySupported(dreyWallet({ providerVersion: '0.11.0' }))).toBe(true);
    expect(isDreyBuySupported(dreyWallet({ providerVersion: '0.11.1' }))).toBe(true);
    expect(isDreyBuySupported(dreyWallet({ providerId: 'XverseProviders.BitcoinProvider' }))).toBe(
      true
    );
  });
});
