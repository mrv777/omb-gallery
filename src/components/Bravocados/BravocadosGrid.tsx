import Link from 'next/link';
import { Tooltip } from '../ui/Tooltip';

export type BravocadoGridItem = {
  number: number;
  /** True once the piece has left the distribution wallets. */
  dispensed: boolean;
};

// Plain responsive grid — 1,002 lazy-loaded ~1-4 KB PNGs need none of the
// VirtualizedZoomGrid machinery the 9k-piece OMB gallery uses.
export default function BravocadosGrid({ items }: { items: BravocadoGridItem[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(4rem,1fr))] gap-1.5">
      {items.map(item => (
        <Tooltip key={item.number} content={`Bravocados #${item.number}`}>
          <Link
            href={`/inscription/${item.number}`}
            prefetch={false}
            className="block aspect-square bg-ink-2 overflow-hidden border border-ink-2 hover:border-bone-dim transition-colors"
            style={{ contentVisibility: 'auto', containIntrinsicSize: '64px 64px' }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/bravocado-images/${item.number}.png`}
              alt={`Bravocados #${item.number}`}
              loading="lazy"
              decoding="async"
              className="w-full h-full object-cover [image-rendering:pixelated]"
            />
          </Link>
        </Tooltip>
      ))}
    </div>
  );
}
