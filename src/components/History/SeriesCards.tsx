import Link from 'next/link';
import { SERIES, type Series } from '@/lib/series';
import { lookupInscription } from '@/lib/inscriptionLookup';
import { encodeIds } from '@/lib/slideshowCodec';

/** Thumbnails shown per card. Enough to read the set at a glance, not a grid. */
const PREVIEW = 6;
/** Slideshow URLs stay comfortably under 2 KB well past this. */
const MAX_SLIDESHOW_IDS = 500;

function statusLabel(s: Series): string {
  if (s.declaredSize != null) return `${s.members.length} / ${s.declaredSize} catalogued`;
  return `${s.members.length} catalogued`;
}

function SeriesCard({ series }: { series: Series }) {
  const preview = series.members.slice(0, PREVIEW);
  const playHref =
    series.members.length > 0 && series.members.length <= MAX_SLIDESHOW_IDS
      ? `/slideshow?ids=${encodeIds(series.members.map(String))}`
      : null;

  return (
    <div className="border border-ink-2 bg-ink-1 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-mono text-sm text-bone uppercase tracking-[0.08em]">{series.label}</h3>
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-bone-dim">
          {statusLabel(series)}
          {/* Stated either way, not just as a warning on the unfinished ones.
              The section lede promises that completed and still-open sets are
              both marked, and with every set now catalogued in full an absent
              suffix would be the only thing carrying that — i.e. nothing. */}
          {series.status === 'partial' ? ' · incomplete' : ' · complete'}
        </span>
      </div>

      <p className="font-mono mt-2 max-w-2xl text-[11px] leading-relaxed text-bone-dim">
        {series.blurb}
      </p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {preview.map(n => {
          const hit = lookupInscription(n);
          if (!hit) return null;
          return (
            <Link key={n} href={`/inscription/${n}`} title={`#${n}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={hit.thumbnail}
                alt={`OMB #${n}`}
                width={48}
                height={48}
                loading="lazy"
                className="h-12 w-12 border border-ink-2 hover:border-bone-dim transition-colors"
              />
            </Link>
          );
        })}
      </div>

      {/* series.provenance is deliberately NOT rendered — how a list was seeded
          is maintainer methodology, and on a public card it buried the art
          under a paragraph of process. The status pill above ("50 / 50
          catalogued · complete") carries the honesty the reader needs. */}

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
        <Link
          href={`/?series=${series.slug}`}
          className="font-mono text-[10px] uppercase tracking-[0.08em] text-bone hover:underline underline-offset-4"
        >
          see them in the gallery →
        </Link>
        {playHref && (
          <Link
            href={playHref}
            className="font-mono text-[10px] uppercase tracking-[0.08em] text-bone-dim hover:text-bone underline underline-offset-4"
          >
            ▶ play as slideshow
          </Link>
        )}
      </div>
    </div>
  );
}

export default function SeriesCards() {
  return (
    <div className="space-y-4">
      {SERIES.map(s => (
        <SeriesCard key={s.id} series={s} />
      ))}
    </div>
  );
}
