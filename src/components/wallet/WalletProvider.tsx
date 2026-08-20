'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { ConnectedWallet } from '@/lib/wallet/satsConnect';
import type { MarketplaceContext } from '@/lib/marketplace/types';
import type { CommunityVaultAcquisitionProviderContextV1 } from '@drey/core/domain/community-vault/acquisition-provider';
import type {
  CommunitySaleBuyerProviderContextV1,
  CommunitySaleProviderContextV1,
} from '@/lib/community-purchases/contracts';
import type {
  CommunityVaultPositionTransferBuyerProviderContextV1,
  CommunityVaultPositionTransferOwnerProviderContextV1,
} from '@drey/core/domain/community-vault/position-transfer-provider';

type BuyerSessionState = ConnectedWallet & {
  acceptedTermsAt: number | null;
};

type WalletContextValue = {
  wallet: BuyerSessionState | null;
  connecting: boolean;
  error: string | null;
  connect: (providerId?: string) => Promise<BuyerSessionState>;
  disconnect: () => Promise<void>;
  acceptTerms: () => Promise<void>;
  signMessage: (address: string, message: string) => Promise<string>;
  getSpendableBalance: () => Promise<{ confirmed: string; unconfirmed: string; total: string }>;
  signPsbt: (
    psbt: string,
    signInputs?: Record<string, number[]>,
    marketplaceContext?: MarketplaceContext,
    communityVaultAcquisitionContext?: CommunityVaultAcquisitionProviderContextV1,
    communityVaultSaleContext?: CommunitySaleProviderContextV1 & { ownerId: string },
    communityVaultSaleBuyerContext?: CommunitySaleBuyerProviderContextV1,
    communityVaultPositionTransferContext?:
      | { role: 'buyer'; context: CommunityVaultPositionTransferBuyerProviderContextV1 }
      | { role: 'owner'; context: CommunityVaultPositionTransferOwnerProviderContextV1 }
  ) => Promise<string>;
};

