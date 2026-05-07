'use client';

import Link from 'next/link';
import type { LikelyLinkedRow } from '@/lib/clusterStore';
import { truncateAddr } from '@/lib/format';
import { lookupWalletLabel } from '@/lib/walletLabels';

type Props = {
  rows: readonly LikelyLinkedRow[];
};

/**
 * "Likely-linked wallets (on-chain)" — surfaced under the Matrica
 * sibling list. Pure heuristic, never silently merges into Matrica
 * identity. Each row shows the peer, signal strength, and an
 * expandable evidence trail with the actual txids that fed the score.
 *
 * Confidence formatting: stored 0–10000 → display as 99% / 95% / etc.
 * The threshold for inclusion is set by the caller (page.tsx); any
 * row reaching it is displayed without further filtering.
 */
export default function LikelyLinkedWallets({ rows }: Props) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-8 mb-12">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="font-mono text-xs tracking-[0.12em] uppercase text-bone">
          likely-linked wallets{' '}
          <span className="text-bone-dim tabular-nums">· {rows.length}</span>
        </h2>
        <span className="font-mono text-[10px] tracking-[0.08em] uppercase text-bone-dim">
          on-chain analysis · ≥ {Math.round((rows[rows.length - 1].confidence / 100))}%
        </span>
      </div>
      <p className="font-mono text-[11px] text-bone-dim mb-4 normal-case tracking-normal">
        Inferred from co-spending and unbroken transfer chains. Not
        Matrica-confirmed — high probability, not certainty. Click a
        row to inspect the evidence.
      </p>
      <ul className="border border-ink-2 divide-y divide-ink-2 font-mono text-[12px]">
        {rows.map(r => (
          <LikelyLinkedRowItem key={r.peer} row={r} />
        ))}
      </ul>
    </div>
  );
}

function LikelyLinkedRowItem({ row }: { row: LikelyLinkedRow }) {
  const manual = lookupWalletLabel(row.peer);
  const display = manual?.name ?? row.matrica?.username ?? truncateAddr(row.peer, 8, 6);
  const conf = (row.confidence / 100).toFixed(0);
  const signals: string[] = [];
  if (row.cih_count > 0) signals.push(`${row.cih_count}× co-input`);
  if (row.self_xfer_count > 0) signals.push(`${row.self_xfer_count}× transfer`);

  return (
    <li>
      <details className="group">
        <summary className="cursor-pointer list-none flex items-center gap-3 px-3 py-2.5 hover:bg-ink-2/40">
          <span className="text-bone-dim tabular-nums shrink-0 w-9">{conf}%</span>
          <Link
            href={`/holder/${row.peer}`}
            onClick={e => e.stopPropagation()}
            className={`min-w-0 flex-1 truncate ${
              manual
                ? 'text-accent-orange'
                : row.matrica
                  ? 'text-bone'
                  : 'text-bone tabular-nums'
            } hover:underline`}
          >
            {display}
          </Link>
          <span className="text-[10px] tracking-[0.08em] uppercase text-bone-dim shrink-0">
            {signals.join(' · ')}
          </span>
          <span className="text-bone-dim shrink-0 group-open:rotate-90 transition-transform">
            ›
          </span>
        </summary>
        <div className="bg-ink-2/30 border-t border-ink-2 px-3 py-2 space-y-1">
          <div className="text-[10px] tracking-[0.08em] uppercase text-bone-dim normal-case tracking-normal break-all select-all">
            {row.peer}
          </div>
          <ul className="text-[10px] text-bone-dim space-y-0.5 mt-1.5">
            {row.evidence.map((e, i) => (
              <li key={`${e.type}-${e.txid}-${i}`} className="flex items-baseline gap-2">
                <span className="uppercase tracking-[0.08em] w-16 shrink-0">
                  {e.type === 'cih' ? 'co-input' : 'transfer'}
                </span>
                <a
                  href={`https://mempool.space/tx/${e.txid}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-bone-dim hover:text-bone underline tabular-nums truncate"
                >
                  {truncateAddr(e.txid, 10, 6)}
                </a>
                {e.ts ? (
                  <span className="ml-auto text-bone-dim/70 tabular-nums shrink-0">
                    {formatRelative(e.ts)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </details>
    </li>
  );
}

function formatRelative(ts: number): string {
  const now = Math.floor(Date.now() / 1000);
  const dt = now - ts;
  if (dt < 0) return '';
  const days = Math.floor(dt / 86400);
  if (days < 1) return 'today';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = (days / 365).toFixed(1);
  return `${years}y ago`;
}
