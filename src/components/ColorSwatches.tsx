'use client';

import { memo } from 'react';
import { ColorFilter } from '@/lib/types';
import { COLOR_VALUES } from '@/lib/colorFilter';

const SWATCH_CLASS: Record<(typeof COLOR_VALUES)[number], string> = {
  red: 'bg-accent-red',
  blue: 'bg-accent-blue',
  green: 'bg-accent-green',
  orange: 'bg-accent-orange',
  black: 'bg-accent-black',
};

type Props = {
  color: ColorFilter;
  onChange: (next: ColorFilter) => void;
  /** Compact omits the "ALL" pill (use the active swatch's untoggled state instead). */
  compact?: boolean;
};

/** The 5 OMB color swatches plus an "all" pill. Used in the gallery header
 * via FilterControls and in the SubpageShell header on /activity + /explorer. */
const ColorSwatches = memo(function ColorSwatches({ color, onChange, compact }: Props) {
  return (
    <div className="flex items-center shrink-0">
      {!compact && (
        <button
          type="button"
          onClick={() => onChange('all')}
          className={`h-10 px-2.5 flex items-center text-[11px] tracking-[0.12em] transition-colors ${
            color === 'all' ? 'text-bone' : 'text-bone-dim hover:text-bone'
          }`}
          aria-label="Show all colors"
        >
          <span
            className={`border px-1.5 py-0.5 ${
              color === 'all' ? 'border-bone' : 'border-transparent'
            }`}
          >
            ALL
          </span>
        </button>
      )}
      {COLOR_VALUES.map(value => {
        const active = color === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => onChange(active && compact ? 'all' : value)}
            className="h-10 w-9 flex items-center justify-center group"
            aria-label={active ? `Clear ${value} filter` : `Filter by ${value}`}
            aria-pressed={active}
          >
            <span
              className={`block w-3.5 h-3.5 ${SWATCH_CLASS[value]} transition-[outline] ${
                active
                  ? 'outline outline-1 outline-offset-[3px] outline-bone'
                  : 'opacity-70 group-hover:opacity-100'
              }`}
            />
          </button>
        );
      })}
    </div>
  );
});

export default ColorSwatches;