const WalletContext = createContext<WalletContextValue | null>(null);
const STORAGE_KEY = 'omb_market_wallet';
const MOCK_WALLET_CLIENT =
  process.env.NODE_ENV !== 'production' &&
  process.env.NEXT_PUBLIC_MARKETPLACE_MOCK_WALLET === 'true';

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState<BuyerSessionState | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void initializeWallet().then(next => {
      if (!cancelled && next) setWallet(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback((next: BuyerSessionState | null) => {
    setWallet(next);
    if (!next) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    writeCachedWallet(next);
  }, []);

  const connect = useCallback(
    async (providerId?: string) => {
      setConnecting(true);
      setError(null);
      try {
        const walletModule = await import('@/lib/wallet/satsConnect');
        const connected = MOCK_WALLET_CLIENT
          ? walletModule.mockConnectedWallet()
          : await walletModule.connectSatsWallet(providerId);
        const session = MOCK_WALLET_CLIENT
          ? await createMockSession(connected)
          : await createSignedSession(connected, walletModule.signBuyerMessage);
        persist(session);
        return session;
      } catch (err) {
        const message = walletErrorMessage(err);
        setError(message);
        throw new Error(message);
      } finally {
        setConnecting(false);
      }
    },
    [persist]
  );

  const disconnect = useCallback(async () => {
    await fetch('/api/marketplace/session', { method: 'DELETE' }).catch(() => null);
    if (!MOCK_WALLET_CLIENT) {
      const walletModule = await import('@/lib/wallet/satsConnect');
      await walletModule.disconnectSatsWallet(wallet?.providerId).catch(() => null);
    }
    persist(null);
  }, [persist, wallet?.providerId]);

  const acceptTerms = useCallback(async () => {
    const res = await fetch('/api/marketplace/session', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accept_terms: true }),
    });
    const json = (await res.json().catch(() => null)) as SessionResponse | null;
    if (!res.ok || !json?.session) {
      throw new Error(json && 'error' in json ? String(json.error) : 'Could not accept terms');
    }
    const next = sessionResponseToState(json.session, wallet);
    persist(next);
  }, [persist, wallet]);

  const signPsbt = useCallback(
    async (
      psbt: string,
      signInputs?: Record<string, number[]>,
      marketplaceContext?: MarketplaceContext,
      communityVaultAcquisitionContext?: CommunityVaultAcquisitionProviderContextV1,
      communityVaultSaleContext?: CommunitySaleProviderContextV1 & { ownerId: string },
      communityVaultSaleBuyerContext?: CommunitySaleBuyerProviderContextV1,
      communityVaultPositionTransferContext?:
        | { role: 'buyer'; context: CommunityVaultPositionTransferBuyerProviderContextV1 }
        | { role: 'owner'; context: CommunityVaultPositionTransferOwnerProviderContextV1 }
    ) => {
      if (!wallet) throw new Error('Reconnect your wallet before signing.');
      const { signPurchasePsbt } = await import('@/lib/wallet/satsConnect');
      const signed = await signPurchasePsbt({
        wallet,
        psbt,
        signInputs,
        marketplaceContext,
        communityVaultAcquisitionContext,
        communityVaultSaleContext,
        communityVaultSaleBuyerContext,
        communityVaultPositionTransferContext,
      });
      return signed.signedPsbt;
    },
    [wallet]
  );

  const signMessage = useCallback(
    async (address: string, message: string) => {
      if (MOCK_WALLET_CLIENT) return 'mock-signature';
      if (!wallet) throw new Error('Reconnect your wallet before signing.');
      const { signBuyerMessage } = await import('@/lib/wallet/satsConnect');
      return signBuyerMessage(wallet, address, message);
    },
    [wallet]
  );

  const getSpendableBalance = useCallback(async () => {
    if (MOCK_WALLET_CLIENT) {
      return { confirmed: '2100000000000000', unconfirmed: '0', total: '2100000000000000' };
    }
    if (!wallet) throw new Error('Reconnect your wallet before checking funds.');
    const { getDreySpendableBalance } = await import('@/lib/wallet/satsConnect');
    return getDreySpendableBalance(wallet);
  }, [wallet]);

  const value = useMemo(
    () => ({
      wallet,
      connecting,
      error,
      connect,
      disconnect,
      acceptTerms,
      signMessage,
      getSpendableBalance,
      signPsbt,
    }),
    [
      wallet,
      connecting,
      error,
      connect,
      disconnect,
      acceptTerms,
      signMessage,
      getSpendableBalance,
      signPsbt,
    ]
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used inside WalletProvider');
  return ctx;
}

async function refreshSession(cached: BuyerSessionState | null): Promise<BuyerSessionState | null> {
  const res = await fetch('/api/marketplace/session').catch(() => null);
  if (!res?.ok) return null;
  const json = (await res.json().catch(() => null)) as SessionResponse | null;
  if (!json?.session) return null;
  const next = sessionResponseToState(json.session, cached);
  try {
    writeCachedWallet(next);
  } catch {
    // ignore
  }
  return next;
}

