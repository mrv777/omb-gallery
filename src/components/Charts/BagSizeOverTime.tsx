import type { OwnershipDeltaRow } from '@/lib/db';
import { monthYear } from './chartUtils';

const VB_W = 600;
const VB_H = 140;

/**
 * Step-line of bag size over time, derived from on-chain receive/send events.
 * Walks deltas chronologically, accumulating a running count. Each delta moves
 * the line up (+1) or down (-1) at the event's timestamp. The series is
 * "what we know from indexed events" — non-sale transfers from before the ord
 * poller started are missing, so the chart shows only the post-indexing window.
 *
 * Labels live in HTML around the SVG so they don't get stretched by the
 * non-uniform `preserveAspectRatio="none"` we use to make the line fill width.
 */
export default function BagSizeOverTime({ deltas }: { deltas: OwnershipDeltaRow[] }) {
  if (deltas.length === 0) {
    return (
      <Frame>
        <div className="h-[140px] flex items-center justify-center text-[10px] tracking-[0.08em] uppercase text-bone-dim">
          no recorded movement yet
        </div>
      </Frame>
    );
  }

  const sorted = [...deltas].sort((a, b) => a.block_timestamp - b.block_timestamp);
  let running = 0;
  const points: { t: number; v: number }[] = [];
  for (const d of sorted) {
    running += d.delta;
    if (running < 0) running = 0;
    points.push({ t: d.block_timestamp, v: running });
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

  return (
    <Frame>
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
        <div className="flex-1">
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
        </div>
      </div>
      <div className="flex justify-between pl-9 mt-1 text-[9px] tracking-[0.08em] uppercase text-bone-dim">
        <span>{monthYear(tMin)}</span>
        <span>now</span>
      </div>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="border border-ink-2 bg-ink-1 px-3 py-3 font-mono mb-12">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-[11px] tracking-[0.12em] uppercase text-bone">bag size over time</h3>
        <span className="text-[9px] tracking-[0.08em] uppercase text-bone-dim">
          since indexer began
        </span>
      </div>
      {children}
    </div>
  );
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
