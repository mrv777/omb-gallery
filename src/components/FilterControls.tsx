"use client";

import React, { memo } from 'react';
import { ColorFilter } from '@/lib/types';

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
}

type SwatchDef = { value: ColorFilter; label: string; cls: string };

const SWATCHES: SwatchDef[] = [
  { value: 'red', label: 'red', cls: 'bg-accent-red' },
  { value: 'blue', label: 'blue', cls: 'bg-accent-blue' },
  { value: 'green', label: 'green', cls: 'bg-accent-green' },
  { value: 'orange', label: 'orange', cls: 'bg-accent-orange' },
  { value: 'black', label: 'black', cls: 'bg-accent-black' },
];

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
}: FilterControlsProps) {
  return (
    <div className="flex h-full items-center gap-2 sm:gap-4 px-2 sm:px-4 font-mono text-xs tracking-[0.08em] uppercase">
      {/* Title / wordmark — desktop only */}
      <div className="hidden md:block text-bone shrink-0 pr-1">
        OMB <span className="text-bone-dim">/ archive</span>
      </div>

      {/* Color filters */}
      <div className="flex items-center shrink-0">
        <button
          type="button"
          onClick={() => onColorFilterChange('all')}
          className={`h-10 px-2.5 flex items-center text-[11px] tracking-[0.12em] transition-colors ${
            colorFilter === 'all'
              ? 'text-bone'
              : 'text-bone-dim hover:text-bone'
          }`}
          aria-label="Show all colors"
        >
          <span
            className={`border px-1.5 py-0.5 ${
              colorFilter === 'all' ? 'border-bone' : 'border-transparent'
            }`}
          >
            ALL
          </span>
        </button>
        {SWATCHES.map(({ value, label, cls }) => {
          const active = colorFilter === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => onColorFilterChange(value)}
              className="h-10 w-9 flex items-center justify-center group"
              aria-label={`Filter by ${label}`}
            >
              <span
                className={`block w-3.5 h-3.5 ${cls} transition-[outline] ${
                  active
                    ? 'outline outline-1 outline-offset-[3px] outline-bone'
                    : 'opacity-70 group-hover:opacity-100'
                }`}
              />
            </button>
          );
        })}
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
      </div>

      {/* Search — grows to fill */}
      <div className="flex-1 min-w-0">
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
      </div>

      {/* Zoom status (compact, functional) */}
      <div className="flex items-center shrink-0">
        <button
          type="button"
          onClick={onZoomOut}
          disabled={!canZoomOut}
          className={`h-10 w-8 flex items-center justify-center text-base leading-none transition-colors ${
            canZoomOut ? 'text-bone-dim hover:text-bone' : 'text-bone-dim opacity-30 cursor-not-allowed'
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
            canZoomIn ? 'text-bone-dim hover:text-bone' : 'text-bone-dim opacity-30 cursor-not-allowed'
          }`}
          aria-label="Zoom in (fewer columns)"
        >
          +
        </button>
      </div>
    </div>
  );
});

export default FilterControls;
