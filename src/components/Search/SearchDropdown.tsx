'use client';

import Link from 'next/link';
import SafeImg from '@/components/SafeImg';
import { lookupInscription } from '@/lib/inscriptionLookup';
import { looksLikeAddress, truncateAddr } from '@/lib/format';
import { lookupWalletLabel } from '@/lib/walletLabels';
import type { SearchResults } from '@/lib/searchTypes';

export type FlatRow = {
  key: string;
  href: string;
  /** True for rows that link to an off-site URL (open in new tab). */
  external?: boolean;
  render: () => React.ReactNode;
};

type Props = {
  q: string;
  results: SearchResults | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  rows: FlatRow[];
  focusedIndex: number;
  onHover: (index: number) => void;
  onClose: () => void;
};

export default function SearchDropdown({
  q,
  results,
  status,
  rows,
  focusedIndex,
  onHover,
  onClose,
}: Props) {
  const hasAnyResults =
    results &&
    (results.inscriptions.length ||
      results.holders.length ||
      results.users.length ||
      results.events.length);

  return (
    <div
      className="absolute left-0 right-0 sm:left-auto sm:right-auto sm:w-[28rem] mt-1 z-50 bg-ink-1 border border-ink-2 shadow-lg max-h-[70vh] overflow-y-auto"
      role="listbox"
      aria-label="Search results"
    >
      {status === 'loading' && !hasAnyResults && (
        <div className="px-3 py-3 font-mono text-[11px] text-bone-dim uppercase tracking-[0.08em]">
          searching…
        </div>
      )}
      {status === 'error' && (
        <div className="px-3 py-3 font-mono text-[11px] text-accent-red uppercase tracking-[0.08em]">
          search error — try again
        </div>
      )}
      {status === 'ready' && results && !hasAnyResults && (
        <div className="px-3 py-3 font-mono text-[11px] text-bone-dim uppercase tracking-[0.08em]">
          no matches
        </div>
      )}

      {results && hasAnyResults && (
        <RenderSections
          results={results}
          rows={rows}
          focusedIndex={focusedIndex}
          onHover={onHover}
          onClose={onClose}
        />
      )}

      {q && (
        <Link
          href={`/search?q=${encodeURIComponent(q)}`}
          prefetch={false}
          onClick={onClose}
          onMouseEnter={() => onHover(rows.length - 1)}
          className={`block px-3 py-2 border-t border-ink-2 font-mono text-[11px] uppercase tracking-[0.08em] ${
            focusedIndex === rows.length - 1
              ? 'bg-ink-2 text-bone'
              : 'text-bone-dim hover:text-bone hover:bg-ink-2'
          }`}
        >
          See all results for &ldquo;{q}&rdquo; →
        </Link>
      )}
    </div>
  );
}

function RenderSections({
  results,
  rows,
  focusedIndex,
  onHover,
  onClose,
}: {
  results: SearchResults;
  rows: FlatRow[];
  focusedIndex: number;
  onHover: (index: number) => void;
  onClose: () => void;
}) {
  // Map rows to indices by key for focus styling.
  const rowIndex: Record<string, number> = {};
  rows.forEach((r, i) => {
    rowIndex[r.key] = i;
  });

  return (
    <>
      {results.inscriptions.length > 0 && (
        <Section title="Inscriptions">
          {results.inscriptions.map(insc => {
            const key = `insc:${insc.collection_slug}:${insc.inscription_number}`;
            return (
              <RowLink
                key={key}
                rowKey={key}
                rowIndex={rowIndex}
                focusedIndex={focusedIndex}
                onHover={onHover}
                onClose={onClose}
                rows={rows}
              >
                <InscriptionRow item={insc} />
              </RowLink>
            );
          })}
        </Section>
      )}

      {results.holders.length > 0 && (
        <Section title="Holders">
          {results.holders.map(h => {
            const key = `holder:${h.address}`;
            return (
              <RowLink
                key={key}
                rowKey={key}
                rowIndex={rowIndex}
                focusedIndex={focusedIndex}
                onHover={onHover}
                onClose={onClose}
                rows={rows}
              >
                <HolderRow item={h} />
              </RowLink>
            );
          })}
        </Section>
      )}

      {results.users.length > 0 && (
        <Section title="Matrica users">
          {results.users.map(u => {
            const key = `user:${u.user_id}`;
            return (
              <RowLink
                key={key}
                rowKey={key}
                rowIndex={rowIndex}
                focusedIndex={focusedIndex}
                onHover={onHover}
                onClose={onClose}
                rows={rows}
              >
                <UserRow item={u} />
              </RowLink>
            );
          })}
        </Section>
      )}

      {results.events.length > 0 && (
        <Section title="Transactions">
          {results.events.map(e => {
            const key = `event:${e.id}`;
            return (
              <RowLink
                key={key}
                rowKey={key}
                rowIndex={rowIndex}
                focusedIndex={focusedIndex}
                onHover={onHover}
                onClose={onClose}
                rows={rows}
              >
                <EventRow item={e} />
              </RowLink>
            );
          })}
        </Section>
      )}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-ink-2">
      <div className="px-3 pt-2 pb-1 font-mono text-[10px] uppercase tracking-[0.12em] text-bone-dim">
        {title}
      </div>
      <ul>{children}</ul>
    </div>
  );
}

