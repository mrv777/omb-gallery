'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  ordNetWalletLink,
  ordiscanWalletLink,
  satflowWalletLink,
  truncateAddr,
} from '@/lib/format';
import { Tooltip } from '../ui/Tooltip';
import CopyAddressButton from './CopyAddressButton';

const COLLAPSE_THRESHOLD = 3;

type Props = {
  wallets: string[];
  /** Wallets in this set were folded into the identity by on-chain
   * inference rather than confirmed via Matrica.
   * Tagged in the row so users can tell them apart. */
  inferredWallets?: ReadonlyArray<string>;
  /** Subset of inferred wallets folded by repeated listing-staging evidence. */
  stagingWallets?: ReadonlyArray<string>;
};

export function WalletsList({ wallets, inferredWallets = [], stagingWallets = [] }: Props) {
  const inferredSet = new Set(inferredWallets);
  const stagingSet = new Set(stagingWallets);
  const collapsible = wallets.length > COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(false);
  const visible = collapsible && !expanded ? wallets.slice(0, COLLAPSE_THRESHOLD) : wallets;

  return (
    <div>
      <div className="flex items-baseline gap-3 mb-2 flex-wrap">
        <span className="text-[10px] tracking-[0.12em] uppercase text-bone-dim">
          wallets · {wallets.length}
        </span>
        {inferredSet.size > 0 ? (
          <span
            className="text-[10px] tracking-[0.12em] uppercase text-bone-dim"
            title="Folded into the identity by on-chain cluster or listing-staging evidence — not Matrica-confirmed"
          >
            +{inferredSet.size} inferred
          </span>
        ) : null}
        {stagingSet.size > 0 ? (
          <span
            className="text-[10px] tracking-[0.12em] uppercase text-bone-dim"
            title="Subset folded by repeated transfer-to-list/sale staging evidence within 12 hours"
          >
            {stagingSet.size} staging
          </span>
        ) : null}
        {collapsible && (
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            className="text-[10px] tracking-[0.12em] uppercase text-bone-dim hover:text-bone"
          >
            {expanded ? 'show less' : `show all (${wallets.length}) ↓`}
          </button>
        )}
      </div>
      <ul className="divide-y divide-ink-2 border border-ink-2">
        {visible.map(w => {
          const inferred = inferredSet.has(w);
          const staging = stagingSet.has(w);
          return (
            <li key={w} className="flex flex-wrap items-center gap-2 sm:gap-3 px-3 py-2">
              <Tooltip content={w}>
                <Link
                  href={`/holder/${w}`}
                  prefetch={false}
                  className="font-mono text-xs text-bone hover:text-accent-orange tabular-nums truncate min-w-0"
                >
                  {truncateAddr(w, 10, 8)}
                </Link>
              </Tooltip>
              <CopyAddressButton address={w} compact />
              {staging ? (
                <span
                  className="text-[9px] tracking-[0.12em] uppercase text-accent-orange border border-accent-orange/50 px-1.5 py-0.5 leading-none shrink-0"
                  title="Folded by repeated listing-staging evidence within 12 hours — not Matrica-confirmed"
                >
                  staging
                </span>
              ) : inferred ? (
                <span
                  className="text-[9px] tracking-[0.12em] uppercase text-bone-dim border border-ink-2 px-1.5 py-0.5 leading-none shrink-0"
                  title="On-chain inferred (≥99%) — not Matrica-confirmed"
                >
                  inferred
                </span>
              ) : null}
              <span className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1.5">
                <a
                  href={ordNetWalletLink(w)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="border border-ink-2 hover:border-bone-dim px-1.5 py-0.5 text-[9px] tracking-[0.12em] uppercase text-bone-dim hover:text-bone"
                >
                  ord.net ↗
                </a>
                <a
                  href={satflowWalletLink(w)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="border border-ink-2 hover:border-bone-dim px-1.5 py-0.5 text-[9px] tracking-[0.12em] uppercase text-bone-dim hover:text-bone"
                >
                  satflow ↗
                </a>
                <a
                  href={ordiscanWalletLink(w)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="border border-ink-2 hover:border-bone-dim px-1.5 py-0.5 text-[9px] tracking-[0.12em] uppercase text-bone-dim hover:text-bone"
                >
                  ordiscan ↗
                </a>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
