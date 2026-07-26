'use client';

import React, { memo } from 'react';
import Link from 'next/link';
import { ColorFilter } from '@/lib/types';
import type { Series } from '@/lib/series';
import ColorSwatches from './ColorSwatches';
import SeriesChips from './SeriesChips';
import HelpButton from './HelpButton';
import MobileMenu from './MobileMenu';
import DesktopNav from './DesktopNav';
import NotificationButton, { BellIcon } from './NotificationButton/NotificationButton';
import { Tooltip } from './ui/Tooltip';

interface FilterControlsProps {
  colorFilter: ColorFilter;
  onColorFilterChange: (filter: ColorFilter) => void;
  searchQuery: string;
  onSearchChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  columnCount: number;
  maxColumnCount: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  canZoomIn: boolean;
  canZoomOut: boolean;
  showFavoritesOnly: boolean;
  onToggleFavoritesOnly: () => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  playHref: string | null;
  /** Curated sub-series filter (`?series=`), or null when unfiltered. */
  activeSeries: Series | null;
  onSeriesChange: (slug: string | null) => void;
  /** Whether the series chip row is expanded. Owned by the grid, which also
   *  owns the header height the row has to grow into. */
  seriesRowOpen: boolean;
  onToggleSeriesRow: () => void;
}

