'use client';

import Link from 'next/link';
import { formatBtcCompact } from '@/lib/format';
import type { MarketplaceListing } from '@/lib/marketplace/types';
import MarketplacePip from './MarketplacePip';

type Props = {
  listing: MarketplaceListing;
  focused?: boolean;
  onBuy: (listing: MarketplaceListing) => void;
};

export default function MarketplaceCard({ listing, focused, onBuy }: Props) {
  return (
    <article
      id={`listing-${listing.inscription_number}`}
      className={`group relative border bg-ink-0 transition-colors ${
        focused ? 'border-bone' : 'border-ink-2 hover:border-bone-dim/70'
      }`}
    >
      <button
        type="button"
        onClick={() => onBuy(listing)}
        className="absolute inset-0 z-10 text-left focus-visible:outline focus-visible:outline-1 focus-visible:outline-bone"
        aria-label={`Buy OMB #${listing.inscription_number}`}
      />
      <div className="relative aspect-square bg-ink-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={listing.thumbnail}
          alt={`OMB #${listing.inscription_number}`}
          className="h-full w-full object-cover"
          loading="lazy"
        />
        <div className="absolute bottom-2 left-2 flex gap-1">
          {listing.options.map(option => (
            <MarketplacePip
              key={`${option.marketplace}:${option.listing_id}`}
              marketplace={option.marketplace}
            />
          ))}
        </div>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 border-t border-ink-2 px-2 py-2 font-mono uppercase tracking-[0.08em]">
        <Link
          href={`/inscription/${listing.inscription_number}`}
          className="relative z-20 min-w-0 truncate text-[11px] text-bone hover:text-accent-orange"
        >
          #{listing.inscription_number}
        </Link>
        <div className="shrink-0 text-[11px] text-bone tabular-nums">
          {formatBtcCompact(listing.price_sats)}
        </div>
      </div>
    </article>
  );
}
