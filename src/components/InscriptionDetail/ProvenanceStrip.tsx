import Link from 'next/link';
import { fullDate } from '../Charts/chartUtils';
import { memberLabel, seriesForNumber } from '@/lib/series';
import { blockMinedAt, satProvenance } from '@/lib/satProvenance';

/**
 * The one-line "what is this piece, beyond its number" strip.
 *
 * Two independent things share a row because they answer the same question:
 * which curated sets it belongs to, and which satoshi it sits on. Until now the
 * sat was fetched on every detail page and used solely to build a raster.art
 * href — never shown. For most holders this is the first time they learn their
 * OMB is on a satoshi mined in January 2009.
 */
export default function ProvenanceStrip({
  inscriptionNumber,
  sat,
}: {
  inscriptionNumber: number;
  /** From inscriptions.sat. Null for bravocados and any unbacked row. */
  sat: number | null;
}) {
  const series = seriesForNumber(inscriptionNumber);
  const prov = sat != null ? satProvenance(sat) : null;
  if (series.length === 0 && !prov) return null;

  const minedAt = prov ? (prov.minedAt ?? blockMinedAt(prov.height)) : null;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[10px] tracking-[0.12em] uppercase">
      {series.map(s => (
        <Link
          key={s.id}
          href={`/?series=${s.slug}`}
          className="border border-bone-dim/40 px-1.5 py-0.5 text-bone-dim hover:border-bone hover:text-bone transition-colors"
          title={s.blurb}
        >
          {memberLabel(s, inscriptionNumber)}
        </Link>
      ))}

      {prov && (
        <span
          className="border border-bone-dim/40 px-1.5 py-0.5 text-bone-dim"
          title={
            prov.notable
              ? `${prov.notable.note}${prov.notable.confidence === 'attributed' ? ' (attributed, not proven)' : ''}`
              : `Satoshi ${prov.sat.toLocaleString()}`
          }
        >
          sat block {prov.height.toLocaleString()}
          {prov.notable && (
            <>
              {' · '}
              {prov.notable.confidence === 'attributed' && '†'}
              {prov.notable.attributedMiner}
            </>
          )}
          {minedAt != null && <> · {fullDate(minedAt)}</>}
        </span>
      )}

      {prov && (
        <Link
          href="/history#sats"
          className="text-bone-dim/70 hover:text-bone underline underline-offset-4"
          title="How the collection's satoshis were chosen"
        >
          why →
        </Link>
      )}
    </div>
  );
}