async function initializeWallet(): Promise<BuyerSessionState | null> {
  let cached = readCachedWallet();
  if (cached?.providerId === 'drey') {
    const walletModule = await import('@/lib/wallet/satsConnect');
    const current = await walletModule.refreshDreyConnection(cached);
    if (!current) {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    cached = { ...cached, ...current };
  }
  const refreshed = await refreshSession(cached);
  return refreshed ?? cached;
}

function readCachedWallet(): BuyerSessionState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as
      | BuyerSessionState
      | { version: 2 | 3; wallet: BuyerSessionState };
    const stored = 'version' in parsed ? parsed.wallet : parsed;
    if (!('ordAddr' in stored)) return null;
    return {
      ...stored,
      providerId: stored.providerId ?? 'unknown',
      providerVersion: stored.providerVersion ?? null,
      providerPlatform: stored.providerPlatform ?? null,
      providerCapabilities: Array.isArray(stored.providerCapabilities)
        ? stored.providerCapabilities.filter((item): item is string => typeof item === 'string')
        : [],
    };
  } catch {
    window.localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

async function createMockSession(connected: ConnectedWallet): Promise<BuyerSessionState> {
  const res = await fetch('/api/marketplace/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mock: true,
      ord_addr: connected.ordAddr,
      pay_addr: connected.payAddr,
      ord_pubkey: connected.ordPubkey,
      pay_pubkey: connected.payPubkey,
    }),
  });
  const json = (await res.json().catch(() => null)) as SessionResponse | null;
  if (!res.ok || !json?.session) {
    throw new Error(json && 'error' in json ? String(json.error) : 'Mock wallet session failed');
  }
  return sessionResponseToState(json.session, connected);
}

async function createSignedSession(
  connected: ConnectedWallet,
  signBuyerMessage: (wallet: ConnectedWallet, address: string, message: string) => Promise<string>
): Promise<BuyerSessionState> {
  const nonceRes = await fetch(
    `/api/marketplace/session?ord_addr=${encodeURIComponent(connected.ordAddr)}&pay_addr=${encodeURIComponent(connected.payAddr ?? '')}`
  );
  const nonceJson = (await nonceRes.json().catch(() => null)) as {
    message?: string;
    error?: string;
  } | null;
  if (!nonceRes.ok || !nonceJson?.message) {
    throw new Error(nonceJson?.error ?? 'Could not create sign-in challenge');
  }
  const signature = await signBuyerMessage(connected, connected.ordAddr, nonceJson.message);
  const res = await fetch('/api/marketplace/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ord_addr: connected.ordAddr,
      pay_addr: connected.payAddr,
      ord_pubkey: connected.ordPubkey,
      pay_pubkey: connected.payPubkey,
      message: nonceJson.message,
      signature,
    }),
  });
  const json = (await res.json().catch(() => null)) as SessionResponse | null;
  if (!res.ok || !json?.session) {
    throw new Error(json && 'error' in json ? String(json.error) : 'Wallet sign-in failed');
  }
  return sessionResponseToState(json.session, connected);
}

type SessionResponse = {
  session?: {
    ord_addr: string;
    pay_addr: string | null;
    ord_pubkey: string | null;
    pay_pubkey: string | null;
    accepted_terms_at: number | null;
  } | null;
  error?: string;
};

function sessionResponseToState(
  session: NonNullable<SessionResponse['session']>,
  provider: ConnectedWallet | null
): BuyerSessionState {
  return {
    ordAddr: session.ord_addr,
    payAddr: session.pay_addr,
    ordPubkey: session.ord_pubkey,
    payPubkey: session.pay_pubkey,
    providerId: provider?.providerId ?? 'unknown',
    providerVersion: provider?.providerVersion ?? null,
    providerPlatform: provider?.providerPlatform ?? null,
    providerCapabilities: provider?.providerCapabilities ?? [],
    acceptedTermsAt: session.accepted_terms_at,
  };
}

function writeCachedWallet(wallet: BuyerSessionState): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 3, wallet }));
}

function walletErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const message = raw.trim() || 'Wallet connection failed';
  if (
    /wallet selection was cancelled|failed to select the provider|user may have cancelled/i.test(
      message
    )
  ) {
    return 'Wallet selection was cancelled. Choose Xverse or another Bitcoin wallet to continue.';
  }
  if (
    /no bitcoin wallet|no wallet provider|no wallets detected|no wallet was found/i.test(message)
  ) {
    return 'No Bitcoin wallet was found. Install or enable Xverse, then try again.';
  }
  if (/access denied|user rejected|user denied|rejected/i.test(message)) {
    return 'Wallet access was blocked by the selected wallet. Unlock it or choose Xverse, then try again.';
  }
  return message;
}
