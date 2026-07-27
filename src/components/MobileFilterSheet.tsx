'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { createPortal } from 'react-dom';
import { ColorFilter } from '@/lib/types';
import type { Series } from '@/lib/series';
import ColorSwatches from './ColorSwatches';
import SeriesChips from './SeriesChips';
import NotificationButton, { BellIcon } from './NotificationButton/NotificationButton';

/**
 * Every gallery filter, in a bottom sheet, below `sm`.
 *
 * The toolbar's second row costs a permanent 44px on a 390x844 phone — 5% of
 * the viewport, on a page whose entire job is showing art — and the cluster
 * only fits that width after compacting every label down to a glyph. Behind a
 * single trigger it costs nothing until asked for, the labels come back, and
 * the series chips can wrap instead of scrolling sideways.
 *
 * Bottom-anchored, unlike MobileMenu's top sheet: this one is reached
 * repeatedly while browsing, so it belongs in the thumb arc. MobileMenu is a
 * navigation away from the page and is opened once.
 *
 * The trigger is NOT silent about state — a filter that hides 8,900 pieces must
 * never be invisible, which is the same rule the inline row followed. It counts
 * active filters and shows the count, so the closed state still says "something
 * is on" without the row.
 */

type Props = {
  colorFilter: ColorFilter;
  onColorFilterChange: (filter: ColorFilter) => void;
  showFavoritesOnly: boolean;
  onToggleFavoritesOnly: () => void;
  activeSeries: Series | null;
  onSeriesChange: (slug: string | null) => void;
  columnCount: number;
  maxColumnCount: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  canZoomIn: boolean;
  canZoomOut: boolean;
  playHref: string | null;
};

const SECTION = 'text-[10px] tracking-[0.16em] text-bone-dim';

