'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { createPortal } from 'react-dom';
import { useWallet } from './WalletProvider';
import type { SatsWalletOption } from '@/lib/wallet/satsConnect';

export default function ConnectWalletButton({ compact = false }: { compact?: boolean }) {
  const { wallet, connecting, connect, disconnect, error } = useWallet();
  const [open, setOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [walletOptions, setWalletOptions] = useState<SatsWalletOption[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);
  const errorId = useId();

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!pickerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPickerOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pickerOpen]);

  if (wallet) {
    return (
      <div ref={menuRef} className="relative flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen(value => !value)}
          className="h-8 border border-ink-2 px-2 font-mono text-[10px] uppercase tracking-[0.08em] text-bone hover:border-bone-dim"
          title={wallet.ordAddr}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          {shortAddress(wallet.ordAddr, compact)}
        </button>
        {open && (
          <div
            role="menu"
            className="absolute right-0 top-full z-[1300] mt-2 min-w-44 border border-ink-2 bg-ink-0 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-bone-dim shadow-[0_0_0_1px_var(--ink-0)]"
          >
            <Link
              href={`/holder/${wallet.ordAddr}`}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block px-3 py-2 hover:bg-ink-1 hover:text-bone"
            >
              VIEW HOLDINGS
            </Link>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void disconnect();
              }}
              className="block w-full px-3 py-2 text-left hover:bg-ink-1 hover:text-bone"
            >
              DISCONNECT
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative flex items-center gap-2">
      <button
        type="button"
        onClick={() => void openWalletPicker()}
        disabled={connecting}
        aria-describedby={error ? errorId : undefined}
        className="h-8 border border-bone-dim/60 px-2 font-mono text-[10px] uppercase tracking-[0.08em] text-bone hover:border-bone disabled:opacity-50"
      >
        {connecting ? 'connecting' : 'connect'}
      </button>
      {error && (
        <span
          id={errorId}
          role="status"
          aria-live="polite"
          className={
            compact
              ? 'absolute right-0 top-full z-[1300] mt-2 w-56 border border-accent-red/50 bg-ink-0 px-2 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-accent-red shadow-[0_0_0_1px_var(--ink-0)]'
              : 'max-w-64 font-mono text-[10px] uppercase tracking-[0.08em] text-accent-red'
          }
        >
          {error}
        </span>
      )}
      {pickerOpen && (
        <WalletPickerDialog
          options={walletOptions}
          connecting={connecting}
          error={error}
          onClose={() => setPickerOpen(false)}
          onSelect={providerId => {
            void connect(providerId)
              .then(() => setPickerOpen(false))
              .catch(() => null);
          }}
        />
      )}
    </div>
  );

  async function openWalletPicker() {
    if (process.env.NEXT_PUBLIC_MARKETPLACE_MOCK_WALLET === 'true') {
      await connect().catch(() => null);
      return;
    }
    const walletModule = await import('@/lib/wallet/satsConnect');
    setWalletOptions(walletModule.getSatsWalletOptions());
    setPickerOpen(true);
  }
}

function shortAddress(address: string, compact: boolean): string {
  const head = compact ? 6 : 8;
  const tail = compact ? 4 : 6;
  if (address.length <= head + tail + 3) return address;
  return `${address.slice(0, head)}...${address.slice(-tail)}`;
}

function WalletPickerDialog({
  options,
  connecting,
  error,
  onClose,
  onSelect,
}: {
  options: SatsWalletOption[];
  connecting: boolean;
  error: string | null;
  onClose: () => void;
  onSelect: (providerId: string) => void;
}) {
  return createPortal(
    <div
      className="fixed inset-0 z-[1800] grid place-items-center overflow-y-auto bg-ink-0/85 p-4 backdrop-blur-sm sm:p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-picker-title"
        className="max-h-[calc(100dvh-2rem)] w-full max-w-[420px] overflow-y-auto border border-ink-2 bg-ink-0 p-4 font-mono uppercase tracking-[0.08em] shadow-[0_20px_60px_rgba(0,0,0,0.85)] sm:max-h-[calc(100dvh-3rem)]"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id="wallet-picker-title" className="text-lg text-bone">
            connect wallet
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 text-bone-dim hover:text-bone"
            aria-label="Close wallet picker"
          >
            x
          </button>
        </div>

        <div className="mt-4 space-y-2">
          {options.length === 0 && (
            <div className="border border-ink-2 px-3 py-4 text-[10px] leading-relaxed text-bone-dim">
              No compatible Bitcoin wallet was found. Install or enable Xverse, then try again.
            </div>
          )}
          {options.map(option =>
            option.isInstalled ? (
              <button
                key={option.id}
                type="button"
                onClick={() => onSelect(option.id)}
                disabled={connecting}
                className="grid h-14 w-full grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-3 border border-ink-2 px-3 text-left text-[11px] text-bone transition-colors hover:border-bone-dim disabled:cursor-wait disabled:opacity-50"
              >
                <WalletIcon option={option} />
                <span className="truncate">{option.name}</span>
                <span className="text-[9px] text-bone-dim">
                  {connecting ? 'opening' : 'select'}
                </span>
              </button>
            ) : (
              <UnavailableWalletOption key={option.id} option={option} />
            )
          )}
        </div>

        {error && (
          <div className="mt-4 border border-accent-red/50 px-3 py-2 text-[10px] leading-relaxed text-accent-red">
            {error}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

function WalletIcon({ option, dim = false }: { option: SatsWalletOption; dim?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`block h-8 w-8 bg-contain bg-center bg-no-repeat ${dim ? 'opacity-60' : ''}`}
      style={{ backgroundImage: `url(${option.icon})` }}
    />
  );
}

function UnavailableWalletOption({ option }: { option: SatsWalletOption }) {
  const content = (
    <>
      <WalletIcon option={option} dim />
      <span className="truncate">{option.name}</span>
      <span className="text-[9px]">{option.installUrl ? 'install' : 'missing'}</span>
    </>
  );
  const className =
    'grid h-14 w-full grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-3 border border-ink-2 px-3 text-left text-[11px] text-bone-dim transition-colors hover:border-bone-dim hover:text-bone';
  if (!option.installUrl) {
    return <div className={`${className} cursor-not-allowed opacity-60`}>{content}</div>;
  }
  return (
    <a href={option.installUrl} target="_blank" rel="noopener noreferrer" className={className}>
      {content}
    </a>
  );
}
