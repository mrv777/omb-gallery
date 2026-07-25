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
};

const SeriesChips = memo(function SeriesChips({ active, onChange }: Props) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto">
      <span className="shrink-0 text-bone-dim text-[10px] pr-1">series</span>
      {SERIES.map(s => {
        const isActive = active?.id === s.id;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onChange(isActive ? null : s.slug)}
            aria-pressed={isActive}
            className={`shrink-0 border px-2 py-0.5 text-[10px] tracking-[0.08em] transition-colors ${
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
