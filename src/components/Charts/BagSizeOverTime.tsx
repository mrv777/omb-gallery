import type { OwnershipDeltaRow } from '@/lib/db';
import type { HolderColorHighlight } from '@/lib/holderEvents';
import { timeTicks } from './chartUtils';

const VB_W = 600;
const VB_H = 140;
const TICK_COUNT = 5;

/**
 * Step-line of bag size over time, derived from on-chain receive/send events.
 * Walks deltas chronologically, accumulating a running count. Each delta moves
 * the line up (+1) or down (-1) at the event's timestamp. The series is
 * "what we know from indexed events" — non-sale transfers from before the ord
 * poller started are missing, so the chart shows only the post-indexing window.
 *
 * Optional `highlights` overlays markers at red/blue OMB events: filled circle
 * for received, hollow stroke for sent. Markers sit on the line at the running
 * bag-size value at that exact event, correlated by `event_id`.
 *
 * Labels and markers live in HTML around the SVG so they don't get stretched
 * by the non-uniform `preserveAspectRatio="none"` we use to make the line fill
 * width. (Circles in viewBox space would render as ovals.)
 */
export default function BagSizeOverTime({
  deltas,
  highlights = [],
}: {
  deltas: OwnershipDeltaRow[];
  highlights?: HolderColorHighlight[];
}) {
  if (deltas.length === 0) {
    return (
      <Frame hasHighlights={false}>
        <div className="h-[140px] flex items-center justify-center text-[10px] tracking-[0.08em] uppercase text-bone-dim">
          no recorded movement yet
        </div>
      </Frame>
    );
  }

  // Sort by (timestamp ASC, event_id ASC) so internal-transfer +1/-1 pairs
  // collapse to net 0 at exactly the same x position. event_id is the same
  // for the +1 and -1 rows of an internal transfer (one row per direction
  // per wallet), so the secondary sort keeps determinism across walks.
  const sorted = [...deltas].sort(
    (a, b) => a.block_timestamp - b.block_timestamp || a.event_id - b.event_id
  );
  let running = 0;
  const points: { t: number; v: number }[] = [];
  // event_id → running bag size *after* applying that event. For multi-row
  // events (internal transfers, where +1 and -1 land under the same id from
  // different wallets), the latter overwrites — but we only consult this
  // map for highlighted (non-internal) events, where the id appears once.
  const runningByEvent = new Map<number, number>();
  for (const d of sorted) {
    running += d.delta;
    if (running < 0) running = 0;
    points.push({ t: d.block_timestamp, v: running });
    runningByEvent.set(d.event_id, running);
  }

  const tMin = sorted[0].block_timestamp;
  // SSR-only chart: server time is the right "now" for the right-edge marker.
  // eslint-disable-next-line react-hooks/purity
  const tMax = Math.max(sorted[sorted.length - 1].block_timestamp, Math.floor(Date.now() / 1000));
  const tSpan = Math.max(1, tMax - tMin);
  const vMax = Math.max(1, ...points.map(p => p.v));

  const x = (t: number) => ((t - tMin) / tSpan) * VB_W;
  const y = (v: number) => VB_H - (v / vMax) * VB_H;

  let d = `M ${x(tMin).toFixed(2)},${y(0).toFixed(2)}`;
  let prevV = 0;
  for (const p of points) {
    d += ` L ${x(p.t).toFixed(2)},${y(prevV).toFixed(2)}`;
    d += ` L ${x(p.t).toFixed(2)},${y(p.v).toFixed(2)}`;
    prevV = p.v;
  }
  d += ` L ${x(tMax).toFixed(2)},${y(prevV).toFixed(2)}`;

  const yTicks = uniqueYTicks(vMax);
  const xTicks = timeTicks(tMin, tMax, TICK_COUNT);

  // Project highlights onto the chart. We position markers in HTML overlay
  // (not SVG) so circles stay round under the SVG's non-uniform stretch.
  // `top`/`left` are percentages so the overlay tracks the SVG box exactly.
  const markers = highlights
    .map(h => {
      const v = runningByEvent.get(h.event_id);
      // No matching delta? Drop. Shouldn't happen — fetch-side guarantees
      // each highlight has a corresponding +/-1 delta — but defensive.
      if (v == null) return null;
      const xPct = ((h.block_timestamp - tMin) / tSpan) * 100;
      const yPct = ((vMax - v) / vMax) * 100;
      return {
        h,
        xPct: clamp(xPct, 0, 100),
        yPct: clamp(yPct, 0, 100),
      };
    })
    .filter((m): m is { h: HolderColorHighlight; xPct: number; yPct: number } => m != null);

  return (
    <Frame hasHighlights={highlights.length > 0}>
      <div className="flex">
        <div className="relative w-8 h-[140px] shrink-0 mr-1">
          {yTicks.map(v => {
            const topPct = ((vMax - v) / vMax) * 100;
            return (
              <span
                key={v}
                className="absolute right-1 text-[9px] tabular-nums text-bone-dim leading-none -translate-y-1/2"
                style={{ top: `${topPct}%` }}
              >
                {v}
              </span>
            );
          })}
        </div>
        <div className="flex-1 relative">
          <svg
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            preserveAspectRatio="none"
            className="w-full h-[140px] block"
            role="img"
            aria-label="Bag size over time"
          >
            {yTicks.map(v => (
              <line
                key={v}
                x1={0}
                x2={VB_W}
                y1={y(v)}
                y2={y(v)}
                stroke="#7a7a75"
                strokeWidth="1"
                opacity="0.25"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <path
              d={d}
              stroke="#2bd46c"
              strokeWidth="1.4"
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {markers.length > 0 && (
            <div className="absolute inset-0 pointer-events-none">
              {markers.map(({ h, xPct, yPct }) => {
                const label = `#${h.inscription_number} · ${h.color} · ${h.direction === 'in' ? 'received' : 'sent'}`;
                return (
                  <a
                    key={h.event_id}
                    href={`/inscription/${h.inscription_number}`}
                    title={label}
                    aria-label={label}
                    className="absolute pointer-events-auto"
                    style={{
                      left: `${xPct}%`,
                      top: `${yPct}%`,
                      transform: 'translate(-50%, -50%)',
                    }}
                  >
                    <span
                      className={`block w-[7px] h-[7px] rounded-full ${markerClasses(h)}`}
                    />
                  </a>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <div className="relative pl-9 mt-1 h-3 text-[9px] tracking-[0.08em] uppercase text-bone-dim">
        <div className="relative h-full">
          {xTicks.map((tk, i) => {
            const isFirst = i === 0;
            const isLast = i === xTicks.length - 1;
            const style: React.CSSProperties = isFirst
              ? { left: 0 }
              : isLast
                ? { right: 0 }
                : { left: `${tk.pct}%`, transform: 'translateX(-50%)' };
            return (
              <span key={i} className="absolute top-0 whitespace-nowrap" style={style}>
                {isLast ? 'now' : tk.label}
              </span>
            );
          })}
        </div>
      </div>
      {highlights.length > 0 && <Legend />}
    </Frame>
  );
}

function markerClasses(h: HolderColorHighlight): string {
  // Filled = received, hollow ring = sent. Tailwind's bg-* / border-* /
  // ring-* utilities use our palette swatches so the markers match the
  // accent-{red,blue} used elsewhere in the UI.
  const palette =
    h.color === 'red'
      ? { bg: 'bg-accent-red', border: 'border-accent-red' }
      : { bg: 'bg-accent-blue', border: 'border-accent-blue' };
  if (h.direction === 'in') {
    return `${palette.bg} border border-ink-1`;
  }
  return `bg-ink-1 border-2 ${palette.border}`;
}

function Frame({
  children,
  hasHighlights,
}: {
  children: React.ReactNode;
  hasHighlights: boolean;
}) {
  return (
    <div className="border border-ink-2 bg-ink-1 px-3 py-3 font-mono mb-12">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-[11px] tracking-[0.12em] uppercase text-bone">bag size over time</h3>
        <span className="text-[9px] tracking-[0.08em] uppercase text-bone-dim">
          {hasHighlights ? 'red & blue eyes highlighted' : 'since indexer began'}
        </span>
      </div>
      {children}
    </div>
  );
}

function Legend() {
  return (
    <div className="mt-2 pl-9 flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] tracking-[0.08em] uppercase text-bone-dim">
      <LegendDot color="red" filled label="red in" />
      <LegendDot color="red" filled={false} label="red out" />
      <LegendDot color="blue" filled label="blue in" />
      <LegendDot color="blue" filled={false} label="blue out" />
    </div>
  );
}

function LegendDot({
  color,
  filled,
  label,
}: {
  color: 'red' | 'blue';
  filled: boolean;
  label: string;
}) {
  const cls =
    color === 'red'
      ? filled
        ? 'bg-accent-red border border-ink-1'
        : 'bg-ink-1 border-2 border-accent-red'
      : filled
        ? 'bg-accent-blue border border-ink-1'
        : 'bg-ink-1 border-2 border-accent-blue';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`block w-[7px] h-[7px] rounded-full ${cls}`} />
      <span className="normal-case tracking-normal">{label}</span>
    </span>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function uniqueYTicks(max: number): number[] {
  if (max <= 1) return [0, 1];
  if (max <= 4) {
    const ticks = [];
    for (let i = 0; i <= max; i++) ticks.push(i);
    return ticks;
  }
  const mid = Math.round(max / 2);
  const set = new Set([0, mid, max]);
  return Array.from(set).sort((a, b) => a - b);
}
