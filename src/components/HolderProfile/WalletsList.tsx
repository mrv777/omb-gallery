'use client';

import { useState } from 'react';
import Link from 'next/link';
import { addressLink, ordNetWalletLink, truncateAddr } from '@/lib/format';

const COLLAPSE_THRESHOLD = 3;

export function WalletsList({ wallets }: { wallets: string[] }) {
  const collapsible = wallets.length > COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(false);
  const visible = collapsible && !expanded ? wallets.slice(0, COLLAPSE_THRESHOLD) : wallets;

  return (
    <div>
      <div className="flex items-baseline gap-3 mb-2">
        <span className="text-[10px] tracking-[0.12em] uppercase text-bone-dim">
          wallets · {wallets.length}
        </span>
        {collapsible && (
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            className="text-[10px] tracking-[0.12em] uppercase text-bone-dim hover:text-bone"
          >
            {expanded
              ? 'show less'
              : `show all (${wallets.length}) ↓`}
          </button>
        )}
      </div>
      <ul className="divide-y divide-ink-2 border border-ink-2">
        {visible.map(w => (
          <li key={w} className="flex items-center gap-2 sm:gap-3 px-3 py-2">
            <Link
              href={`/holder/${w}`}
              prefetch={false}
              className="font-mono text-xs text-bone hover:text-accent-orange tabular-nums truncate min-w-0"
              title={w}
            >
              {truncateAddr(w, 10, 8)}
            </Link>
            <span className="ml-auto flex items-center gap-1.5 shrink-0">
              <a
                href={ordNetWalletLink(w)}
                target="_blank"
                rel="noopener noreferrer"
                className="border border-ink-2 hover:border-bone-dim px-1.5 py-0.5 text-[9px] tracking-[0.12em] uppercase text-bone-dim hover:text-bone"
              >
                ord.net ↗
              </a>
              <a
                href={addressLink(w)}
                target="_blank"
                rel="noopener noreferrer"
                className="border border-ink-2 hover:border-bone-dim px-1.5 py-0.5 text-[9px] tracking-[0.12em] uppercase text-bone-dim hover:text-bone"
              >
                ord.io ↗
              </a>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
