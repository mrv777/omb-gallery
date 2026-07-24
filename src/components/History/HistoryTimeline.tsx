import type { Confidence, OffChainFact } from '@/lib/history';
import { timelineSortKey } from '@/lib/history';

/**
 * A timeline row derived from our own index rather than from a press write-up.
 * Rendered with a ⛓ marker so a reader can tell at a glance which claims were
 * recomputed on this page load and which came from a source we're trusting.
 */
export type ChainFact = {
  id: string;
  date: string;
  title: string;
  body: string;
};

type Row = ({ kind: 'chain' } & ChainFact) | ({ kind: 'offchain' } & OffChainFact);

const CONFIDENCE_NOTE: Record<Confidence, string | null> = {
  confirmed: null,
  reported: 'single source',
  disputed: 'sources conflict',
};

function displayDate(date: string): string {
  const [y, m, d] = date.split('-');
  const months = [
    'jan',
    'feb',
    'mar',
    'apr',
    'may',
    'jun',
    'jul',
    'aug',
    'sep',
    'oct',
    'nov',
    'dec',
  ];
  const mon = months[parseInt(m, 10) - 1] ?? m;
  return d ? `${mon} ${parseInt(d, 10)} ${y}` : `${mon} ${y}`;
}

export default function HistoryTimeline({
  chainFacts,
  offChainFacts,
}: {
  chainFacts: ChainFact[];
  offChainFacts: readonly OffChainFact[];
}) {
  const rows: Row[] = [
    ...chainFacts.map(f => ({ kind: 'chain' as const, ...f })),
    ...offChainFacts.map(f => ({ kind: 'offchain' as const, ...f })),
  ].sort((a, b) => timelineSortKey(a.date).localeCompare(timelineSortKey(b.date)));

  return (
    <ol className="border-l border-ink-2 pl-4 sm:pl-6 space-y-6">
      {rows.map(row => (
        <li key={`${row.kind}-${row.id}`} className="relative">
          <span
            className={`absolute -left-[1.32rem] sm:-left-[1.82rem] top-1.5 h-2 w-2 ${
              row.kind === 'chain' ? 'bg-bone' : 'border border-bone-dim'
            }`}
            aria-hidden
          />
          <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-bone-dim flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{displayDate(row.date)}</span>
            {row.kind === 'chain' ? (
              <span title="Recomputed from our index on this page load">⛓ on-chain</span>
            ) : (
              CONFIDENCE_NOTE[row.confidence] && <span>({CONFIDENCE_NOTE[row.confidence]})</span>
            )}
          </div>
          <h3 className="font-mono text-sm text-bone uppercase tracking-[0.08em] mt-1">
            {row.title}
          </h3>
          <p className="font-mono mt-1 max-w-2xl text-[11px] leading-relaxed text-bone-dim">
            {row.body}
          </p>
          {row.kind === 'offchain' && (
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              <a
                href={row.source.href}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[10px] uppercase tracking-[0.08em] text-bone-dim hover:text-bone underline underline-offset-4"
              >
                {row.source.label} ↗
              </a>
              {row.corrects && (
                <a
                  href={row.corrects.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-[10px] uppercase tracking-[0.08em] text-bone-dim/70 hover:text-bone underline underline-offset-4"
                  title="The published account this entry corrects"
                >
                  corrects: {row.corrects.label} ↗
                </a>
              )}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