export default function MobileFilterSheet({
  colorFilter,
  onColorFilterChange,
  showFavoritesOnly,
  onToggleFavoritesOnly,
  activeSeries,
  onSeriesChange,
  columnCount,
  maxColumnCount,
  onZoomIn,
  onZoomOut,
  canZoomIn,
  canZoomOut,
  playHref,
}: Props) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Focus lands inside the sheet so Escape and tabbing behave, and so a screen
  // reader is told where it just went.
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  // Zoom is here rather than in the header row on phones: pinch already works
  // on touch, so the buttons are the discoverable fallback, not the primary
  // control — and moving them gives the search field back ~110px.
  const isSingleColor = colorFilter !== 'all';
  const activeCount =
    (isSingleColor ? 1 : 0) + (showFavoritesOnly ? 1 : 0) + (activeSeries ? 1 : 0);

  const sheet = open ? (
    <div className="fixed inset-0 z-[1400] sm:hidden" role="presentation">
      <button
        type="button"
        onClick={close}
        aria-label="Close filters"
        className="absolute inset-0 h-full w-full cursor-default bg-ink-0/70 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Filters"
        className="absolute inset-x-0 bottom-0 max-h-[80dvh] overflow-y-auto border-t border-ink-2 bg-ink-1 pb-[env(safe-area-inset-bottom)] font-mono text-xs uppercase tracking-[0.08em]"
      >
        <div className="flex h-12 items-center justify-between border-b border-ink-2 px-5">
          <span className="text-[11px] tracking-[0.16em] text-bone">⌗ filter</span>
          <button
            ref={closeRef}
            type="button"
            onClick={close}
            aria-label="Close filters"
            className="-mr-2 flex h-10 w-10 items-center justify-center text-lg leading-none text-bone-dim transition-colors hover:text-bone"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        <section className="border-b border-ink-2 px-5 py-3">
          <div className="mb-1 flex items-center justify-between">
            <span className={SECTION}>color</span>
            {/* Only meaningful for one colour — a firehose subscription is a
                different control, and lives in the footer. */}
            {isSingleColor && (
              <NotificationButton
                kind="color"
                targetKey={colorFilter}
                label={
                  <span className="flex items-center gap-1.5 text-[10px] tracking-[0.12em]">
                    <BellIcon /> alert me
                  </span>
                }
                className="flex h-8 items-center text-bone-dim transition-colors hover:text-bone"
              />
            )}
          </div>
          <ColorSwatches color={colorFilter} onChange={onColorFilterChange} />
        </section>

        <section className="border-b border-ink-2 px-5 py-3">
          <span className={`${SECTION} mb-2 block`}>series</span>
          {/* Wrapped, not scrolled: there is room here, and a horizontal
              scroller inside a vertical scroller is a bad gesture conflict. */}
          <SeriesChips active={activeSeries} onChange={onSeriesChange} layout="wrap" />
        </section>

        <section className="border-b border-ink-2 px-5 py-1">
          <button
            type="button"
            onClick={onToggleFavoritesOnly}
            aria-pressed={showFavoritesOnly}
            className="flex h-11 w-full items-center justify-between text-bone-dim transition-colors hover:text-bone"
          >
            <span className={showFavoritesOnly ? 'text-bone' : ''}>favorites only</span>
            <span
              aria-hidden="true"
              className={`text-lg leading-none ${showFavoritesOnly ? 'text-accent-red' : ''}`}
            >
              {showFavoritesOnly ? '♥' : '♡'}
            </span>
          </button>
        </section>

        <section className="flex h-14 items-center justify-between border-b border-ink-2 px-5">
          <span className={SECTION}>columns</span>
          <span className="flex items-center gap-1">
            <button
              type="button"
              onClick={onZoomOut}
              disabled={!canZoomOut}
              aria-label="Zoom out (more columns)"
              className={`flex h-10 w-10 items-center justify-center border border-ink-2 text-base leading-none transition-colors ${
                canZoomOut ? 'text-bone-dim hover:text-bone' : 'cursor-not-allowed opacity-30'
              }`}
            >
              −
            </button>
            <span className="w-14 text-center text-xs tabular-nums text-bone">
              {String(columnCount).padStart(2, '0')}/{maxColumnCount}
            </span>
            <button
              type="button"
              onClick={onZoomIn}
              disabled={!canZoomIn}
              aria-label="Zoom in (fewer columns)"
              className={`flex h-10 w-10 items-center justify-center border border-ink-2 text-base leading-none transition-colors ${
                canZoomIn ? 'text-bone-dim hover:text-bone' : 'cursor-not-allowed opacity-30'
              }`}
            >
              +
            </button>
          </span>
        </section>

        <div className="px-5 py-4">
          {playHref ? (
            <Link
              href={playHref}
              onClick={() => setOpen(false)}
              className="flex h-11 items-center justify-center border border-bone text-[11px] tracking-[0.16em] text-bone transition-colors hover:bg-bone hover:text-ink-0"
            >
              ▶ play slideshow
            </Link>
          ) : (
            <span
              aria-disabled="true"
              className="flex h-11 cursor-not-allowed items-center justify-center border border-ink-2 text-[11px] tracking-[0.16em] text-bone-dim opacity-40"
            >
              ▶ nothing to play
            </span>
          )}
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={activeCount > 0 ? `Filters (${activeCount} active)` : 'Filters'}
        className={`flex h-10 shrink-0 items-center px-1.5 transition-colors sm:hidden ${
          activeCount > 0 ? 'text-bone' : 'text-bone-dim hover:text-bone'
        }`}
      >
        <span
          className={`flex items-center gap-1 border px-1.5 py-0.5 text-[11px] tracking-[0.12em] ${
            activeCount > 0 ? 'border-bone' : 'border-transparent'
          }`}
        >
          ⌗ filter
          {activeCount > 0 && (
            <span aria-hidden="true" className="text-accent-red">
              {activeCount}
            </span>
          )}
        </span>
      </button>

      {mounted && sheet ? createPortal(sheet, document.body) : null}
    </>
  );
}
