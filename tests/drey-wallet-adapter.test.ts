import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

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
  DREY_COMMUNITY_CAPABILITY,
  DREY_COMMUNITY_OFFERS_CAPABILITY,
  DREY_PROVIDER_ICON,
  LEATHER_PROVIDER_ICON,
  LEATHER_PROVIDER_ID,
  connectSatsWallet,
  getDreySpendableBalance,
  getSatsWalletOptions,
  isDreyBuySupported,
  isDreyCommunitySupported,
  isDreyCommunityOffersSupported,
  listenForDreyInitialization,
  openDreyCommunitySetup,
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
    providerCapabilities: [],
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

  it('ships the exact production extension icon', () => {
    const icon = readFileSync(new URL('../public/wallets/drey.png', import.meta.url));
    expect(createHash('sha256').update(icon).digest('hex')).toBe(
      '08030f86820a2fef49896ca5894a9b91f181709862eefabcd7fed5b713469c34'
    );
  });

  it('ships the official Leather wallet icon', () => {
    const icon = readFileSync(new URL('../public/wallets/leather.png', import.meta.url));
    expect(createHash('sha256').update(icon).digest('hex')).toBe(
      'c81d2c3da71d06aeb48111ff24ab04aee0c7d57e282825e882dbcf187ea37a66'
    );
  });

  it('merges both discovery registries, suppresses duplicates, and keeps Drey first', () => {
    installDrey(() => null);
    const options = getSatsWalletOptions();
    expect(options.map(option => option.id)).toEqual([
      'drey',
      'XverseProviders.BitcoinProvider',
      LEATHER_PROVIDER_ID,
    ]);
    expect(options.filter(option => option.id === 'drey')).toHaveLength(1);
    expect(options[0]).toMatchObject({
      name: 'Drey',
      icon: DREY_PROVIDER_ICON,
      isInstalled: true,
    });
  });

  it('treats registry-discovered Leather as installed and supplies its local icon', () => {
    vi.stubGlobal('window', {
      btc_providers: [{ id: LEATHER_PROVIDER_ID, name: 'Leather' }],
    });

    const options = getSatsWalletOptions();
    expect(options.find(option => option.id === LEATHER_PROVIDER_ID)).toMatchObject({
      name: 'Leather',
      icon: LEATHER_PROVIDER_ICON,
      isInstalled: true,
    });
  });

  it('hides unavailable institutional wallets but preserves them when installed', () => {
    sats.getSupportedWallets.mockReturnValue([
      {
        id: 'FordefiProviders.UtxoProvider',
        name: 'Fordefi',
        icon: 'fordefi-icon',
        isInstalled: false,
      },
    ]);

    expect(getSatsWalletOptions().map(option => option.id)).not.toContain(
      'FordefiProviders.UtxoProvider'
    );

    sats.getSupportedWallets.mockReturnValue([
      {
        id: 'FordefiProviders.UtxoProvider',
        name: 'Fordefi',
        icon: 'fordefi-icon',
        isInstalled: true,
      },
    ]);
    expect(getSatsWalletOptions()).toContainEqual(
      expect.objectContaining({ id: 'FordefiProviders.UtxoProvider', isInstalled: true })
    );
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
      if (method === 'getInfo')
        return {
          version: '0.11.2',
          platform: 'web',
          capabilities: [DREY_COMMUNITY_CAPABILITY],
        };
      if (method === 'wallet_connect') return { addresses };
      throw new Error(`unexpected method ${method}`);
    });
    await expect(connectSatsWallet('drey')).resolves.toEqual(
      dreyWallet({
        providerVersion: '0.11.2',
        providerCapabilities: [DREY_COMMUNITY_CAPABILITY],
      })
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

  it('passes the exact buyer-funded Community Vault offer context without broadcast', async () => {
    const communityVaultSaleBuyerContext = { version: 1, exact: 'offer' } as never;
    const request = installDrey(method => {
      if (method === 'getAccounts') return addresses;
      if (method === 'signPsbt') return { psbt: 'buyer-funded' };
      throw new Error(`unexpected method ${method}`);
    });
    await expect(
      signPurchasePsbt({
        wallet: dreyWallet(),
        psbt: 'unsigned-offer',
        signInputs: { bc1qpayment: [1, 2] },
        communityVaultSaleBuyerContext,
      })
    ).resolves.toEqual({ signedPsbt: 'buyer-funded', txid: undefined });
    expect(request).toHaveBeenLastCalledWith('signPsbt', {
      psbt: 'unsigned-offer',
      signInputs: { bc1qpayment: [1, 2] },
      broadcast: false,
      communityVaultSaleBuyerContext,
    });
  });

  it('opens a prefilled Drey setup only when the explicit capability is present', async () => {
    const request = installDrey(method => {
      if (method === 'getAccounts') return addresses;
      if (method === 'drey_openCommunityVault') return null;
      throw new Error(`unexpected method ${method}`);
    });
    const wallet = dreyWallet({ providerCapabilities: [DREY_COMMUNITY_CAPABILITY] });
    await expect(
      openDreyCommunitySetup(wallet, {
        campaignId: 'cp_123',
        ownerId: 'owner_456',
        label: 'OMB #123',
      })
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenLastCalledWith('drey_openCommunityVault', {
      campaignId: 'cp_123',
      ownerId: 'owner_456',
      label: 'OMB #123',
    });

    await expect(
      openDreyCommunitySetup(dreyWallet(), { campaignId: 'cp_123', ownerId: 'owner_456' })
    ).rejects.toThrow(/latest Drey build/u);
  });

  it('returns only Drey confirmed spendable balance after revalidating the account', async () => {
    const request = installDrey(method => {
      if (method === 'getAccounts') return addresses;
      if (method === 'getBalance')
        return { confirmed: '125000', unconfirmed: '5000', total: '130000' };
      throw new Error(`unexpected method ${method}`);
    });
    await expect(getDreySpendableBalance(dreyWallet())).resolves.toEqual({
      confirmed: '125000',
      unconfirmed: '5000',
      total: '130000',
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual(['getAccounts', 'getBalance']);
  });

  it('rejects inconsistent Drey balance results', async () => {
    installDrey(method => {
      if (method === 'getAccounts') return addresses;
      if (method === 'getBalance') return { confirmed: '125000', unconfirmed: '5000', total: '1' };
      throw new Error(`unexpected method ${method}`);
    });
    await expect(getDreySpendableBalance(dreyWallet())).rejects.toThrow(
      /invalid spendable balance/u
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
      if (method === 'getInfo')
        return {
          version: '0.11.2',
          platform: 'web',
          capabilities: [DREY_COMMUNITY_CAPABILITY],
        };
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

  it('gates Group Buys on an explicit Drey capability rather than product version', () => {
    expect(isDreyCommunitySupported(dreyWallet({ providerVersion: '99.0.0' }))).toBe(false);
    expect(
      isDreyCommunitySupported(
        dreyWallet({
          providerVersion: '0.11.2',
          providerCapabilities: [DREY_COMMUNITY_CAPABILITY],
        })
      )
    ).toBe(true);
    expect(
      isDreyCommunitySupported(
        dreyWallet({
          providerId: 'XverseProviders.BitcoinProvider',
          providerCapabilities: [DREY_COMMUNITY_CAPABILITY],
        })
      )
    ).toBe(false);
  });

  it('gates buyer offers on the separate offer capability', () => {
    expect(
      isDreyCommunityOffersSupported(
        dreyWallet({ providerCapabilities: [DREY_COMMUNITY_CAPABILITY] })
      )
    ).toBe(false);
    expect(
      isDreyCommunityOffersSupported(
        dreyWallet({
          providerCapabilities: [DREY_COMMUNITY_CAPABILITY, DREY_COMMUNITY_OFFERS_CAPABILITY],
        })
      )
    ).toBe(true);
  });
});