function RowLink({
  rowKey,
  rowIndex,
  focusedIndex,
  rows,
  onHover,
  onClose,
  children,
}: {
  rowKey: string;
  rowIndex: Record<string, number>;
  focusedIndex: number;
  rows: FlatRow[];
  onHover: (index: number) => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const i = rowIndex[rowKey];
  if (i == null) return null;
  const row = rows[i];
  const isFocused = focusedIndex === i;
  const cls = `block px-3 py-2 ${isFocused ? 'bg-ink-2' : 'hover:bg-ink-2'}`;
  if (row.external) {
    return (
      <li>
        <a
          href={row.href}
          target="_blank"
          rel="noopener noreferrer"
          onMouseEnter={() => onHover(i)}
          onClick={onClose}
          className={cls}
          role="option"
          aria-selected={isFocused}
        >
          {children}
        </a>
      </li>
    );
  }
  return (
    <li>
      <Link
        href={row.href}
        prefetch={false}
        onMouseEnter={() => onHover(i)}
        onClick={onClose}
        className={cls}
        role="option"
        aria-selected={isFocused}
      >
        {children}
      </Link>
    </li>
  );
}

function InscriptionRow({ item }: { item: SearchResults['inscriptions'][number] }) {
  const hit = lookupInscription(item.inscription_number);
  return (
    <div className="grid grid-cols-[2rem_1fr_auto] items-center gap-2.5">
      <span className="block w-8 h-8 bg-ink-2 overflow-hidden">
        {hit &&
          (hit.external ? (
            <SafeImg
              src={hit.thumbnail}
              alt=""
              loading="lazy"
              className="w-full h-full object-cover"
            />
          ) : (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={hit.thumbnail}
              alt=""
              loading="lazy"
              className="w-full h-full object-cover"
            />
          ))}
      </span>
      <span className="font-mono text-xs text-bone tabular-nums truncate">
        #{item.inscription_number}
        {item.color && (
          <span className="ml-1.5 text-[9px] uppercase tracking-[0.08em] text-bone-dim">
            {item.color}
          </span>
        )}
        {item.collection_slug && item.collection_slug !== 'omb' && (
          <span className="ml-1.5 text-[9px] uppercase tracking-[0.08em] text-accent-orange">
            {item.collection_slug}
          </span>
        )}
      </span>
      <span className="font-mono text-[10px] text-bone-dim tracking-[0.04em]">
        {item.current_owner ? truncateAddr(item.current_owner, 4, 4) : ''}
      </span>
    </div>
  );
}

function HolderRow({ item }: { item: SearchResults['holders'][number] }) {
  const manual = lookupWalletLabel(item.address);
  const display = manual ? manual.name : truncateAddr(item.address, 8, 6);
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-2.5">
      <span className="font-mono text-xs text-bone truncate">
        {manual ? <span className="text-accent-orange">{display}</span> : display}
      </span>
      <span className="font-mono text-[10px] text-bone-dim tabular-nums whitespace-nowrap">
        {item.inscription_count} held
      </span>
    </div>
  );
}

function UserRow({ item }: { item: SearchResults['users'][number] }) {
  const showsName = item.username && !looksLikeAddress(item.username);
  return (
    <div className="grid grid-cols-[1.25rem_1fr_auto] items-center gap-2.5">
      <span className="block w-5 h-5 bg-ink-2 overflow-hidden rounded-sm">
        <SafeImg src={item.avatar_url} alt="" loading="lazy" className="w-full h-full object-cover" />
      </span>
      <span className="font-mono text-xs text-bone truncate">
        {showsName ? `@${item.username}` : truncateAddr(item.first_wallet ?? '', 6, 4)}
      </span>
      <span className="font-mono text-[10px] text-bone-dim tabular-nums whitespace-nowrap">
        {item.wallet_count} {item.wallet_count === 1 ? 'wallet' : 'wallets'}
      </span>
    </div>
  );
}

function EventRow({ item }: { item: SearchResults['events'][number] }) {
  const label =
    item.event_type === 'sold'
      ? 'Sold'
      : item.event_type === 'transferred'
        ? 'Transfer'
        : item.event_type === 'inscribed'
          ? 'Inscribed'
          : 'Listed';
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-2.5">
      <span className="font-mono text-xs text-bone truncate">
        #{item.inscription_number}
        <span className="ml-1.5 text-[9px] uppercase tracking-[0.08em] text-bone-dim">{label}</span>
      </span>
      <span className="font-mono text-[10px] text-bone-dim tracking-[0.04em] truncate max-w-[10ch]">
        {item.txid.slice(0, 8)}…
      </span>
    </div>
  );
}
