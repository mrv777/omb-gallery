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
import type { MarketplaceContext } from '@/lib/marketplace/types';

export const DREY_PROVIDER_ID = 'drey';
export const DREY_MIN_BUY_VERSION = '0.11.0';
export const DREY_INITIALIZED_EVENT = 'drey#initialized';
export const DREY_CHROME_STORE_URL =
  'https://chromewebstore.google.com/detail/drey/kngidlmmbfmnoeimngkajdlbdenlhgof';
export const DREY_PROVIDER_ICON =
  'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22128%22 height=%22128%22 viewBox=%220 0 128 128%22%3E%3Crect width=%22128%22 height=%22128%22 rx=%2228%22 fill=%22%23050505%22/%3E%3Ccircle cx=%2264%22 cy=%2264%22 r=%2245%22 fill=%22none%22 stroke=%22%23fff%22 stroke-width=%228%22/%3E%3Cpath d=%22M18 55c4-19 20-33 39-35 22-2 42 12 49 32 5 15 2 32-7 44V62c0-7-6-13-13-13H57c-9 0-16 7-16 16v19c-7-8-9-20-5-30 3-7 9-12 4-15-5-4-14 0-22 16Z%22 fill=%22%23fff%22/%3E%3Crect x=%2254%22 y=%2260%22 width=%2218%22 height=%2218%22 rx=%224%22 fill=%22%23fff%22/%3E%3Crect x=%2277%22 y=%2260%22 width=%2218%22 height=%2218%22 rx=%224%22 fill=%22%23fff%22/%3E%3Crect x=%2254%22 y=%2283%22 width=%2218%22 height=%2218%22 rx=%224%22 fill=%22%23fff%22/%3E%3Crect x=%2277%22 y=%2283%22 width=%2218%22 height=%2218%22 rx=%224%22 fill=%22%23fff%22/%3E%3C/svg%3E';

export type ConnectedWallet = {
  ordAddr: string;
  payAddr: string | null;
  ordPubkey: string | null;
  payPubkey: string | null;
  providerId: string;
  providerVersion: string | null;
  providerPlatform: string | null;
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
  purpose: AddressPurpose | 'ordinals' | 'payment';
};

type WalletRpcError = { code?: number; message?: string; data?: unknown };
type DreyProvider = {
  request(method: string, params?: unknown): Promise<{ result?: unknown; error?: WalletRpcError }>;
};
type DreyInfo = { version: string; platform: 'web' | 'mobile' };
type DiscoveredProvider = Partial<SupportedWallet> & {
  id?: unknown;
  name?: unknown;
  icon?: unknown;
};
type WalletWindow = Window & {
  drey?: DreyProvider;
  btc_providers?: unknown;
  wbip_providers?: unknown;
};

const CONNECT_MESSAGE = 'Connect to OMB Wiki marketplace.';
const ADDRESS_PURPOSES = [AddressPurpose.Ordinals, AddressPurpose.Payment];
const PROVIDER_ORDER = [
  DREY_PROVIDER_ID,
  'XverseProviders.BitcoinProvider',
  'unisat',
  'FordefiProviders.UtxoProvider',
];

export function getSatsWalletOptions(): SatsWalletOption[] {
  const discovered = typeof window === 'undefined' ? [] : discoveredWallets(window as WalletWindow);
  const merged = new Map<string, SatsWalletOption>();
  for (const provider of [...getSupportedWallets(), ...discovered]) {
    if (typeof provider.id !== 'string' || merged.has(provider.id)) continue;
    if (provider.id === DREY_PROVIDER_ID && !dreyMarketplaceEnabled()) continue;
    merged.set(provider.id, {
      id: provider.id,
      name: typeof provider.name === 'string' ? provider.name : provider.id,
      icon: typeof provider.icon === 'string' ? provider.icon : '',
      isInstalled:
        provider.id === DREY_PROVIDER_ID ? hasDreyProvider() : Boolean(provider.isInstalled),
      installUrl: providerInstallUrl(provider as SupportedWallet),
    });
  }
  if (dreyMarketplaceEnabled() && !merged.has(DREY_PROVIDER_ID)) {
    merged.set(DREY_PROVIDER_ID, {
      id: DREY_PROVIDER_ID,
      name: 'Drey',
      icon: DREY_PROVIDER_ICON,
      isInstalled: hasDreyProvider(),
      installUrl: DREY_CHROME_STORE_URL,
    });
  }
  return Array.from(merged.values()).toSorted((a, b) => {
    const ai = PROVIDER_ORDER.indexOf(a.id);
    const bi = PROVIDER_ORDER.indexOf(b.id);
    const ar = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
    const br = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
    return ar - br || Number(b.isInstalled) - Number(a.isInstalled) || a.name.localeCompare(b.name);
  });
}

