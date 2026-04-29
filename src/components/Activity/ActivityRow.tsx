'use client';

import { memo } from 'react';
import Link from 'next/link';
import type { ApiEvent, ApiMatricaMap } from './types';
import { lookupInscription } from '@/lib/inscriptionLookup';
import {
  formatBtc,
  formatRelTime,
  marketplaceLabel,
  memepoolTxLink,
  truncateAddr,
} from '@/lib/format';

const COLOR_TILE_BG: Record<string, string> = {
  red: 'bg-accent-red/20',
  blue: 'bg-accent-blue/20',
  green: 'bg-accent-green/20',
  orange: 'bg-accent-orange/20',
  black: 'bg-accent-black/10',
};

type Props = {
  event: ApiEvent;
  /** True when the row immediately above shares this inscription_number — visually fade the thumbnail to read as a thread. */
  groupedWithPrev: boolean;
  /** Wallet → Matrica username/avatar overlay. Empty {} when no overlays apply. */
  matrica: ApiMatricaMap;
};

const ActivityRow = memo(function ActivityRow({ event, groupedWithPrev, matrica }: Props) {
  const hit = lookupInscription(event.inscription_number);
  const inscriptionLink = `/inscription/${event.inscription_number}`;
  const tileBg = hit && hit.color ? (COLOR_TILE_BG[hit.color] ?? 'bg-ink-2') : 'bg-ink-2';

  const isSold = event.event_type === 'sold';
  const isTransferred = event.event_type === 'transferred';
  const eventLabel = isSold ? 'SOLD' : isTransferred ? 'TRANSFERRED' : 'INSCRIBED';
  const eventColor = isSold
    ? 'text-accent-green'
    : isTransferred
      ? 'text-bone-dim'
      : 'text-accent-orange';
  const eventBg = isSold
    ? 'bg-accent-green/10 border-accent-green/40'
    : isTransferred
      ? 'border-bone-dim/40'
      : 'bg-accent-orange/10 border-accent-orange/40';

  const priceStr = isSold ? formatBtc(event.sale_price_sats) : '';
  const market = isSold ? marketplaceLabel(event.marketplace) : '';
  const txLink = memepoolTxLink(event.txid);

  return (
    <div
      className={`flex items-center gap-x-3 sm:gap-x-4 px-2 sm:px-4 py-2 border-b border-ink-2 hover:bg-ink-1/60 transition-colors ${
        isSold ? 'bg-accent-green/[0.03]' : ''
      } ${groupedWithPrev ? '' : 'border-t border-t-bone-dim/20'}`}
    >
      {/* Thumbnail (faded if same inscription as previous row) */}
      <Link
        href={inscriptionLink}
        prefetch={false}
        className={`block w-12 h-12 ${tileBg} overflow-hidden border border-ink-2 hover:border-bone-dim transition-opacity ${
          groupedWithPrev ? 'opacity-25 hover:opacity-100' : ''
        }`}
        title={`#${event.inscription_number}`}
      >
        {hit ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={hit.thumbnail}
            alt={`#${event.inscription_number}`}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center font-mono text-[9px] text-bone-dim">
            #{event.inscription_number}
          </div>
        )}
      </Link>

      {/* Inscription number — fixed width so columns line up */}
      <Link
        href={inscriptionLink}
        prefetch={false}
        className="font-mono text-xs text-bone tabular-nums hover:text-accent-orange w-20 shrink-0"
      >
        #{event.inscription_number}
      </Link>

      {/* Event type pill + price */}
      <div className="flex items-center gap-2 shrink-0">
        <span
          className={`font-mono text-[10px] tracking-[0.12em] uppercase px-1.5 py-0.5 border ${eventBg} ${eventColor} whitespace-nowrap`}
        >
          {eventLabel}
        </span>
        {priceStr && (
          <span className="font-mono text-xs text-accent-green tabular-nums whitespace-nowrap">
            {priceStr}
          </span>
        )}
        {market && (
          <span className="hidden sm:inline font-mono text-[10px] text-bone-dim tracking-normal whitespace-nowrap truncate">
            via {market}
          </span>
        )}
      </div>

      {/* Owners */}
      <div className="hidden sm:flex items-center gap-1.5 font-mono text-[11px] text-bone-dim min-w-0">
        <OwnerLink addr={event.old_owner} matrica={matrica} />
        <span className="text-bone-dim/60 shrink-0">→</span>
        <OwnerLink addr={event.new_owner} matrica={matrica} />
      </div>

      {/* Right rail: time + tx link */}
      <div className="flex items-center gap-3 ml-auto shrink-0">
        {txLink && (
          <a
            href={txLink}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:inline font-mono text-[10px] text-bone-dim hover:text-accent-orange tracking-[0.08em] uppercase"
            title={`tx ${event.txid}`}
          >
            tx
          </a>
        )}
        <span
          className="font-mono text-[10px] text-bone-dim tracking-normal whitespace-nowrap"
          title={new Date(event.block_timestamp * 1000).toISOString()}
        >
          {formatRelTime(event.block_timestamp)}
        </span>
      </div>
    </div>
  );
});

export default ActivityRow;

/** Renders an address slot in the activity feed: links to /holder/[addr],
 * shows the Matrica `@username` when the address has a non-default profile,
 * and falls back to the truncated address otherwise. The username is shown
 * verbatim (no `@` prefix) since Matrica usernames aren't necessarily Twitter
 * handles — but the visual treatment differs from a raw address so it reads
 * as an identity. */
function OwnerLink({
  addr,
  matrica,
}: {
  addr: string | null;
  matrica: ApiMatricaMap;
}) {
  if (!addr) return <span>—</span>;
  const profile = matrica[addr];
  const username = profile?.username && !looksLikeAddress(profile.username) ? profile.username : null;
  return (
    <Link
      href={`/holder/${addr}`}
      prefetch={false}
      className="hover:text-accent-orange truncate"
      title={addr}
    >
      {username ? (
        <span className="text-bone normal-case tracking-normal">{username}</span>
      ) : (
        truncateAddr(addr)
      )}
    </Link>
  );
}

function looksLikeAddress(s: string): boolean {
  return /^bc1[a-z0-9]{30,}$/i.test(s) || /^0x[a-f0-9]{40}$/i.test(s) || s.length > 30;
}
