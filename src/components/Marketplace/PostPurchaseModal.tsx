'use client';

import { useEffect, useRef, useState } from 'react';
import CommunityVerificationPrompt, { type MatricaState } from './CommunityVerificationPrompt';
import { formatBtc, truncateAddr } from '@/lib/format';
import type { MarketplaceListing } from '@/lib/marketplace/types';
import { useWallet } from '@/components/wallet/WalletProvider';

type Props = {
  listing: MarketplaceListing;
  txid: string;
  discordInviteUrl: string;
  matricaSignupUrl: string;
  nexusVerificationEnabled?: boolean;
  onClose: () => void;
};

export default function PostPurchaseModal({
  listing,
  txid,
  discordInviteUrl,
  matricaSignupUrl,
  nexusVerificationEnabled = false,
  onClose,
}: Props) {
  const { wallet } = useWallet();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [matrica, setMatrica] = useState<{ addr: string | null; state: MatricaState }>({
    addr: null,
    state: { status: 'loading' },
  });
  const isMockTx = txid.startsWith('mock-');
  const activeMatrica: MatricaState = wallet?.ordAddr
    ? matrica.addr === wallet.ordAddr
      ? matrica.state
      : { status: 'loading' }
    : { status: 'unknown', reason: 'wallet unavailable' };

  useEffect(() => {
    const previousFocus = document.activeElement;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex="0"]'
      );
      if (!elements?.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [onClose]);

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
        ref={dialogRef}
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
              ref={closeRef}
              type="button"
              onClick={onClose}
              className="h-9 w-9 text-bone-dim hover:text-bone"
              aria-label="Close receipt"
            >
              ✕
            </button>
          </div>

          <div className="my-5 border-t border-ink-2" />
          <CommunityVerificationPrompt
            state={activeMatrica}
            matricaUrl={matricaSignupUrl}
            discordInviteUrl={discordInviteUrl}
            nexusVerificationEnabled={nexusVerificationEnabled}
          />
          <div className="mt-auto pt-5 text-[10px] leading-relaxed text-bone-dim">
            {isMockTx
              ? 'Preview receipt. No Bitcoin transaction was sent.'
              : 'Transaction submitted. Confirmation time depends on Bitcoin network fees.'}
          </div>
        </div>
      </div>
    </div>
  );
}
