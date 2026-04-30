'use client';

import React, { memo, useCallback } from 'react';
import Link from 'next/link';
import { ColorFilter } from '@/lib/types';
import { appendColorParam } from '@/lib/colorFilter';
import ColorSwatches from './ColorSwatches';
import HelpButton from './HelpButton';
import MobileMenu from './MobileMenu';

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
}: FilterControlsProps) {
  // The search input is rendered in two places (desktop row 1, mobile row 2)
  // and only one is visible at a time per breakpoint. A plain shared ref
  // gets overwritten by whichever element mounts last, which on desktop is
  // the hidden mobile input — so the `/` shortcut would focus a display:none
  // element. This callback only stores the visible one.
  const setSearchRef = useCallback(
    (el: HTMLInputElement | null) => {
      if (el && el.offsetParent !== null) {
        searchInputRef.current = el;
      }
    },
    [searchInputRef]
  );

  const filtersBlock = (
    <div className="flex items-center shrink-0">
      <ColorSwatches color={colorFilter} onChange={onColorFilterChange} />
      <button
        type="button"
        onClick={onToggleFavoritesOnly}
        className={`h-10 w-10 flex items-center justify-center text-lg leading-none transition-colors ${
          showFavoritesOnly ? 'text-accent-red' : 'text-bone-dim hover:text-bone'
        }`}
        aria-label={showFavoritesOnly ? 'Show all pieces' : 'Show favorites only'}
      >
        {showFavoritesOnly ? '♥' : '♡'}
      </button>
      {playHref ? (
        <Link
          href={playHref}
          className="h-10 px-2 flex items-center text-bone-dim hover:text-bone transition-colors"
          aria-label="Play slideshow of current filter"
        >
          <span className="border border-transparent px-1.5 py-0.5 text-[11px] tracking-[0.12em]">
            ▶ PLAY
          </span>
        </Link>
      ) : (
        <span
          className="h-10 px-2 flex items-center text-bone-dim opacity-30 cursor-not-allowed"
          aria-label="Play slideshow (no images selected)"
          aria-disabled="true"
          title="No images in the current filter"
        >
          <span className="border border-transparent px-1.5 py-0.5 text-[11px] tracking-[0.12em]">
            ▶ PLAY
          </span>
        </span>
      )}
    </div>
  );

  const searchInput = (
    <input
      ref={setSearchRef}
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
      {/* Row 1: hamburger (mobile) + wordmark + nav (desktop) + filters + desktop search/zoom/help */}
      <div className="flex items-center gap-3 sm:gap-6 px-3 sm:px-6 h-11 md:h-full">
        <MobileMenu active="gallery" />

        {/* Wordmark — desktop only */}
        <div className="hidden md:block text-bone shrink-0">OMB</div>
        {/* Nav — desktop only */}
        <nav className="hidden md:flex items-center gap-3 sm:gap-5 shrink-0">
          <span className="text-bone">
            <span className="border border-bone px-1.5 py-0.5">gallery</span>
          </span>
          <Link
            href={appendColorParam('/activity', colorFilter)}
            className="text-bone-dim hover:text-bone transition-colors"
          >
            <span className="border border-transparent px-1.5 py-0.5">activity</span>
          </Link>
          <Link
            href={appendColorParam('/explorer', colorFilter)}
            className="text-bone-dim hover:text-bone transition-colors"
          >
            <span className="border border-transparent px-1.5 py-0.5">explorer</span>
          </Link>
        </nav>

        {filtersBlock}

        {/* Desktop search + zoom + help */}
        <div className="hidden md:flex items-center gap-4 sm:gap-6 flex-1 min-w-0">
          <div className="flex-1 min-w-0">{searchInput}</div>
          {zoomCluster}
          <HelpButton />
        </div>
      </div>

      {/* Row 2 — mobile only: search + zoom */}
      <div className="md:hidden flex items-center gap-3 px-3 h-11 border-t border-ink-2">
        <div className="flex-1 min-w-0">{searchInput}</div>
        {zoomCluster}
      </div>
    </div>
  );
});

export default FilterControls;