export function dreyMarketplaceEnabled(): boolean {
  return process.env.NEXT_PUBLIC_DREY_MARKETPLACE_ENABLED?.trim() === 'true';
}

export function listenForDreyInitialization(listener: () => void): () => void {
  window.addEventListener(DREY_INITIALIZED_EVENT, listener);
  return () => window.removeEventListener(DREY_INITIALIZED_EVENT, listener);
}

export async function connectSatsWallet(providerId?: string): Promise<ConnectedWallet> {
  const selectedProviderId = providerId ?? preferredInstalledProviderId();
  if (!selectedProviderId) throw new Error('No compatible Bitcoin wallet was found.');
  if (selectedProviderId === DREY_PROVIDER_ID) return connectDreyWallet();
  const response = await requestWallet(
    'getAccounts',
    { purposes: ADDRESS_PURPOSES, message: CONNECT_MESSAGE },
    selectedProviderId
  );
  if (response.status === 'error') throw walletResponseError(response.error);
  setDefaultProvider(selectedProviderId);
  return walletFromAddresses(response.result as SatsAddress[], selectedProviderId, null, null);
}

async function connectDreyWallet(): Promise<ConnectedWallet> {
  const info = await dreyRequest<DreyInfo>('getInfo');
  const account = await dreyRequest<{ addresses: SatsAddress[] }>('wallet_connect', {
    network: 'Mainnet',
    addresses: ['ordinals', 'payment'],
    message: CONNECT_MESSAGE,
  });
  setDefaultProvider(DREY_PROVIDER_ID);
  return walletFromAddresses(account.addresses, DREY_PROVIDER_ID, info.version, info.platform);
}

function walletFromAddresses(
  addresses: SatsAddress[],
  providerId: string,
  providerVersion: string | null,
  providerPlatform: string | null
): ConnectedWallet {
  const ord = addresses.find(addr => String(addr.purpose) === 'ordinals');
  const pay = addresses.find(addr => String(addr.purpose) === 'payment');
  if (!ord?.address) throw new Error('Wallet did not return an ordinals address');
  return {
    ordAddr: ord.address,
    payAddr: pay?.address ?? null,
    ordPubkey: ord.publicKey ?? null,
    payPubkey: pay?.publicKey ?? null,
    providerId,
    providerVersion,
    providerPlatform,
  };
}

export async function signBuyerMessage(
  wallet: ConnectedWallet,
  address: string,
  message: string
): Promise<string> {
  await assertWalletAddresses(wallet);
  if (wallet.providerId === DREY_PROVIDER_ID) {
    const result = await dreyRequest<{ signature: string }>('signMessage', {
      address,
      message,
      protocol: 'BIP322',
    });
    return result.signature;
  }
  const response = await requestWallet(
    'signMessage',
    { address, message, protocol: MessageSigningProtocols.BIP322 },
    wallet.providerId
  );
  if (response.status === 'error') throw walletResponseError(response.error);
  return response.result.signature;
}

export async function signPurchasePsbt(args: {
  wallet: ConnectedWallet;
  psbt: string;
  signInputs?: Record<string, number[]>;
  marketplaceContext?: MarketplaceContext;
}): Promise<{ signedPsbt: string; txid?: string }> {
  if (process.env.NEXT_PUBLIC_MARKETPLACE_MOCK === 'true')
    return { signedPsbt: `mock-signed:${args.psbt}` };
  await assertWalletAddresses(args.wallet);
  if (args.wallet.providerId === DREY_PROVIDER_ID) {
    const result = await dreyRequest<{ psbt: string; txid?: string }>('signPsbt', {
      psbt: args.psbt,
      signInputs: args.signInputs,
      broadcast: false,
      ...(args.marketplaceContext ? { marketplaceContext: args.marketplaceContext } : {}),
    });
    return { signedPsbt: result.psbt, txid: result.txid };
  }
  const response = await requestWallet(
    'signPsbt',
    { psbt: args.psbt, signInputs: args.signInputs, broadcast: false },
    args.wallet.providerId
  );
  if (response.status === 'error') throw walletResponseError(response.error);
  return { signedPsbt: response.result.psbt, txid: response.result.txid };
}

