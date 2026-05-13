'use client';

import ColorSwatches from '@/components/ColorSwatches';
import type { MarketplaceSort } from '@/lib/marketplace/types';
import type { ColorFilter } from '@/lib/types';

type Props = {
  color: ColorFilter;
  sort: MarketplaceSort;
  refreshedLabel: string;
  onColorChange: (color: ColorFilter) => void;
  onSortChange: (sort: MarketplaceSort) => void;
};

const SORTS: Array<{ value: MarketplaceSort; label: string }> = [
  { value: 'price-asc', label: 'low' },
  { value: 'price-desc', label: 'high' },
  { value: 'recent', label: 'new' },
];

export default function MarketplaceFilters({
  color,
  sort,
  refreshedLabel,
  onColorChange,
  onSortChange,
}: Props) {
  return (
    <div className="sticky top-12 z-10 border-y border-ink-2 bg-ink-0/95 px-3 py-2 backdrop-blur sm:px-6">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 font-mono text-[10px] uppercase tracking-[0.08em] text-bone-dim">
        <ColorSwatches color={color} onChange={onColorChange} />
        <div className="flex items-center gap-1">
          <span className="mr-1">sort</span>
          {SORTS.map(item => (
            <button
              key={item.value}
              type="button"
              onClick={() => onSortChange(item.value)}
              className={`border px-2 py-1 transition-colors ${
                sort === item.value
                  ? 'border-bone text-bone'
                  : 'border-ink-2 text-bone-dim hover:border-bone-dim hover:text-bone'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="ml-auto tabular-nums">{refreshedLabel}</div>
      </div>
    </div>
  );
}
