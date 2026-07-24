import Link from 'next/link';
import { fullDate } from '../Charts/chartUtils';
import type { NotableBlock } from '@/lib/satProvenance';

export type BlockBucket = {
  height: number;
  count: number;
  colors: string[];
  notable: NotableBlock | null;
  minedAt: number | null;
};

export type VariedSat = {
  number: number;
  color: string;
  sat: number;
  height: number;
  minedAt: number | null;
  vintage: string | null;
};

/** How many of the individually-sourced pieces to list before linking out. */
const VARIED_PREVIEW = 12;

export default function SatProvenancePanel({
  total,
  buckets,
  varied,
  variedColors,
}: {
  total: number;
  buckets: BlockBucket[];
  varied: VariedSat[];
  variedColors: readonly string[];
}) {
  const headline = buckets[0];
  const vintages = varied.reduce<Record<string, number>>((acc, v) => {
    if (v.vintage) acc[v.vintage] = (acc[v.vintage] ?? 0) + 1;
    return acc;
  }, {});
  const vintageYears = Object.keys(vintages).sort();
  const oldest = varied[0];

  return (
    <div className="space-y-8">
      {headline && (
        <div className="border border-ink-2 bg-ink-1 p-4 sm:p-5">
          <div className="font-mono text-2xl sm:text-3xl text-bone tracking-[0.04em]">
            {headline.count.toLocaleString()}{' '}
            <span className="text-bone-dim text-base">of {total.toLocaleString()}</span>
          </div>
          <p className="font-mono mt-2 max-w-2xl text-[11px] leading-relaxed text-bone-dim uppercase tracking-[0.08em]">
            sit on satoshis minted in block {headline.height.toLocaleString()}
            {headline.minedAt != null && <> — mined {fullDate(headline.minedAt)}</>}.{' '}
            {headline.colors.join(' + ')} all draw from the same block.
          </p>
          {headline.notable && (
            <p className="font-mono mt-2 max-w-2xl text-[11px] leading-relaxed text-bone-dim">
              {headline.notable.note}{' '}
              <a
                href={headline.notable.source.href}
                target="_blank"
                rel="noopener noreferrer"
                className="uppercase tracking-[0.08em] hover:text-bone underline underline-offset-4"
              >
                {headline.notable.source.label} ↗
              </a>
            </p>
          )}
        </div>
      )}

      <div>
        <h3 className="font-mono text-sm text-bone uppercase tracking-[0.08em] mb-3">
          blocks that back a whole drop
        </h3>
        <ul className="font-mono text-[11px] uppercase tracking-[0.08em] space-y-1.5">
          {buckets.map(b => (
            <li key={b.height} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-bone w-28 shrink-0">block {b.height.toLocaleString()}</span>
              <span className="text-bone-dim w-28 shrink-0">
                {b.count.toLocaleString()} {b.count === 1 ? 'piece' : 'pieces'}
              </span>
              <span className="text-bone-dim">{b.colors.join(', ')}</span>
              {b.notable && (
                <span className="text-bone-dim">
                  {b.notable.confidence === 'attributed' && '†'}
                  {b.notable.attributedMiner}
                </span>
              )}
              {b.minedAt != null && (
                <span className="text-bone-dim opacity-70">{fullDate(b.minedAt)}</span>
              )}
            </li>
          ))}
        </ul>
        {varied.length > 0 && (
          <p className="font-mono mt-3 max-w-2xl text-[11px] leading-relaxed text-bone-dim uppercase tracking-[0.08em]">
            The remaining {varied.length.toLocaleString()} pieces are spread across{' '}
            {new Set(varied.map(v => v.height)).size} more blocks, one or two at a time — listed
            below.
          </p>
        )}
        <p className="font-mono mt-3 max-w-2xl text-[10px] leading-relaxed text-bone-dim uppercase tracking-[0.08em]">
          † attributed by community consensus, not provable from the chain.
        </p>
      </div>

      {varied.length > 0 && (
        <div>
          <h3 className="font-mono text-sm text-bone uppercase tracking-[0.08em] mb-2">
            the {varied.length} individually-sourced sats
          </h3>
          <p className="font-mono mb-4 max-w-2xl text-[11px] leading-relaxed text-bone-dim uppercase tracking-[0.08em]">
            Every {variedColors.join('/')} eye sits on its own satoshi, hunted one at a time — the
            only per-piece provenance gradient in the collection. Sorted oldest satoshi first.
            {oldest && (
              <>
                {' '}
                The oldest of them is #{oldest.number}, on a block {oldest.height.toLocaleString()}{' '}
                sat. Note these are all <em className="not-italic text-bone">younger</em> than the
                block 9 and block 78 sats above — the reds are distinguished by having their own
                satoshi each, not by age.
              </>
            )}
          </p>
          {/* Year counts below are scoped to these pieces only. Read collection-wide
              they would be badly wrong: blocks 9 and 78 were mined in January 2009,
              so nearly every OMB is on a 2009 sat. */}
          <p className="font-mono mb-4 text-[10px] uppercase tracking-[0.08em] text-bone-dim">
            <span className="mr-3">by sat year, {variedColors.join('/')} only:</span>
            {vintageYears.map(y => (
              <span key={y} className="mr-3 inline-block">
                {y} <span className="text-bone">{vintages[y]}</span>
              </span>
            ))}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] font-mono text-[11px] uppercase tracking-[0.08em]">
              <thead>
                <tr className="text-bone-dim border-b border-ink-2">
                  <th className="text-left font-normal py-2 pr-4">piece</th>
                  <th className="text-right font-normal py-2 pr-4">sat block</th>
                  <th className="text-left font-normal py-2 pr-4">mined</th>
                  <th className="text-left font-normal py-2">sat</th>
                </tr>
              </thead>
              <tbody>
                {varied.slice(0, VARIED_PREVIEW).map(v => (
                  <tr key={v.number} className="border-b border-ink-2/60">
                    <td className="py-2 pr-4">
                      <Link
                        href={`/inscription/${v.number}`}
                        className="text-bone hover:underline underline-offset-4"
                      >
                        #{v.number}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 text-right text-bone-dim">
                      {v.height.toLocaleString()}
                    </td>
                    <td className="py-2 pr-4 text-bone-dim">
                      {v.minedAt != null ? fullDate(v.minedAt) : '—'}
                    </td>
                    <td className="py-2 text-bone-dim tabular-nums">{v.sat.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {varied.length > VARIED_PREVIEW && (
            <Link
              href={`/?color=${varied[0].color}`}
              className="font-mono mt-3 inline-block text-[10px] uppercase tracking-[0.08em] text-bone-dim hover:text-bone underline underline-offset-4"
            >
              browse all {varied.length} {varied[0].color} eyes →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