export async function disconnectSatsWallet(providerId?: string): Promise<void> {
  const selected = providerId ?? getDefaultProvider();
  if (selected === DREY_PROVIDER_ID && hasDreyProvider())
    await dreyRequest('wallet_disconnect').catch(() => null);
  else if (selected)
    await requestWallet('wallet_renouncePermissions', undefined, selected).catch(() => null);
  removeDefaultProvider();
}

export async function probeDreyConnection(expected: ConnectedWallet): Promise<boolean> {
  if (expected.providerId !== DREY_PROVIDER_ID || !hasDreyProvider()) return false;
  try {
    const permissions = await dreyRequest<unknown[]>('wallet_getCurrentPermissions');
    if (permissions.length === 0) return false;
    await assertWalletAddresses(expected);
    return true;
  } catch {
    return false;
  }
}

export function isDreyBuySupported(wallet: ConnectedWallet): boolean {
  return (
    wallet.providerId !== DREY_PROVIDER_ID ||
    compareSemver(wallet.providerVersion, DREY_MIN_BUY_VERSION) >= 0
  );
}

export function dreyMobileBrowserUrl(currentUrl: string): string {
  const url = new URL('https://squirrelsystems.net/browser');
  url.searchParams.set('url', currentUrl);
  return url.toString();
}

export function isMobileBrowser(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);
}

export function mockConnectedWallet(): ConnectedWallet {
  return {
    ordAddr: 'bc1pombmockordinalsbuyer0000000000000000000000000000000qqq',
    payAddr: 'bc1qombmockpaymentbuyer00000000000000000000000000x0k',
    ordPubkey: null,
    payPubkey: null,
    providerId: 'mock',
    providerVersion: null,
    providerPlatform: null,
  };
}

async function assertWalletAddresses(expected: ConnectedWallet): Promise<void> {
  if (expected.providerId !== DREY_PROVIDER_ID) return;
  const addresses = await dreyRequest<SatsAddress[]>('getAccounts', {
    purposes: ['ordinals', 'payment'],
    message: CONNECT_MESSAGE,
  });
  const current = walletFromAddresses(
    addresses,
    DREY_PROVIDER_ID,
    expected.providerVersion,
    expected.providerPlatform
  );
  if (current.ordAddr !== expected.ordAddr || current.payAddr !== expected.payAddr) {
    throw new Error('Drey account changed. Reconnect Drey before signing.');
  }
}

async function dreyRequest<T>(method: string, params?: unknown): Promise<T> {
  const provider = (window as WalletWindow).drey;
  if (!provider?.request) throw new Error('Drey is not available in this browser document.');
  const response = await provider.request(method, params);
  if (response.error) throw walletResponseError(response.error);
  if (!('result' in response)) throw new Error('Drey returned an invalid response.');
  return response.result as T;
}

function discoveredWallets(target: WalletWindow): DiscoveredProvider[] {
  const merged = new Map<string, DiscoveredProvider>();
  for (const registry of [target.btc_providers, target.wbip_providers]) {
    if (!Array.isArray(registry)) continue;
    for (const candidate of registry) {
      if (!candidate || typeof candidate !== 'object') continue;
      const provider = candidate as DiscoveredProvider;
      if (typeof provider.id === 'string' && !merged.has(provider.id))
        merged.set(provider.id, provider);
    }
  }
  return Array.from(merged.values());
}

function hasDreyProvider(): boolean {
  return (
    typeof window !== 'undefined' && typeof (window as WalletWindow).drey?.request === 'function'
  );
}

function walletResponseError(error: WalletRpcError): Error {
  return new Error(error.message || 'Wallet request failed');
}

function preferredInstalledProviderId(): string | null {
  const remembered = getDefaultProvider();
  const options = getSatsWalletOptions();
  if (remembered && options.some(option => option.id === remembered && option.isInstalled))
    return remembered;
  return options.find(option => option.isInstalled)?.id ?? null;
}

function providerInstallUrl(provider: SupportedWallet): string | null {
  if (provider.id === DREY_PROVIDER_ID) return provider.chromeWebStoreUrl ?? DREY_CHROME_STORE_URL;
  return (
    provider.chromeWebStoreUrl ??
    provider.mozillaAddOnsUrl ??
    provider.iOSAppStoreUrl ??
    provider.googlePlayStoreUrl ??
    provider.webUrl ??
    null
  );
}

function compareSemver(actual: string | null, required: string): number {
  if (!actual || !/^\d+\.\d+\.\d+$/.test(actual)) return -1;
  const left = actual.split('.').map(Number);
  const right = required.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return (left[index] ?? 0) - (right[index] ?? 0);
  }
  return 0;
}
