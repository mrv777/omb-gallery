'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { formatBtcCompact, formatRelTime } from '@/lib/format';
import type {
  MarketplaceListing,
  MarketplaceSort,
  MarketplaceStats,
} from '@/lib/marketplace/types';
import type { ColorFilter } from '@/lib/types';
import MarketplaceCard from './MarketplaceCard';
import MarketplaceFilters from './MarketplaceFilters';
import BuyDialog from './BuyDialog';
import PostPurchaseModal from './PostPurchaseModal';

type Props = {
  initialListings: MarketplaceListing[];
  initialStats: MarketplaceStats;
  discordInviteUrl: string;
  matricaSignupUrl: string;
};

const SORT_KEY = 'omb_market_sort';
const COLOR_KEY = 'omb_market_color_filter';

export default function MarketplaceGrid({
  initialListings,
  initialStats,
  discordInviteUrl,
  matricaSignupUrl,
}: Props) {
  const searchParams = useSearchParams();
  const [sort, setSort] = useState<MarketplaceSort>('price-asc');
  const [color, setColor] = useState<ColorFilter>('all');
  const [selected, setSelected] = useState<MarketplaceListing | null>(null);
  const [buyOpen, setBuyOpen] = useState(false);
  const [relativeNowMs, setRelativeNowMs] = useState<number | null>(null);
  const [receipt, setReceipt] = useState<{ listing: MarketplaceListing; txid: string } | null>(
    null
  );

  useEffect(() => {
    const storedSort = window.localStorage.getItem(SORT_KEY);
    if (storedSort === 'price-desc' || storedSort === 'recent' || storedSort === 'price-asc') {
      setSort(storedSort);
    }
    const storedColor = window.localStorage.getItem(COLOR_KEY);
    if (
      storedColor === 'all' ||
      storedColor === 'red' ||
      storedColor === 'blue' ||
      storedColor === 'green' ||
      storedColor === 'orange' ||
      storedColor === 'black'
    ) {
      setColor(storedColor);
    }
  }, []);

  const setSortPersisted = useCallback((next: MarketplaceSort) => {
    setSort(next);
    window.localStorage.setItem(SORT_KEY, next);
  }, []);

  const setColorPersisted = useCallback((next: ColorFilter) => {
    setColor(next);
    window.localStorage.setItem(COLOR_KEY, next);
  }, []);

  const focusNumber = useMemo(() => {
    const raw = searchParams.get('focus');
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }, [searchParams]);

  useEffect(() => {
    if (!focusNumber) return;
    const focused = initialListings.find(listing => listing.inscription_number === focusNumber);
    if (!focused) return;
    setSelected(focused);
    setBuyOpen(true);
    requestAnimationFrame(() => {
      document.getElementById(`listing-${focusNumber}`)?.scrollIntoView({
        block: 'center',
        inline: 'nearest',
      });
    });
  }, [focusNumber, initialListings]);

  useEffect(() => {
    const update = () => setRelativeNowMs(Date.now());
    update();
    const timer = window.setInterval(update, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const listings = useMemo(() => {
    const filtered =
      color === 'all'
        ? initialListings
        : initialListings.filter(listing => listing.color === color);
    return filtered.toSorted((a, b) => {
      if (sort === 'price-desc')
        return b.price_sats - a.price_sats || a.inscription_number - b.inscription_number;
      if (sort === 'recent')
        return b.listed_at - a.listed_at || a.inscription_number - b.inscription_number;
      return a.price_sats - b.price_sats || a.inscription_number - b.inscription_number;
    });
  }, [color, initialListings, sort]);

  const refreshedLabel = initialStats.refreshed_at
    ? relativeNowMs
      ? `refreshed ${formatRelTime(initialStats.refreshed_at, relativeNowMs)}`
      : 'refreshed recently'
    : 'refreshed --';

  return (
    <>
      <section className="px-3 sm:px-6">
        <div className="mx-auto max-w-7xl">
          <div className="flex flex-wrap items-end justify-between gap-4 pb-5 font-mono uppercase tracking-[0.08em]">
            <div>
              <h1 className="text-2xl text-bone sm:text-3xl">marketplace</h1>
            </div>
            <div className="grid grid-cols-3 border border-ink-2 text-center text-[10px]">
              <Stat label="floor" value={formatBtcCompact(initialStats.floor_sats) || '--'} />
              <Stat
                label="24h vol"
                value={formatBtcCompact(initialStats.volume_24h_sats) || '--'}
              />
              <Stat label="listed" value={initialStats.listed_count.toLocaleString()} />
            </div>
          </div>
        </div>
      </section>

      <MarketplaceFilters
        color={color}
        sort={sort}
        refreshedLabel={refreshedLabel}
        onColorChange={setColorPersisted}
        onSortChange={setSortPersisted}
      />

      <section className="px-3 py-5 sm:px-6">
        <div className="mx-auto grid max-w-7xl grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {listings.map(listing => (
            <MarketplaceCard
              key={listing.inscription_number}
              listing={listing}
              focused={listing.inscription_number === focusNumber}
              onBuy={next => {
                setSelected(next);
                setBuyOpen(true);
              }}
            />
          ))}
        </div>
        {listings.length === 0 && (
          <div className="mx-auto max-w-7xl border border-ink-2 py-12 text-center font-mono text-xs uppercase tracking-[0.08em] text-bone-dim">
            no listings match - try clearing filters
          </div>
        )}
      </section>

      <BuyDialog
        listing={selected}
        open={buyOpen}
        onClose={() => setBuyOpen(false)}
        onSuccess={({ listing, txid }) => setReceipt({ listing, txid })}
      />
      {receipt && (
        <PostPurchaseModal
          listing={receipt.listing}
          txid={receipt.txid}
          discordInviteUrl={discordInviteUrl}
          matricaSignupUrl={matricaSignupUrl}
          onClose={() => setReceipt(null)}
        />
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-20 border-r border-ink-2 px-3 py-2 last:border-r-0">
      <div className="text-bone tabular-nums">{value}</div>
      <div className="mt-1 text-bone-dim">{label}</div>
    </div>
  );
}
