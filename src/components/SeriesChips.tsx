'use client';

import { memo } from 'react';
import { SERIES, type Series } from '@/lib/series';

/**
 * Horizontally-scrollable row of the curated sub-series, opened by the ⌗ TRAITS
 * toggle in the gallery toolbar.
 *
 * SERIES ONLY — deliberately no sat-provenance chips. "Block 9" would select
 * 8,799 of 9,001 pieces and "own sat" is just the red swatch by another name,
 * so both would be noise in a filter bar that already has color swatches. Sat
 * provenance is a per-piece fact and a collection-level story; it lives on the
 * inscription page and /history, not here.
 */
type Props = {
  active: Series | null;
  onChange: (slug: string | null) => void;
  /**
   * `row` is the toolbar's single scrolling line. `wrap` is for containers with
   * vertical room (the mobile filter sheet) — chips wrap and the "series"
   * caption is dropped, because the section heading above already says it and a
   * horizontal scroller nested in a vertical one is a gesture conflict.
   */
  layout?: 'row' | 'wrap';
};

const SeriesChips = memo(function SeriesChips({ active, onChange, layout = 'row' }: Props) {
  const wrap = layout === 'wrap';
  return (
    // In `row`, this genuinely can't fit on a phone — chip labels are prose. Hide
    // the scrollbar (it renders as a bright hairline under a 40px row) and fade
    // the right edge instead, so "there is more" survives losing the bar.
    <div
      className={
        wrap
          ? 'flex w-full flex-wrap items-center gap-2'
          : 'flex w-full items-center gap-2 overflow-x-auto no-scrollbar edge-fade-x'
      }
    >
      {!wrap && <span className="shrink-0 text-bone-dim text-[10px] pr-1">series</span>}
      {SERIES.map(s => {
        const isActive = active?.id === s.id;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onChange(isActive ? null : s.slug)}
            aria-pressed={isActive}
            className={`shrink-0 border text-[10px] tracking-[0.08em] transition-colors ${
              // Roomier in the sheet: these are the primary tap targets there,
              // not a dense secondary row under a toolbar.
              wrap ? 'px-3 py-2' : 'px-2 py-0.5'
            } ${
              isActive
                ? 'border-bone text-bone'
                : 'border-ink-2 text-bone-dim hover:border-bone-dim hover:text-bone'
            }`}
            title={s.blurb}
          >
            {s.label} <span className="opacity-60">{s.members.length}</span>
          </button>
        );
      })}
    </div>
  );
});

export default SeriesChips;
