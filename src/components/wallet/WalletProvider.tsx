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

type BuyerSessionState = ConnectedWallet & {
  acceptedTermsAt: number | null;
};

type WalletContextValue = {
  wallet: BuyerSessionState | null;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<BuyerSessionState>;
  disconnect: () => Promise<void>;
  acceptTerms: () => Promise<void>;
  signMessage: (address: string, message: string) => Promise<string>;
  signPsbt: (psbt: string, signInputs?: Record<string, number[]>) => Promise<string>;
};

const WalletContext = createContext<WalletContextValue | null>(null);
const STORAGE_KEY = 'omb_market_wallet';
const MOCK_CLIENT = process.env.NEXT_PUBLIC_MARKETPLACE_MOCK === 'true';

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState<BuyerSessionState | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) setWallet(JSON.parse(raw) as BuyerSessionState);
    } catch {
      window.localStorage.removeItem(STORAGE_KEY);
    }
    void refreshSession().then(next => {
      if (next) setWallet(next);
    });
  }, []);

  const persist = useCallback((next: BuyerSessionState | null) => {
    setWallet(next);
    if (!next) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const walletModule = await import('@/lib/wallet/satsConnect');
      const connected = MOCK_CLIENT
        ? walletModule.mockConnectedWallet()
        : await walletModule.connectSatsWallet();
      const session = MOCK_CLIENT
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
  }, [persist]);

  const disconnect = useCallback(async () => {
    await fetch('/api/marketplace/session', { method: 'DELETE' }).catch(() => null);
    persist(null);
  }, [persist]);

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
    const next = sessionResponseToState(json.session);
    persist(next);
  }, [persist]);

  const signPsbt = useCallback(async (psbt: string, signInputs?: Record<string, number[]>) => {
    const { signPurchasePsbt } = await import('@/lib/wallet/satsConnect');
    const signed = await signPurchasePsbt({ psbt, signInputs });
    return signed.signedPsbt;
  }, []);

  const signMessage = useCallback(async (address: string, message: string) => {
    if (MOCK_CLIENT) return 'mock-signature';
    const { signBuyerMessage } = await import('@/lib/wallet/satsConnect');
    return signBuyerMessage(address, message);
  }, []);

  const value = useMemo(
    () => ({ wallet, connecting, error, connect, disconnect, acceptTerms, signMessage, signPsbt }),
    [wallet, connecting, error, connect, disconnect, acceptTerms, signMessage, signPsbt]
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used inside WalletProvider');
  return ctx;
}

async function refreshSession(): Promise<BuyerSessionState | null> {
  const res = await fetch('/api/marketplace/session').catch(() => null);
  if (!res?.ok) return null;
  const json = (await res.json().catch(() => null)) as SessionResponse | null;
  if (!json?.session) return null;
  const next = sessionResponseToState(json.session);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
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
  return sessionResponseToState(json.session);
}

async function createSignedSession(
  connected: ConnectedWallet,
  signBuyerMessage: (address: string, message: string) => Promise<string>
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
  const signature = await signBuyerMessage(connected.ordAddr, nonceJson.message);
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
  return sessionResponseToState(json.session);
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
  session: NonNullable<SessionResponse['session']>
): BuyerSessionState {
  return {
    ordAddr: session.ord_addr,
    payAddr: session.pay_addr,
    ordPubkey: session.ord_pubkey,
    payPubkey: session.pay_pubkey,
    acceptedTermsAt: session.accepted_terms_at,
  };
}

function walletErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const message = raw.trim() || 'Wallet connection failed';
  if (/access denied|user rejected|user denied|rejected/i.test(message)) {
    return 'Wallet connection was denied. Approve access in your wallet and try again.';
  }
  return message;
}
