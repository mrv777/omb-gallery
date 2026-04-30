import type { TransferActivityDayRow } from '@/lib/db';
import { shortDate } from './chartUtils';

const VB_W = 600;
const VB_H = 64;
const PAD_L = 4;
const PAD_R = 4;
const PAD_T = 4;
const PAD_B = 14;

/**
 * Compact sparkline of (transferred + sold) events per day for the last @days.
 * Fills gaps so days with zero events still take horizontal space — gives an
 * honest view of "is the chain quiet?" vs "is the chart truncated?".
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
        <Header total={0} todayLabel="—" />
        <div className="h-[64px] flex items-center justify-center text-[10px] tracking-[0.08em] uppercase text-bone-dim">
          no transfers in last {days}d
        </div>
      </div>
    );
  }

  const innerW = VB_W - PAD_L - PAD_R;
  const innerH = VB_H - PAD_T - PAD_B;
  const stepX = filled.length > 1 ? innerW / (filled.length - 1) : 0;

  // Build the line path; line keeps "0" days at the baseline so the eye reads
  // genuinely-quiet stretches as flat low.
  const points = counts.map((c, i) => {
    const x = PAD_L + i * stepX;
    const y = PAD_T + innerH - (c / max) * innerH;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const linePath = `M ${points.join(' L ')}`;
  // Area below the line, anchored to the baseline.
  const baselineY = PAD_T + innerH;
  const areaPath =
    `M ${PAD_L},${baselineY} ` +
    points.map((p, i) => (i === 0 ? `L ${p}` : `L ${p}`)).join(' ') +
    ` L ${PAD_L + (filled.length - 1) * stepX},${baselineY} Z`;

  return (
    <div className="border border-ink-2 bg-ink-1 px-3 py-2 font-mono">
      <Header total={total} todayLabel={last ? shortDate(last.date) : '—'} todayCount={last?.count} />
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        className="w-full h-[64px] block"
        role="img"
        aria-label={`Transfer + sale events per day, last ${days} days`}
      >
        <path d={areaPath} fill="#ff8a2a" fillOpacity="0.18" />
        <path d={linePath} stroke="#ff8a2a" strokeWidth="1.25" fill="none" vectorEffect="non-scaling-stroke" />
        {/* X-axis hairline */}
        <line
          x1={PAD_L}
          x2={VB_W - PAD_R}
          y1={baselineY}
          y2={baselineY}
          stroke="#7a7a75"
          strokeWidth="0.4"
          opacity="0.5"
        />
        <text
          x={PAD_L}
          y={VB_H - 3}
          fontFamily="ui-monospace, Menlo, monospace"
          fontSize="9"
          fill="#7a7a75"
        >
          {filled[0] ? shortDate(filled[0].date) : ''}
        </text>
        <text
          x={VB_W - PAD_R}
          y={VB_H - 3}
          textAnchor="end"
          fontFamily="ui-monospace, Menlo, monospace"
          fontSize="9"
          fill="#7a7a75"
        >
          today
        </text>
      </svg>
    </div>
  );
}

function Header({
  total,
  todayLabel,
  todayCount,
}: {
  total: number;
  todayLabel: string;
  todayCount?: number;
}) {
  return (
    <div className="flex items-baseline justify-between mb-1">
      <h3 className="text-[11px] tracking-[0.12em] uppercase text-bone">
        on-chain activity{' '}
        <span className="text-bone-dim tabular-nums">· {total.toLocaleString()} events</span>
      </h3>
      {todayCount != null && todayCount > 0 && (
        <span className="text-[10px] tracking-[0.08em] uppercase text-bone-dim">
          {todayLabel}
          <span className="text-bone tabular-nums"> · {todayCount}</span>
        </span>
      )}
    </div>
  );
}

/** Insert zero-count rows for days the SQL didn't return. Returns @days entries
 * ending on today (UTC), in ascending order. */
function fillGaps(rows: TransferActivityDayRow[], days: number): TransferActivityDayRow[] {
  const map = new Map(rows.map(r => [r.date, r.count]));
  const out: TransferActivityDayRow[] = [];
  // Build "today" in UTC to match the date(unixepoch) bucketing in SQLite.
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
