'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { formatBtc, truncateAddr } from '@/lib/format';
import type { MarketplaceListing } from '@/lib/marketplace/types';
import { useWallet } from '@/components/wallet/WalletProvider';

type Props = {
  listing: MarketplaceListing;
  txid: string;
  discordInviteUrl: string;
  matricaSignupUrl: string;
  onClose: () => void;
};

type MatricaState =
  | { status: 'loading' }
  | { status: 'linked'; username: string; placeholder: boolean }
  | { status: 'none' | 'unknown'; reason?: string };

export default function PostPurchaseModal({
  listing,
  txid,
  discordInviteUrl,
  matricaSignupUrl,
  onClose,
}: Props) {
  const { wallet } = useWallet();
  const [matrica, setMatrica] = useState<MatricaState>({ status: 'loading' });
  const matricaUrl = buildMatricaUrl(matricaSignupUrl);
  const isMockTx = txid.startsWith('mock-');

  useEffect(() => {
    if (!wallet?.ordAddr) {
      setMatrica({ status: 'unknown', reason: 'wallet unavailable' });
      return;
    }
    let cancelled = false;
    fetch(`/api/marketplace/matrica?addr=${encodeURIComponent(wallet.ordAddr)}`)
      .then(res => res.json())
      .then(json => {
        if (cancelled) return;
        if (json?.status === 'linked' && json.profile) {
          setMatrica({
            status: 'linked',
            username: json.profile.username,
            placeholder: !!json.profile.placeholder,
          });
        } else {
          setMatrica({
            status: json?.status === 'none' ? 'none' : 'unknown',
            reason: json?.reason,
          });
        }
      })
      .catch(() => {
        if (!cancelled) setMatrica({ status: 'unknown' });
      });
    return () => {
      cancelled = true;
    };
  }, [wallet?.ordAddr]);

  return (
    <div className="fixed inset-0 z-[1700] bg-ink-0/85 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Purchase receipt"
        className="absolute left-1/2 top-1/2 grid max-h-[92vh] w-[min(92vw,860px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto border border-ink-2 bg-ink-0 md:grid-cols-[24rem_1fr]"
        onClick={e => e.stopPropagation()}
      >
        <div className="aspect-square bg-ink-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={listing.full} alt="" className="h-full w-full object-contain" />
        </div>
        <div className="flex min-h-0 flex-col p-4 font-mono uppercase tracking-[0.08em] sm:p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-lg text-bone">
                OMB #{listing.inscription_number} - {formatBtc(listing.price_sats)}
              </div>
              <div className="mt-2 text-[11px] text-bone-dim">
                Tx:{' '}
                {isMockTx ? (
                  <span className="text-bone">{truncateAddr(txid, 10, 8)}</span>
                ) : (
                  <a
                    href={`https://mempool.space/tx/${txid}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-bone hover:text-accent-orange"
                  >
                    {truncateAddr(txid, 10, 8)}
                  </a>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="h-9 w-9 text-bone-dim hover:text-bone"
              aria-label="Close receipt"
            >
              ✕
            </button>
          </div>

          <div className="my-5 border-t border-ink-2" />
          <MatricaBlock
            state={matrica}
            matricaUrl={matricaUrl}
            discordInviteUrl={discordInviteUrl}
          />
          <div className="mt-auto pt-5 text-[10px] leading-relaxed text-bone-dim">
            Tx is in the mempool. It typically confirms within an hour.
          </div>
        </div>
      </div>
    </div>
  );
}

function buildMatricaUrl(base: string): string {
  try {
    return new URL(base || 'https://matrica.io/settings').toString();
  } catch {
    return 'https://matrica.io/settings';
  }
}

function MatricaBlock({
  state,
  matricaUrl,
  discordInviteUrl,
}: {
  state: MatricaState;
  matricaUrl: string;
  discordInviteUrl: string;
}) {
  const discord = discordInviteUrl.trim();
  if (state.status === 'loading') {
    return <div className="text-[11px] text-bone-dim">checking matrica...</div>;
  }
  if (state.status === 'linked' && !state.placeholder) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-bone-dim">
        <span>
          linked as <span className="text-bone">@{state.username}</span>
        </span>
        <CommunityActions matricaUrl={matricaUrl} discordUrl={discord} />
      </div>
    );
  }
  if (state.status === 'linked' && state.placeholder) {
    return (
      <div className="space-y-3">
        <div className="text-[11px] text-bone-dim">finish your matrica profile</div>
        <CommunityActions matricaUrl={matricaUrl} discordUrl={discord} />
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="text-[11px] leading-relaxed text-bone-dim">
        link your wallet on matrica{discord ? ', then join discord' : ''}
      </div>
      <CommunityActions matricaUrl={matricaUrl} discordUrl={discord} />
    </div>
  );
}

function CommunityActions({ matricaUrl, discordUrl }: { matricaUrl: string; discordUrl: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      <CommunityButton href={matricaUrl}>open matrica</CommunityButton>
      {discordUrl && <CommunityButton href={discordUrl}>join discord</CommunityButton>}
    </div>
  );
}

function CommunityButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex h-8 items-center border border-ink-2 px-2 text-[10px] text-bone-dim transition-colors hover:border-bone-dim hover:text-bone"
    >
      {children}
    </a>
  );
}
