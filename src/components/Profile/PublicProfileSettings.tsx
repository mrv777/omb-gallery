'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import ConnectWalletButton from '@/components/wallet/ConnectWalletButton';
import { useWallet } from '@/components/wallet/WalletProvider';
import { authorizeOrdnet } from '@/lib/marketplace/ordnetAuthorization';

type SharedProfile = {
  profile_id: string;
  username: string | null;
  avatar_url: string | null;
  verified_at: number;
};

type ProfilePreview = Omit<SharedProfile, 'verified_at'> & { is_public: boolean };

type ProfileResponse = {
  wallet_address: string;
  sharing: SharedProfile | null;
  matrica_linked: boolean;
  preview?: ProfilePreview;
  authorization_required?: boolean;
  error?: string;
  code?: string;
};

const BUTTON =
  'min-h-10 border border-bone-dim/60 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-bone transition-colors hover:border-bone disabled:cursor-wait disabled:opacity-50';

export default function PublicProfileSettings() {
  const { wallet } = useWallet();

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-8 sm:px-6">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-dim">
        your archive identity
      </p>
      <h1 className="mt-2 font-mono text-2xl uppercase tracking-tight sm:text-3xl">
        Profile & verification
      </h1>
      <p className="mt-4 max-w-xl text-sm leading-relaxed text-bone-dim">
        Add your ORD.NET name and picture to your holdings and activity. Sharing is optional; you
        can use the Archive without a public profile.
      </p>

      {wallet ? (
        <WalletProfileSettings key={wallet.ordAddr} walletAddress={wallet.ordAddr} />
      ) : (
        <section className="mt-6 border border-ink-2 bg-ink-1/40 p-5">
          <h2 className="font-mono text-sm uppercase tracking-[0.08em]">Start with your wallet</h2>
          <p className="mb-4 mt-2 text-sm leading-relaxed text-bone-dim">
            Connect the wallet you want to manage. Connecting alone does not publish an ORD.NET
            profile.
          </p>
          <ConnectWalletButton />
        </section>
      )}

      <section className="mt-6 border-t border-ink-2 pt-5">
        <h2 className="font-mono text-xs uppercase tracking-[0.08em]">Discord verification</h2>
        <p className="mt-2 text-sm leading-relaxed text-bone-dim">
          Nexus uses your ORD.NET profile for holder roles on participating Discord servers. Sharing
          here controls your public Archive identity; it does not assign Discord roles. Follow your
          server’s verification instructions for Nexus or Matrica.
        </p>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-3 font-mono text-[11px] uppercase tracking-[0.08em]">
          <a
            href="https://ord.net"
            target="_blank"
            rel="noopener noreferrer"
            className="text-bone underline underline-offset-4 hover:text-bone-dim"
          >
            Open ORD.NET ↗
          </a>
          <a
            href="https://docs.ord.net/guides/nexus-discord-verification/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-bone underline underline-offset-4 hover:text-bone-dim"
          >
            About Nexus ↗
          </a>
          <a
            href="https://matrica.io/settings"
            target="_blank"
            rel="noopener noreferrer"
            className="text-bone underline underline-offset-4 hover:text-bone-dim"
          >
            Manage Matrica ↗
          </a>
        </div>
      </section>
    </div>
  );
}

