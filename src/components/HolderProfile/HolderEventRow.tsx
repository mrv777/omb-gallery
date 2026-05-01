import Link from 'next/link';
import type { EventRow } from '@/lib/db';
import { lookupInscription } from '@/lib/inscriptionLookup';
import {
  formatBtc,
  formatRelTime,
  marketplaceLabel,
  memepoolTxLink,
  truncateAddr,
} from '@/lib/format';
import { Tooltip } from '../ui/Tooltip';

const COLOR_TILE_BG: Record<string, string> = {
  red: 'bg-accent-red/20',
  blue: 'bg-accent-blue/20',
  green: 'bg-accent-green/20',
  orange: 'bg-accent-orange/20',
  black: 'bg-accent-black/10',
};

export default function HolderEventRow({ event, wallets }: { event: EventRow; wallets: string[] }) {
  const hit = lookupInscription(event.inscription_number);
  const tileBg = hit?.color ? (COLOR_TILE_BG[hit.color] ?? 'bg-ink-2') : 'bg-ink-2';

  const isSold = event.event_type === 'sold';
  const isTransferred = event.event_type === 'transferred';
  const eventLabel = isSold ? 'SOLD' : isTransferred ? 'TRANSFERRED' : 'INSCRIBED';

  const oldIsSelf = event.old_owner != null && wallets.includes(event.old_owner);
  const newIsSelf = event.new_owner != null && wallets.includes(event.new_owner);
  const isOutgoing = oldIsSelf && !newIsSelf;
  const isIncoming = newIsSelf && !oldIsSelf;
  const isInternal = oldIsSelf && newIsSelf;
  const counterParty = isOutgoing ? event.new_owner : isIncoming ? event.old_owner : null;
  const directionLabel = isOutgoing
    ? 'sent →'
    : isIncoming
      ? '← received'
      : isInternal
        ? 'internal'
        : '';

  const transferredColor = isOutgoing
    ? 'text-accent-red'
    : isIncoming
      ? 'text-accent-green'
      : 'text-bone-dim';
  const transferredBg = isOutgoing
    ? 'bg-accent-red/10 border-accent-red/40'
    : isIncoming
      ? 'bg-accent-green/10 border-accent-green/40'
      : 'border-bone-dim/40';
  const eventColor = isSold
    ? 'text-accent-green'
    : isTransferred
      ? transferredColor
      : 'text-accent-orange';
  const eventBg = isSold
    ? 'bg-accent-green/10 border-accent-green/40'
    : isTransferred
      ? transferredBg
      : 'bg-accent-orange/10 border-accent-orange/40';

  const priceStr = isSold ? formatBtc(event.sale_price_sats) : '';
  const market = isSold ? marketplaceLabel(event.marketplace) : '';
  const txLink = memepoolTxLink(event.txid);
  const inscriptionLink = `/inscription/${event.inscription_number}`;

  return (
    <div
      className={`flex items-center gap-x-3 sm:gap-x-4 px-2 sm:px-4 py-2 border-b border-ink-2 ${
        isSold ? 'bg-accent-green/[0.03]' : ''
      }`}
    >
      <Tooltip content={`#${event.inscription_number}`}>
        <Link
          href={inscriptionLink}
          prefetch={false}
          className={`block w-12 h-12 ${tileBg} overflow-hidden border border-ink-2 hover:border-bone-dim shrink-0`}
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
      </Tooltip>

      <Link
        href={inscriptionLink}
        prefetch={false}
        className="font-mono text-xs text-bone tabular-nums hover:text-accent-orange w-20 shrink-0"
      >
        #{event.inscription_number}
      </Link>

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
          <span className="hidden sm:inline font-mono text-[10px] text-bone-dim tracking-normal whitespace-nowrap">
            via {market}
          </span>
        )}
      </div>

      <div className="hidden sm:flex items-center gap-1.5 font-mono text-[11px] text-bone-dim min-w-0">
        {directionLabel && (
          <span className="shrink-0 normal-case tracking-normal">{directionLabel}</span>
        )}
        {counterParty ? (
          <Tooltip content={counterParty}>
            <Link
              href={`/holder/${counterParty}`}
              prefetch={false}
              className="hover:text-accent-orange truncate normal-case tracking-normal"
            >
              {truncateAddr(counterParty)}
            </Link>
          </Tooltip>
        ) : null}
      </div>

      <div className="flex items-center gap-3 ml-auto shrink-0">
        {txLink && (
          <Tooltip content={`tx ${event.txid}`}>
            <a
              href={txLink}
              target="_blank"
              rel="noopener noreferrer"
              className="hidden sm:inline font-mono text-[10px] text-bone-dim hover:text-accent-orange tracking-[0.08em] uppercase"
            >
              tx
            </a>
          </Tooltip>
        )}
        <Tooltip content={new Date(event.block_timestamp * 1000).toISOString()}>
          <span className="font-mono text-[10px] text-bone-dim tracking-normal whitespace-nowrap">
            {formatRelTime(event.block_timestamp)}
          </span>
        </Tooltip>
      </div>
    </div>
  );
}
