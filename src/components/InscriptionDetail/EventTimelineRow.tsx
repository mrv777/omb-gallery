import Link from 'next/link';
import {
  formatBtc,
  formatRelTime,
  marketplaceLabel,
  mempoolTxLink,
  truncateAddr,
} from '@/lib/format';
import type { EventRow } from '@/lib/db';

type Props = { event: EventRow };

export default function EventTimelineRow({ event }: Props) {
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
  const txLink = mempoolTxLink(event.txid);

  return (
    <div
      className={`flex items-center gap-x-3 sm:gap-x-4 px-3 sm:px-4 py-2.5 border-b border-ink-2 ${
        isSold ? 'bg-accent-green/[0.03]' : ''
      }`}
    >
      <span
        className={`font-mono text-[10px] tracking-[0.12em] uppercase px-1.5 py-0.5 border ${eventBg} ${eventColor} whitespace-nowrap shrink-0`}
      >
        {eventLabel}
      </span>
      {priceStr && (
        <span className="font-mono text-xs text-accent-green tabular-nums whitespace-nowrap shrink-0">
          {priceStr}
        </span>
      )}
      {market && (
        <span className="hidden sm:inline font-mono text-[10px] text-bone-dim tracking-normal whitespace-nowrap shrink-0">
          via {market}
        </span>
      )}

      <div className="hidden sm:flex items-center gap-1.5 font-mono text-[11px] text-bone-dim min-w-0 shrink-0">
        {event.old_owner ? (
          <Link
            href={`/holder/${event.old_owner}`}
            prefetch={false}
            className="hover:text-accent-orange truncate"
            title={event.old_owner}
          >
            {truncateAddr(event.old_owner)}
          </Link>
        ) : (
          <span>—</span>
        )}
        <span className="text-bone-dim/60 shrink-0">→</span>
        {event.new_owner ? (
          <Link
            href={`/holder/${event.new_owner}`}
            prefetch={false}
            className="hover:text-accent-orange truncate"
            title={event.new_owner}
          >
            {truncateAddr(event.new_owner)}
          </Link>
        ) : (
          <span>—</span>
        )}
      </div>

      <div className="flex items-center gap-3 ml-auto shrink-0 font-mono text-[10px] text-bone-dim tracking-normal">
        {event.block_height != null && (
          <span className="hidden md:inline tabular-nums" title="block height">
            #{event.block_height.toLocaleString()}
          </span>
        )}
        {txLink && (
          <a
            href={txLink}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-accent-orange tracking-[0.08em] uppercase"
            title={`tx ${event.txid}`}
          >
            tx
          </a>
        )}
        <span
          className="whitespace-nowrap"
          title={new Date(event.block_timestamp * 1000).toISOString()}
        >
          {formatRelTime(event.block_timestamp)}
        </span>
      </div>
    </div>
  );
}
