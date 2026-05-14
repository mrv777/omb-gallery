'use client';

import {
  AddressPurpose,
  MessageSigningProtocols,
  getDefaultProvider,
  getSupportedWallets,
  removeDefaultProvider,
  request as requestWallet,
  setDefaultProvider,
  type SupportedWallet,
} from 'sats-connect';

export type ConnectedWallet = {
  ordAddr: string;
  payAddr: string | null;
  ordPubkey: string | null;
  payPubkey: string | null;
};

export type SatsWalletOption = {
  id: string;
  name: string;
  icon: string;
  isInstalled: boolean;
  installUrl: string | null;
};

type SatsAddress = {
  address: string;
  publicKey: string;
  purpose: AddressPurpose;
};

type WalletRpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

const CONNECT_MESSAGE = 'Connect to OMB Wiki marketplace.';
const ADDRESS_PURPOSES = [AddressPurpose.Ordinals, AddressPurpose.Payment];
const PROVIDER_ORDER = [
  'XverseProviders.BitcoinProvider',
  'unisat',
  'FordefiProviders.UtxoProvider',
];

export function getSatsWalletOptions(): SatsWalletOption[] {
  return getSupportedWallets()
    .map(provider => ({
      id: provider.id,
      name: provider.name,
      icon: provider.icon,
      isInstalled: provider.isInstalled,
      installUrl: providerInstallUrl(provider),
    }))
    .toSorted((a, b) => {
      const ai = PROVIDER_ORDER.indexOf(a.id);
      const bi = PROVIDER_ORDER.indexOf(b.id);
      const ar = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
      const br = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
      return (
        ar - br || Number(b.isInstalled) - Number(a.isInstalled) || a.name.localeCompare(b.name)
      );
    });
}

export async function connectSatsWallet(providerId?: string): Promise<ConnectedWallet> {
  const selectedProviderId = providerId ?? preferredInstalledProviderId();
  if (!selectedProviderId) {
    throw new Error('No Bitcoin wallet was found. Install or enable Xverse, then try again.');
  }
  const response = await requestWallet(
    'getAccounts',
    {
      purposes: ADDRESS_PURPOSES,
      message: CONNECT_MESSAGE,
    },
    selectedProviderId
  );
  if (response.status === 'error') throw walletResponseError(response.error);
  setDefaultProvider(selectedProviderId);
  return walletFromAddresses(response.result as SatsAddress[]);
}

function walletFromAddresses(addresses: SatsAddress[]): ConnectedWallet {
  const ord = addresses.find(addr => addr.purpose === AddressPurpose.Ordinals);
  const pay = addresses.find(addr => addr.purpose === AddressPurpose.Payment);
  if (!ord?.address) throw new Error('Wallet did not return an ordinals address');
  return {
    ordAddr: ord.address,
    payAddr: pay?.address ?? null,
    ordPubkey: ord.publicKey ?? null,
    payPubkey: pay?.publicKey ?? null,
  };
}

export async function signBuyerMessage(address: string, message: string): Promise<string> {
  const response = await requestWallet(
    'signMessage',
    {
      address,
      message,
      protocol: MessageSigningProtocols.BIP322,
    },
    connectedProviderId()
  );
  if (response.status === 'error') throw walletResponseError(response.error);
  return response.result.signature;
}

export async function signPurchasePsbt(args: {
  psbt: string;
  signInputs?: Record<string, number[]>;
}): Promise<{ signedPsbt: string; txid?: string }> {
  if (process.env.NEXT_PUBLIC_MARKETPLACE_MOCK === 'true') {
    return { signedPsbt: `mock-signed:${args.psbt}` };
  }
  const response = await requestWallet(
    'signPsbt',
    {
      psbt: args.psbt,
      signInputs: args.signInputs,
      broadcast: false,
    },
    connectedProviderId()
  );
  if (response.status === 'error') throw walletResponseError(response.error);
  return { signedPsbt: response.result.psbt, txid: response.result.txid };
}

export async function disconnectSatsWallet(): Promise<void> {
  const providerId = getDefaultProvider();
  if (providerId) {
    await requestWallet('wallet_renouncePermissions', undefined, providerId).catch(() => null);
  }
  removeDefaultProvider();
}

export function mockConnectedWallet(): ConnectedWallet {
  return {
    ordAddr: 'bc1pombmockordinalsbuyer0000000000000000000000000000000qqq',
    payAddr: 'bc1qombmockpaymentbuyer00000000000000000000000000x0k',
    ordPubkey: null,
    payPubkey: null,
  };
}

function walletResponseError(error: WalletRpcError): Error {
  return new Error(error.message || 'Wallet request failed');
}

function preferredInstalledProviderId(): string | null {
  const remembered = getDefaultProvider();
  const options = getSatsWalletOptions();
  if (remembered && options.some(option => option.id === remembered && option.isInstalled)) {
    return remembered;
  }
  return options.find(option => option.isInstalled)?.id ?? null;
}

function connectedProviderId(): string {
  const providerId = preferredInstalledProviderId();
  if (!providerId) {
    throw new Error('No connected Bitcoin wallet provider was found.');
  }
  return providerId;
}

function providerInstallUrl(provider: SupportedWallet): string | null {
  return (
    provider.chromeWebStoreUrl ??
    provider.mozillaAddOnsUrl ??
    provider.iOSAppStoreUrl ??
    provider.googlePlayStoreUrl ??
    provider.webUrl ??
    null
  );
}
