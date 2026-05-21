'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { ListingStagingLinkRow } from '@/lib/listingStagingStore';
import { truncateAddr } from '@/lib/format';
import { lookupWalletLabel } from '@/lib/walletLabels';

type Props = {
  rows: readonly ListingStagingLinkRow[];
};

const COLLAPSED_LIMIT = 8;

export default function ListingStagingWallets({ rows }: Props) {
  const [expanded, setExpanded] = useState(false);
  if (rows.length === 0) return null;

  const visible = expanded ? rows : rows.slice(0, COLLAPSED_LIMIT);
  const hasMore = rows.length > COLLAPSED_LIMIT;

  return (
    <div className="mt-8 mb-12">
      <div className="flex items-baseline justify-between mb-3 gap-3">
        <h2 className="font-mono text-xs tracking-[0.12em] uppercase text-bone flex items-baseline gap-2">
          <span>
            listing-staging wallets{' '}
            <span className="text-bone-dim tabular-nums">· {rows.length}</span>
          </span>
          <span
            className="text-[9px] tracking-[0.12em] uppercase text-accent-orange border border-accent-orange/50 px-1.5 py-0.5 leading-none"
            title="Folded into counts by repeated 12h staging evidence"
          >
            folded
          </span>
        </h2>
        <span className="font-mono text-[10px] tracking-[0.08em] uppercase text-bone-dim shrink-0">
          repeated transfer -&gt; sale/list &le; 12h
        </span>
      </div>
      <p className="font-mono text-[11px] text-bone-dim mb-4 normal-case tracking-normal">
        These directed links repeatedly moved OMBs into a seller wallet shortly before a listing or
        sale. They affect holder counts, but remain separate from Matrica-confirmed identity.
      </p>
      <ul className="border border-ink-2 divide-y divide-ink-2 font-mono text-[12px]">
        {visible.map(row => (
          <ListingStagingRowItem key={`${row.source_wallet}->${row.seller_wallet}`} row={row} />
        ))}
      </ul>
      {hasMore ? (
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="mt-2 font-mono text-[10px] tracking-[0.08em] uppercase text-bone-dim hover:text-bone"
        >
          {expanded ? `show fewer ↑` : `show all (${rows.length}) ↓`}
        </button>
      ) : null}
    </div>
  );
}

function ListingStagingRowItem({ row }: { row: ListingStagingLinkRow }) {
  const sourceDisplay = displayWallet(row.source_wallet, row.source_matrica);
  const sellerDisplay = displayWallet(row.seller_wallet, row.seller_matrica);
  const median = formatDuration(row.fast_12h_median_gap_sec ?? row.median_gap_sec);
  const activity =
    row.listing_count > 0 && row.sale_count > 0
      ? `${row.sale_count} sale · ${row.listing_count} list`
      : row.sale_count > 0
        ? `${row.sale_count} sale`
        : `${row.listing_count} list`;

  return (
    <li>
      <details className="group">
        <summary className="cursor-pointer list-none flex items-center gap-3 px-3 py-2.5 hover:bg-ink-2/40">
          <span className="text-accent-orange tabular-nums shrink-0 w-9">
            {row.fast_12h_distinct_inscriptions}x
          </span>
          <span className="min-w-0 flex-1 flex items-center gap-2">
            <WalletLink wallet={row.source_wallet} display={sourceDisplay} />
            <span className="text-bone-dim shrink-0">-&gt;</span>
            <WalletLink wallet={row.seller_wallet} display={sellerDisplay} />
          </span>
          <span className="text-[10px] tracking-[0.08em] uppercase text-bone-dim shrink-0">
            {activity} · median {median}
          </span>
          <span className="text-bone-dim shrink-0 group-open:rotate-90 transition-transform">
            ›
          </span>
        </summary>
        <div className="bg-ink-2/30 border-t border-ink-2 px-3 py-2 space-y-2">
          <div className="grid gap-1 text-[10px] text-bone-dim">
            <div className="break-all">
              <span className="uppercase tracking-[0.08em]">source</span> {row.source_wallet}
            </div>
            <div className="break-all">
              <span className="uppercase tracking-[0.08em]">seller</span> {row.seller_wallet}
            </div>
          </div>
          <ul className="text-[10px] text-bone-dim space-y-0.5">
            {row.evidence.map((e, i) => (
              <li
                key={`${e.prev_txid}-${e.trigger_ref}-${e.inscription_number}-${i}`}
                className="flex items-baseline gap-2"
              >
                <Link
                  href={`/inscription/${e.inscription_number}`}
                  className="uppercase tracking-[0.08em] w-20 shrink-0 hover:text-bone"
                >
                  #{e.inscription_number}
                </Link>
                <span className="uppercase tracking-[0.08em] w-12 shrink-0">{e.trigger_group}</span>
                <a
                  href={`https://mempool.space/tx/${e.prev_txid}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-bone-dim hover:text-bone underline tabular-nums truncate"
                >
                  {truncateAddr(e.prev_txid, 10, 6)}
                </a>
                <span className="ml-auto text-bone-dim/70 tabular-nums shrink-0">
                  {formatDuration(e.gap_sec)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </details>
    </li>
  );
}

function WalletLink({ wallet, display }: { wallet: string; display: string }) {
  return (
    <Link
      href={`/holder/${wallet}`}
      onClick={e => e.stopPropagation()}
      className="min-w-0 truncate text-bone hover:underline"
      title={wallet}
    >
      {display}
    </Link>
  );
}

function displayWallet(wallet: string, matrica: { username: string | null } | null): string {
  const manual = lookupWalletLabel(wallet);
  if (manual) return manual.name;
  if (matrica?.username && !looksLikeAddress(matrica.username)) return matrica.username;
  return truncateAddr(wallet, 8, 6);
}

function looksLikeAddress(s: string): boolean {
  return /^bc1[a-z0-9]{20,}/i.test(s) || /^0x[a-f0-9]{40}$/i.test(s);
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60 * 60) return `${Math.round(seconds / 60)}m`;
  if (seconds < 24 * 60 * 60) return `${(seconds / (60 * 60)).toFixed(1)}h`;
  return `${(seconds / (24 * 60 * 60)).toFixed(1)}d`;
}
