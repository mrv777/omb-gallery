import type { OwnershipDeltaRow } from '@/lib/db';
import { monthYear } from './chartUtils';

const VB_W = 600;
const VB_H = 160;
const PAD_L = 32;
const PAD_R = 8;
const PAD_T = 14;
const PAD_B = 24;

/**
 * Step-line of bag size over time, derived from on-chain receive/send events.
 * Walks deltas chronologically, accumulating a running count. Each delta moves
 * the line up (+1) or down (-1) at the event's timestamp. The series is
 * "what we know from indexed events" — non-sale transfers from before the ord
 * poller started are missing, so the chart shows only the post-indexing window.
 */
export default function BagSizeOverTime({ deltas }: { deltas: OwnershipDeltaRow[] }) {
  if (deltas.length === 0) {
    return (
      <Frame>
        <div className="h-[160px] flex items-center justify-center text-[10px] tracking-[0.08em] uppercase text-bone-dim">
          no recorded movement yet
        </div>
      </Frame>
    );
  }

  // Build the step series. Start at zero on the first event's timestamp; each
  // subsequent event adds delta to the running total.
  const sorted = [...deltas].sort((a, b) => a.block_timestamp - b.block_timestamp);
  let running = 0;
  const points: { t: number; v: number }[] = [];
  for (const d of sorted) {
    running += d.delta;
    if (running < 0) running = 0; // defensive — shouldn't happen if deltas are complete
    points.push({ t: d.block_timestamp, v: running });
  }

  const tMin = sorted[0].block_timestamp;
  // SSR-only chart: server time is the right "now" for the right-edge marker.
  // eslint-disable-next-line react-hooks/purity
  const tMax = Math.max(sorted[sorted.length - 1].block_timestamp, Math.floor(Date.now() / 1000));
  const tSpan = Math.max(1, tMax - tMin);
  const vMax = Math.max(1, ...points.map(p => p.v));

  const innerW = VB_W - PAD_L - PAD_R;
  const innerH = VB_H - PAD_T - PAD_B;
  const x = (t: number) => PAD_L + ((t - tMin) / tSpan) * innerW;
  const y = (v: number) => PAD_T + innerH - (v / vMax) * innerH;

  // Step-line path: horizontal at prior value until next event ts, then vertical to new value.
  let d = `M ${x(tMin).toFixed(2)},${y(0).toFixed(2)}`;
  let prevV = 0;
  for (const p of points) {
    d += ` L ${x(p.t).toFixed(2)},${y(prevV).toFixed(2)}`;
    d += ` L ${x(p.t).toFixed(2)},${y(p.v).toFixed(2)}`;
    prevV = p.v;
  }
  // Extend the last segment to "now" so the chart ends at the right edge.
  d += ` L ${x(tMax).toFixed(2)},${y(prevV).toFixed(2)}`;

  // Y-axis ticks: 0, mid, max.
  const yTicks = uniqueYTicks(vMax);

  return (
    <Frame>
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        className="w-full h-[160px] block"
        role="img"
        aria-label="Bag size over time"
      >
        {/* Y gridlines + labels */}
        {yTicks.map(v => (
          <g key={v}>
            <line
              x1={PAD_L}
              x2={VB_W - PAD_R}
              y1={y(v)}
              y2={y(v)}
              stroke="#7a7a75"
              strokeWidth="0.4"
              opacity="0.25"
            />
            <text
              x={PAD_L - 4}
              y={y(v) + 3}
              textAnchor="end"
              fontFamily="ui-monospace, Menlo, monospace"
              fontSize="9"
              fill="#7a7a75"
            >
              {v}
            </text>
          </g>
        ))}
        {/* X-axis baseline */}
        <line
          x1={PAD_L}
          x2={VB_W - PAD_R}
          y1={y(0)}
          y2={y(0)}
          stroke="#7a7a75"
          strokeWidth="0.5"
        />
        {/* Step-line */}
        <path
          d={d}
          stroke="#2bd46c"
          strokeWidth="1.4"
          fill="none"
          vectorEffect="non-scaling-stroke"
        />
        {/* X-axis labels: start month + end (now). */}
        <text
          x={PAD_L}
          y={VB_H - 6}
          fontFamily="ui-monospace, Menlo, monospace"
          fontSize="9"
          fill="#7a7a75"
        >
          {monthYear(tMin)}
        </text>
        <text
          x={VB_W - PAD_R}
          y={VB_H - 6}
          textAnchor="end"
          fontFamily="ui-monospace, Menlo, monospace"
          fontSize="9"
          fill="#7a7a75"
        >
          now
        </text>
      </svg>
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