const FilterControls = memo(function FilterControls({
  colorFilter,
  onColorFilterChange,
  searchQuery,
  onSearchChange,
  columnCount,
  maxColumnCount,
  onZoomIn,
  onZoomOut,
  canZoomIn,
  canZoomOut,
  showFavoritesOnly,
  onToggleFavoritesOnly,
  searchInputRef,
  playHref,
  activeSeries,
  onSeriesChange,
  seriesRowOpen,
  onToggleSeriesRow,
}: FilterControlsProps) {
  const isSingleColor = colorFilter !== 'all';
  const filtersBlock = (
    <div className="flex items-center shrink-0">
      <ColorSwatches color={colorFilter} onChange={onColorFilterChange} hideAllOnMobile />
      {isSingleColor && (
        <NotificationButton
          kind="color"
          targetKey={colorFilter}
          label={<BellIcon />}
          className="h-10 w-8 sm:w-10 flex items-center justify-center text-bone-dim hover:text-bone transition-colors"
        />
      )}
      <button
        type="button"
        onClick={onToggleFavoritesOnly}
        className={`h-10 w-8 sm:w-10 flex items-center justify-center text-lg leading-none transition-colors ${
          showFavoritesOnly ? 'text-accent-red' : 'text-bone-dim hover:text-bone'
        }`}
        aria-label={showFavoritesOnly ? 'Show all pieces' : 'Show favorites only'}
      >
        {showFavoritesOnly ? '♥' : '♡'}
      </button>
      <button
        type="button"
        onClick={onToggleSeriesRow}
        aria-pressed={seriesRowOpen}
        aria-label={seriesRowOpen ? 'Hide series filters' : 'Show series filters'}
        className={`h-10 px-1.5 sm:px-2 flex items-center shrink-0 transition-colors ${
          seriesRowOpen ? 'text-bone' : 'text-bone-dim hover:text-bone'
        }`}
      >
        <span className="border border-transparent px-1.5 py-0.5 text-[11px] tracking-[0.12em]">
          ⌗
          {/* With a series active the chip at the end of this row already names
              it, so on a phone the word is 56px spent saying it twice. */}
          <span className={activeSeries ? 'hidden sm:inline' : ''}> SERIES</span>
        </span>
      </button>
      {/* Glyph-only below `sm`. ▶ is self-explanatory in a row that already
          speaks in glyphs (♡, ⌗), and dropping the word is part of what lets
          the whole cluster clear a 390px phone. ⌗ SERIES keeps its label when
          nothing is selected — the glyph alone says nothing. */}
      {playHref ? (
        <Link
          href={playHref}
          className="h-10 px-1.5 sm:px-2 flex items-center shrink-0 text-bone-dim hover:text-bone transition-colors"
          aria-label="Play slideshow of current filter"
        >
          <span className="border border-transparent px-1.5 py-0.5 text-[11px] tracking-[0.12em]">
            ▶<span className="hidden sm:inline"> PLAY</span>
          </span>
        </Link>
      ) : (
        <Tooltip content="No images in the current filter">
          <span
            className="h-10 px-1.5 sm:px-2 flex items-center shrink-0 text-bone-dim opacity-30 cursor-not-allowed"
            aria-label="Play slideshow (no images selected)"
            aria-disabled="true"
          >
            <span className="border border-transparent px-1.5 py-0.5 text-[11px] tracking-[0.12em]">
              ▶<span className="hidden sm:inline"> PLAY</span>
            </span>
          </span>
        </Tooltip>
      )}
      {/* Always rendered when a series filter is on, even with the chip row
          collapsed — a filter that hides 8,900 pieces must never be silent.
          Last in the row on purpose: it is the widest item and the only one
          whose width is arbitrary (the label is prose), so if anything has to
          run past the right edge of a phone it should be this rather than a
          control. Its "×" — the part that actually clears — stays on screen
          either way, and the label truncates before it gets there. */}
      {activeSeries && (
        <button
          type="button"
          onClick={() => onSeriesChange(null)}
          className="h-10 flex items-center shrink-0 pl-1 text-bone hover:text-accent-red transition-colors"
          aria-label={`Clear the ${activeSeries.label} filter`}
        >
          <span className="flex items-center gap-1 border border-bone px-1.5 py-0.5 text-[10px] tracking-[0.08em] whitespace-nowrap">
            ×<span className="max-w-[7rem] truncate sm:max-w-none">{activeSeries.label}</span>
            {activeSeries.members.length}
          </span>
        </button>
      )}
    </div>
  );

  const searchInput = (
    <input
      ref={searchInputRef}
      type="search"
      value={searchQuery}
      onChange={onSearchChange}
      placeholder="/  search inscription # or keyword"
      className="w-full bg-transparent border-0 border-b border-ink-2 focus:border-bone outline-none h-10 px-0 text-sm font-mono tracking-[0.06em] text-bone placeholder:text-bone-dim placeholder:normal-case placeholder:tracking-[0.04em] transition-colors"
      spellCheck={false}
      autoComplete="off"
    />
  );

  const zoomCluster = (
    <div className="flex items-center shrink-0">
      <button
        type="button"
        onClick={onZoomOut}
        disabled={!canZoomOut}
        className={`h-10 w-8 flex items-center justify-center text-base leading-none transition-colors ${
          canZoomOut
            ? 'text-bone-dim hover:text-bone'
            : 'text-bone-dim opacity-30 cursor-not-allowed'
        }`}
        aria-label="Zoom out (more columns)"
      >
        −
      </button>
      <span className="text-bone tabular-nums w-12 text-center text-xs">
        {String(columnCount).padStart(2, '0')}/{maxColumnCount}
      </span>
      <button
        type="button"
        onClick={onZoomIn}
        disabled={!canZoomIn}
        className={`h-10 w-8 flex items-center justify-center text-base leading-none transition-colors ${
          canZoomIn
            ? 'text-bone-dim hover:text-bone'
            : 'text-bone-dim opacity-30 cursor-not-allowed'
        }`}
        aria-label="Zoom in (fewer columns)"
      >
        +
      </button>
    </div>
  );

  return (
    <div className="h-full flex flex-col font-mono text-xs tracking-[0.08em] uppercase">
      {/* Row 1 — navigation + search + zoom. Search is the only flexible item
          here, and the fixed furniture beside it is now just nav + zoom + help,
          so it can no longer be squeezed to nothing the way it was when the
          colour/series/play cluster shared this row (0px wide at ~1060px). */}
      <div className="flex items-center gap-3 sm:gap-6 px-3 sm:px-6 h-11">
        <MobileMenu active="gallery" />
        <DesktopNav active="gallery" color={colorFilter} />
        <div className="flex-1 min-w-0">{searchInput}</div>
        {zoomCluster}
        {/* Below `nav-full` the hamburger sheet carries its own help item, so showing
            this one too would duplicate it. */}
        <div className="hidden nav-full:block">
          <HelpButton />
        </div>
      </div>

      {/* Row 2 — the filters, on their own row at every width. Mobile already
          worked this way; making it universal means one layout to reason about
          and one search input instead of two breakpoint-swapped copies.
          The cluster now fits ~370px (no ALL pill, narrower glyph buttons, ▶
          without its label), so the scroll below is a backstop for the one case
          that still can't fit — an active series chip, whose label is arbitrary
          length. Scrollbar hidden: a native bar inside a 44px toolbar row reads
          as breakage, and it was showing on every phone before the cluster was
          compacted. */}
      <div
        className={`flex items-center px-3 sm:px-6 h-11 border-t border-ink-2 overflow-x-auto no-scrollbar ${
          // Faded only in the state that can still overflow a narrow phone.
          // Unconditional, it would dim ▶ on every screen that fits fine.
          activeSeries ? 'edge-fade-x sm:[mask-image:none]' : ''
        }`}
      >
        {filtersBlock}
      </div>

      {/* Row 3 — the curated sub-series, collapsed by default. The toolbar is
          already two rows on mobile; this only costs height when asked for. */}
      {seriesRowOpen && (
        <div className="flex items-center px-3 sm:px-6 h-10 border-t border-ink-2">
          <SeriesChips active={activeSeries} onChange={onSeriesChange} />
        </div>
      )}
    </div>
  );
});

export default FilterControls;