function WalletProfileSettings({ walletAddress }: { walletAddress: string }) {
  const { signMessage } = useWallet();
  const [data, setData] = useState<ProfileResponse | null>(null);
  const [preview, setPreview] = useState<ProfilePreview | null>(null);
  const [busy, setBusy] = useState<'loading' | 'preview' | 'publish' | 'remove' | null>('loading');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    operation.current = controller;
    void requestProfile('/api/profile/ordnet', { signal: controller.signal })
      .then(result => {
        if (result.wallet_address !== walletAddress) {
          throw new Error('Your connected wallet changed. Reconnect and try again.');
        }
        if (!controller.signal.aborted) setData(result);
      })
      .catch(err => {
        if (!controller.signal.aborted) setError(errorMessage(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(null);
      });
    return () => operation.current?.abort();
  }, [walletAddress]);

  async function run(kind: 'preview' | 'publish' | 'remove') {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setBusy(kind);
    setError(null);
    setMessage(null);
    try {
      let next: ProfileResponse;
      if (kind === 'preview') {
        setPreview(null);
        try {
          next = await requestProfile('/api/profile/ordnet?preview=true', {
            signal: controller.signal,
          });
        } catch (err) {
          if (!(err instanceof ProfileRequestError) || err.code !== 'ordnet-auth-required') {
            throw err;
          }
          if (controller.signal.aborted) return;
          await authorizeOrdnet(async (address, text) => {
            if (controller.signal.aborted) throw new Error('Wallet changed. Please try again.');
            const signature = await signMessage(address, text);
            if (controller.signal.aborted) throw new Error('Wallet changed. Please try again.');
            return signature;
          });
          if (controller.signal.aborted) return;
          next = await requestProfile('/api/profile/ordnet?preview=true', {
            signal: controller.signal,
          });
        }
        if (next.wallet_address !== walletAddress) {
          throw new Error('Your connected wallet changed. Reconnect and try again.');
        }
        if (!next.preview) throw new Error('ORD.NET did not return a profile preview.');
        if (!controller.signal.aborted) setPreview(next.preview);
      } else if (kind === 'publish') {
        if (!preview?.is_public) throw new Error('Preview a public ORD.NET wallet first.');
        next = await requestProfile('/api/profile/ordnet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            publish: true,
            expected_profile_id: preview.profile_id,
            expected_wallet_address: walletAddress,
          }),
          signal: controller.signal,
        });
        if (next.wallet_address !== walletAddress) {
          throw new Error('Your connected wallet changed. Reconnect and try again.');
        }
        if (!controller.signal.aborted) {
          setPreview(null);
          setMessage('Your ORD.NET profile is now shared for this wallet.');
        }
      } else {
        next = await requestProfile('/api/profile/ordnet', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expected_wallet_address: walletAddress }),
          signal: controller.signal,
        });
        if (next.wallet_address !== walletAddress) {
          throw new Error('Your connected wallet changed. Reconnect and try again.');
        }
        if (!controller.signal.aborted) {
          setPreview(null);
          setMessage('ORD.NET sharing has been removed for this wallet.');
        }
      }
      if (!controller.signal.aborted && next.wallet_address === walletAddress) setData(next);
    } catch (err) {
      if (!controller.signal.aborted) setError(errorMessage(err));
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  const sharing = data?.sharing;

  return (
    <section className="mt-6 border border-ink-2 bg-ink-1/40 p-4 sm:p-5" aria-busy={busy !== null}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-mono text-sm uppercase tracking-[0.08em]">Public Archive profile</h2>
        <span className="border border-ink-2 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.08em] text-bone-dim">
          {busy === 'loading'
            ? 'Checking'
            : !data
              ? 'Unavailable'
              : sharing
                ? 'Sharing on'
                : 'Sharing off'}
        </span>
      </div>
      <p className="mt-3 break-all font-mono text-[11px] leading-relaxed text-bone-dim">
        {walletAddress}
      </p>
      <p className="mt-3 text-sm leading-relaxed text-bone-dim">
        Only this ordinals wallet is shared. Your payment address and other ORD.NET wallets are not
        imported. Wallets you share separately with the same ORD.NET profile may be grouped in
        public holdings and leaderboards.
      </p>
      <p className="mt-2 text-xs leading-relaxed text-bone-dim">
        Sharing stays on until you remove it here. Changes to your ORD.NET wallet visibility are not
        synced automatically.
      </p>
      {data?.matrica_linked && (
        <p className="mt-3 border-l-2 border-bone-dim/50 pl-3 text-xs leading-relaxed text-bone-dim">
          This wallet already has a claimed Matrica identity. Matrica takes priority in the Archive;
          sharing ORD.NET will not replace or merge those profiles.
        </p>
      )}

      {sharing && (
        <div className="mt-4 border border-ink-2 bg-ink-0 p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-bone-dim">
            Currently shared
          </p>
          <p className="mt-1 break-words text-lg text-bone">
            {sharing.username || 'Unnamed ORD.NET profile'}
          </p>
          <Link
            href={`/holder/${walletAddress}`}
            className="mt-2 inline-block font-mono text-[10px] uppercase tracking-[0.08em] text-bone-dim underline underline-offset-4 hover:text-bone"
          >
            View public holdings →
          </Link>
        </div>
      )}

      {preview && (
        <div className="mt-4 border border-bone-dim/60 bg-ink-0 p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-bone-dim">
            Preview · ORD.NET
          </p>
          <p className="mt-1 break-words text-lg text-bone">
            {preview.username || 'Unnamed ORD.NET profile'}
          </p>
          {preview.is_public ? (
            <>
              <p className="mt-2 text-xs leading-relaxed text-bone-dim">
                Publishing makes your ORD.NET name, picture, and connection to the wallet above
                public on the Archive. You can remove this sharing here at any time.
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void run('publish')}
                  className={`${BUTTON} bg-bone text-ink-0 hover:bg-bone-dim`}
                >
                  {busy === 'publish' ? 'Publishing…' : 'Publish for this wallet'}
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => setPreview(null)}
                  className="min-h-10 px-2 font-mono text-[11px] uppercase tracking-[0.08em] text-bone-dim hover:text-bone disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <p className="mt-2 text-xs leading-relaxed text-bone-dim">
              This wallet is private on ORD.NET. To share it here, make this wallet public in your
              ORD.NET profile, then preview again.
            </p>
          )}
        </div>
      )}

      <div aria-live="polite" className="mt-4">
        {error && (
          <p
            role="alert"
            className="break-words border border-accent-red/50 p-3 text-xs leading-relaxed text-accent-red"
          >
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="text-xs leading-relaxed text-bone">
            {message}
          </p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void run('preview')}
          className={BUTTON}
        >
          {busy === 'preview'
            ? 'Checking ORD.NET…'
            : sharing
              ? 'Preview an update'
              : 'Preview ORD.NET profile'}
        </button>
        {sharing && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void run('remove')}
            className="min-h-10 px-2 font-mono text-[10px] uppercase tracking-[0.08em] text-bone-dim underline underline-offset-4 hover:text-bone disabled:opacity-50"
          >
            {busy === 'remove' ? 'Removing…' : 'Remove sharing for this wallet'}
          </button>
        )}
      </div>

      <details className="mt-4 text-xs leading-relaxed text-bone-dim">
        <summary className="cursor-pointer py-1 underline underline-offset-4">
          Before you connect ORD.NET
        </summary>
        <p className="mt-2">
          Preview may ask you to sign ORD.NET login messages. Its current API requires at least
          100,000 sats (0.001 BTC) confirmed at your connected payment address. That is an API
          eligibility check, not a payment to the Archive or a stated Nexus verification fee. If
          your wallet does not qualify, you can still use the Archive and follow your Discord
          server’s normal verification process.
        </p>
      </details>
    </section>
  );
}

class ProfileRequestError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
  }
}

async function requestProfile(url: string, init?: RequestInit): Promise<ProfileResponse> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const json = (await response.json().catch(() => null)) as ProfileResponse | null;
  if (!response.ok || !json) {
    throw new ProfileRequestError(
      json?.error || 'Could not load your profile. Please try again.',
      json?.code
    );
  }
  return json;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
