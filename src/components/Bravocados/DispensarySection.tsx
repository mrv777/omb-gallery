import Link from 'next/link';
import { BRAVOCADO_DISPENSARY_ADDRESS } from '@/lib/walletLabels';
import { truncateAddr } from '@/lib/format';
import { Tooltip } from '../ui/Tooltip';
import type { BravocadoGridItem } from './BravocadosGrid';

export default function DispensarySection({ items }: { items: BravocadoGridItem[] }) {
  const dispensed = items.filter(i => i.dispensed).length;
  return (
    <section className="mb-12 font-mono">
      <h2 className="text-lg text-bone uppercase tracking-[0.08em] mb-2">
        dispensary{' '}
        <span className="text-bone-dim text-[11px] tracking-[0.08em]">
          {dispensed} of {items.length} dispensed
        </span>
      </h2>
      <p className="mb-4 text-[11px] leading-relaxed text-bone-dim uppercase tracking-[0.08em]">
        The first {items.length} bravocados are handed out one at a time to{' '}
        <Link href="/info" className="text-bone hover:underline underline-offset-4">
          Parasite pool
        </Link>{' '}
        miners who land a big share, in order, from the{' '}
        <Tooltip content={BRAVOCADO_DISPENSARY_ADDRESS}>
          <Link
            href={`/holder/${BRAVOCADO_DISPENSARY_ADDRESS}`}
            prefetch={false}
            className="text-bone hover:text-accent-orange normal-case tracking-normal"
          >
            {truncateAddr(BRAVOCADO_DISPENSARY_ADDRESS, 8, 6)}
          </Link>
        </Tooltip>{' '}
        dispensary wallet. Dimmed pieces are still waiting for a winner.
      </p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(3.5rem,1fr))] gap-1.5">
        {items.map(item => (
          <Tooltip
            key={item.number}
            content={`Bravocados #${item.number}${item.dispensed ? ' · dispensed' : ' · waiting'}`}
          >
            <Link
              href={`/inscription/${item.number}`}
              prefetch={false}
              className={`relative block aspect-square bg-ink-2 overflow-hidden border transition-colors ${
                item.dispensed
                  ? 'border-accent-green/40 hover:border-accent-green'
                  : 'border-ink-2 hover:border-bone-dim opacity-40 hover:opacity-80'
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/bravocado-images/${item.number}.png`}
                alt={`Bravocados #${item.number}`}
                loading="lazy"
                decoding="async"
                className="w-full h-full object-cover [image-rendering:pixelated]"
              />
              {item.dispensed && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute bottom-1 right-1 w-1.5 h-1.5 rounded-full bg-accent-green ring-1 ring-ink-1"
                />
              )}
            </Link>
          </Tooltip>
        ))}
      </div>
    </section>
  );
}
