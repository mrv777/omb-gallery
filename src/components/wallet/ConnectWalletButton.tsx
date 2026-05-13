'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useWallet } from './WalletProvider';

export default function ConnectWalletButton({ compact = false }: { compact?: boolean }) {
  const { wallet, connecting, connect, disconnect, error } = useWallet();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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
              holder page
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
              disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => void connect()}
        disabled={connecting}
        className="h-8 border border-bone-dim/60 px-2 font-mono text-[10px] uppercase tracking-[0.08em] text-bone hover:border-bone disabled:opacity-50"
      >
        {connecting ? 'connecting' : 'connect'}
      </button>
      {error && !compact && (
        <span className="hidden max-w-48 truncate font-mono text-[10px] uppercase tracking-[0.08em] text-accent-red sm:inline">
          {error}
        </span>
      )}
    </div>
  );
}

function shortAddress(address: string, compact: boolean): string {
  const head = compact ? 6 : 8;
  const tail = compact ? 4 : 6;
  if (address.length <= head + tail + 3) return address;
  return `${address.slice(0, head)}...${address.slice(-tail)}`;
}
