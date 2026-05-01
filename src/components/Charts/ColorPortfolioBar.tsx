import type { InscriptionRow } from '@/lib/db';
import { OMB_COLOR_HEX, OMB_COLOR_ORDER } from './chartUtils';
import { Tooltip } from '../ui/Tooltip';

/**
 * Stacked horizontal color bar — visual fingerprint of a holder's bag spread
 * by OMB color. Aggregates from holdings client-side; no DB call.
 */
export default function ColorPortfolioBar({ holdings }: { holdings: InscriptionRow[] }) {
  const totals = aggregate(holdings);
  const total = totals.reduce((a, b) => a + b.count, 0);

  if (total === 0) return null;

  return (
    <div className="border border-ink-2 bg-ink-1 px-3 py-3 font-mono mb-12">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-[11px] tracking-[0.12em] uppercase text-bone">color spread</h3>
        <span className="text-[9px] tracking-[0.08em] uppercase text-bone-dim">
          {total.toLocaleString()} OMBs · {totals.length} {totals.length === 1 ? 'color' : 'colors'}
        </span>
      </div>
      <div className="flex w-full h-6 border border-ink-2 overflow-hidden">
        {totals.map(t => {
          const pct = (t.count / total) * 100;
          return (
            <Tooltip
              key={t.color}
              content={`${t.color}: ${t.count.toLocaleString()} (${pct.toFixed(1)}%)`}
            >
              <div
                style={{ width: `${pct}%`, backgroundColor: OMB_COLOR_HEX[t.color] ?? '#bfbfbf' }}
              />
            </Tooltip>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[10px] tracking-[0.08em] uppercase text-bone-dim">
        {totals.map(t => (
          <div key={t.color} className="flex items-center gap-1.5">
            <span
              className="inline-block w-2.5 h-2.5"
              style={{ backgroundColor: OMB_COLOR_HEX[t.color] ?? '#bfbfbf' }}
              aria-hidden
            />
            <span>{t.color}</span>
            <span className="text-bone tabular-nums">{t.count.toLocaleString()}</span>
            <span className="tabular-nums">· {((t.count / total) * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function aggregate(rows: InscriptionRow[]): { color: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const c = r.color ?? 'unknown';
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  // Sort by canonical color order first, then any unknowns at the end by count.
  const known = OMB_COLOR_ORDER.filter(c => counts.has(c)).map(c => ({
    color: c,
    count: counts.get(c)!,
  }));
  const extras = Array.from(counts.keys())
    .filter(c => !OMB_COLOR_ORDER.includes(c))
    .map(c => ({ color: c, count: counts.get(c)! }))
    .sort((a, b) => b.count - a.count);
  return [...known, ...extras];
}
