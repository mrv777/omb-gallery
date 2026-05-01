import type { TransferActivityDayRow } from '@/lib/db';
import { shortDate } from './chartUtils';

const VB_W = 600;
const VB_H = 56;
const TICK_COUNT = 5;

/**
 * Compact sparkline of (transferred + sold) events per day for the last @days.
 * Fills gaps so days with zero events still take horizontal space — gives an
 * honest view of "is the chain quiet?" vs "is the chart truncated?".
 *
 * Labels render as HTML around the SVG so they don't stretch with
 * `preserveAspectRatio="none"`.
 */
export default function TransferActivitySparkline({
  data,
  days,
}: {
  data: TransferActivityDayRow[];
  /** The window the SQL queried — used to pad missing days. */
  days: number;
}) {
  const filled = fillGaps(data, days);
  const counts = filled.map(d => d.count);
  const total = counts.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...counts);
  const last = filled[filled.length - 1];

  if (total === 0) {
    return (
      <div className="border border-ink-2 bg-ink-1 px-3 py-2 font-mono">
        <Header total={0} />
        <div className="h-[56px] flex items-center justify-center text-[10px] tracking-[0.08em] uppercase text-bone-dim">
          no transfers in last {days}d
        </div>
      </div>
    );
  }

  const stepX = filled.length > 1 ? VB_W / (filled.length - 1) : 0;
  const points = counts.map((c, i) => {
    const x = i * stepX;
    const y = VB_H - (c / max) * VB_H;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const linePath = `M ${points.join(' L ')}`;
  const areaPath = `M 0,${VB_H} ` + points.map(p => `L ${p}`).join(' ') + ` L ${VB_W},${VB_H} Z`;

  return (
    <div className="border border-ink-2 bg-ink-1 px-3 py-2 font-mono">
      <Header
        total={total}
        todayLabel={last ? shortDate(last.date) : '—'}
        todayCount={last?.count}
      />
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        className="w-full h-[56px] block"
        role="img"
        aria-label={`Transfer + sale events per day, last ${days} days`}
      >
        <path d={areaPath} fill="#ff8a2a" fillOpacity="0.18" />
        <path
          d={linePath}
          stroke="#ff8a2a"
          strokeWidth="1.25"
          fill="none"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="relative h-3 mt-1 text-[9px] tracking-[0.08em] uppercase text-bone-dim">
        {evenDateTicks(filled, TICK_COUNT).map((tk, i, arr) => {
          const isFirst = i === 0;
          const isLast = i === arr.length - 1;
          const style: React.CSSProperties = isFirst
            ? { left: 0 }
            : isLast
              ? { right: 0 }
              : { left: `${tk.pct}%`, transform: 'translateX(-50%)' };
          return (
            <span key={i} className="absolute top-0 whitespace-nowrap" style={style}>
              {isLast ? 'today' : tk.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function Header({
  total,
  todayLabel,
  todayCount,
}: {
  total: number;
  todayLabel?: string;
  todayCount?: number;
}) {
  return (
    <div className="flex items-baseline justify-between mb-1">
      <h3 className="text-[11px] tracking-[0.12em] uppercase text-bone">
        on-chain activity{' '}
        <span className="text-bone-dim tabular-nums">· {total.toLocaleString()} events</span>
      </h3>
      {todayLabel && todayCount != null && todayCount > 0 && (
        <span className="text-[10px] tracking-[0.08em] uppercase text-bone-dim">
          {todayLabel}
          <span className="text-bone tabular-nums"> · {todayCount}</span>
        </span>
      )}
    </div>
  );
}

/** Pick `count` evenly-spaced ticks from the filled day series. Index-based
 * (not time-based) since the sparkline plots one point per day at uniform
 * spacing — this keeps tick labels aligned with the visual grid even if the
 * underlying timeseries has irregular gaps (it doesn't here, but stays robust). */
function evenDateTicks(
  rows: TransferActivityDayRow[],
  count: number
): Array<{ pct: number; label: string }> {
  if (rows.length === 0 || count < 2) return [];
  const out: Array<{ pct: number; label: string }> = [];
  for (let i = 0; i < count; i++) {
    const frac = i / (count - 1);
    const idx = Math.round(frac * (rows.length - 1));
    out.push({ pct: frac * 100, label: shortDate(rows[idx].date) });
  }
  return out;
}

/** Insert zero-count rows for days the SQL didn't return. Returns @days entries
 * ending on today (UTC), in ascending order. */
function fillGaps(rows: TransferActivityDayRow[], days: number): TransferActivityDayRow[] {
  const map = new Map(rows.map(r => [r.date, r.count]));
  const out: TransferActivityDayRow[] = [];
  // eslint-disable-next-line react-hooks/purity
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const iso = d.toISOString().slice(0, 10);
    out.push({ date: iso, count: map.get(iso) ?? 0 });
  }
  return out;
}
