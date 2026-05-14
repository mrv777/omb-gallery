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
  const [matrica, setMatrica] = useState<{ addr: string | null; state: MatricaState }>({
    addr: null,
    state: { status: 'loading' },
  });
  const matricaUrl = buildMatricaUrl(matricaSignupUrl);
  const isMockTx = txid.startsWith('mock-');
  const activeMatrica: MatricaState = wallet?.ordAddr
    ? matrica.addr === wallet.ordAddr
      ? matrica.state
      : { status: 'loading' }
    : { status: 'unknown', reason: 'wallet unavailable' };

  useEffect(() => {
    const addr = wallet?.ordAddr;
    if (!addr) return;
    let cancelled = false;
    fetch(`/api/marketplace/matrica?addr=${encodeURIComponent(addr)}`)
      .then(res => res.json())
      .then(json => {
        if (cancelled) return;
        if (json?.status === 'linked' && json.profile) {
          setMatrica({
            addr,
            state: {
              status: 'linked',
              username: json.profile.username,
              placeholder: !!json.profile.placeholder,
            },
          });
        } else {
          setMatrica({
            addr,
            state: {
              status: json?.status === 'none' ? 'none' : 'unknown',
              reason: json?.reason,
            },
          });
        }
      })
      .catch(() => {
        if (!cancelled) setMatrica({ addr, state: { status: 'unknown' } });
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
            state={activeMatrica}
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
      <CommunityPrompt
        label="matrica linked"
        message={
          <>
            Linked as <span className="break-all text-bone">@{state.username}</span>. Confirm
            Discord is linked there, then join Discord.
          </>
        }
        actions={[
          { href: matricaUrl, label: 'check matrica' },
          discord ? { href: discord, label: 'join discord', primary: true } : null,
        ]}
      />
    );
  }
  if (state.status === 'linked' && state.placeholder) {
    return (
      <CommunityPrompt
        label="matrica profile needed"
        message="Finish your Matrica profile and link Discord, then join Discord."
        actions={[
          { href: matricaUrl, label: 'finish matrica', primary: true },
          discord ? { href: discord, label: 'join discord' } : null,
        ]}
      />
    );
  }
  return (
    <CommunityPrompt
      label="matrica needed"
      message={`Link this wallet${discord ? ' and Discord' : ''} on Matrica first, before you can join the Discord.`}
      actions={[
        { href: matricaUrl, label: 'link on matrica', primary: true },
        discord ? { href: discord, label: 'join discord' } : null,
      ]}
    />
  );
}

type CommunityAction = {
  href: string;
  label: string;
  primary?: boolean;
} | null;

function CommunityPrompt({
  label,
  message,
  actions,
}: {
  label: string;
  message: ReactNode;
  actions: CommunityAction[];
}) {
  return (
    <div className="max-w-xl space-y-3 text-[11px] leading-relaxed text-bone-dim">
      <div>
        <div className="mb-1 text-[10px] text-bone">{label}</div>
        <div>{message}</div>
      </div>
      <div className="grid gap-2 sm:flex sm:flex-wrap">
        {actions.map(action =>
          action ? (
            <CommunityButton
              key={`${action.href}-${action.label}`}
              href={action.href}
              primary={action.primary}
            >
              {action.label}
            </CommunityButton>
          ) : null
        )}
      </div>
    </div>
  );
}

function CommunityButton({
  href,
  primary = false,
  children,
}: {
  href: string;
  primary?: boolean;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex min-h-9 items-center justify-center border px-3 text-center text-[10px] transition-colors ${
        primary
          ? 'border-bone text-bone hover:border-accent-orange hover:text-accent-orange'
          : 'border-ink-2 text-bone-dim hover:border-bone-dim hover:text-bone'
      }`}
    >
      {children}
    </a>
  );
}
