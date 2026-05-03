'use client';

import Link from 'next/link';
import { lookupInscription } from '@/lib/inscriptionLookup';
import SafeImg from '@/components/SafeImg';
import { Tooltip } from '../ui/Tooltip';

const COLOR_TILE_BG: Record<string, string> = {
  red: 'bg-accent-red/20',
  blue: 'bg-accent-blue/20',
  green: 'bg-accent-green/20',
  orange: 'bg-accent-orange/20',
  black: 'bg-accent-black/10',
};

// These tiles run as client components so the entire Tooltip → Slot subtree
// resolves in one piece. Previously rendered from a server component, the
// RSC streamer would inline the first tile's element shape but defer its
// children to a separate chunk; Radix's `Trigger asChild` Slot then saw a
// placeholder thenable instead of a valid element and rendered nothing,
// dropping exactly one tile (always the first in the sorted list) from
// the SSR HTML. Forcing the boundary at the tile means each tile streams
// uniformly and the Slot always gets a real element.
export function OmbTile({ number }: { number: number }) {
  const hit = lookupInscription(number);
  const tileBg = hit?.color ? (COLOR_TILE_BG[hit.color] ?? 'bg-ink-2') : 'bg-ink-2';
  return (
    <Tooltip content={`#${number}`}>
      <span
        className={`block w-20 h-20 sm:w-24 sm:h-24 ${tileBg} overflow-hidden border border-ink-2 hover:border-bone-dim transition-colors`}
        style={{
          contentVisibility: 'auto',
          containIntrinsicSize: '96px 96px',
        }}
      >
        <Link
          href={`/inscription/${number}`}
          prefetch={false}
          className="block w-full h-full"
        >
          {hit ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={hit.thumbnail}
              alt={`#${number}`}
              loading="lazy"
              decoding="async"
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center font-mono text-[10px] text-bone-dim">
              #{number}
            </div>
          )}
        </Link>
      </span>
    </Tooltip>
  );
}

export function BravocadosTile({
  number,
  inscriptionId,
}: {
  number: number;
  inscriptionId: string | null;
}) {
  const href = inscriptionId
    ? `https://ordinals.com/inscription/${inscriptionId}`
    : `https://ordinals.com/inscription/${number}`;
  const src = inscriptionId ? `https://ordinals.com/content/${inscriptionId}` : null;
  return (
    <Tooltip content={`Bravocados #${number}`}>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="block w-16 h-16 bg-ink-2 overflow-hidden border border-ink-2 hover:border-bone-dim transition-colors"
      >
        <SafeImg
          src={src}
          alt={`Bravocados #${number}`}
          loading="lazy"
          decoding="async"
          className="w-full h-full object-cover"
          fallback={
            <div className="w-full h-full flex items-center justify-center font-mono text-[9px] text-bone-dim">
              #{number}
            </div>
          }
        />
      </a>
    </Tooltip>
  );
}
