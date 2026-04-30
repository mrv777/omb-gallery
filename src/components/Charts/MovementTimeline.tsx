import type { EventRow } from '@/lib/db';
import { fullDate, monthYear } from './chartUtils';

const VB_W = 600;
const VB_H = 40;

const EVENT_COLOR: Record<string, string> = {
  inscribed: '#ff8a2a',
  transferred: '#2f4cff',
  sold: '#2bd46c',
};

const EVENT_LABEL: Record<string, string> = {
  inscribed: 'inscribed',
  transferred: 'transferred',
  sold: 'sold',
};

/**
 * Horizontal chain-of-custody timeline for a single inscription. One dot per
 * event, positioned by `block_timestamp`, colored by event type. Complements
 * the textual EventTimelineRow list rendered below it on the detail page.
 *
 * Endpoint labels live in HTML so they don't stretch with the SVG's
 * `preserveAspectRatio="none"`.
 */
export default function MovementTimeline({ events }: { events: EventRow[] }) {
  if (events.length === 0) return null;

  const sorted = [...events].sort((a, b) => a.block_timestamp - b.block_timestamp);
  const tFirst = sorted[0].block_timestamp;
  const tLast = sorted[sorted.length - 1].block_timestamp;
  // SSR-only chart: server time is the right "now" for the now-marker.
  // eslint-disable-next-line react-hooks/purity
  const now = Math.floor(Date.now() / 1000);
  const tMin = tFirst;
  const tMax = Math.max(tLast, now);
  const tSpan = Math.max(1, tMax - tMin);

  const lineY = VB_H / 2;
  const x = (t: number) => ((t - tMin) / tSpan) * VB_W;

  const counts = sorted.reduce<Record<string, number>>((acc, e) => {
    acc[e.event_type] = (acc[e.event_type] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="border border-ink-2 bg-ink-1 px-3 py-3 font-mono mb-6">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-[11px] tracking-[0.12em] uppercase text-bone">movement timeline</h3>
        <span className="text-[9px] tracking-[0.08em] uppercase text-bone-dim">
          {sorted.length} {sorted.length === 1 ? 'event' : 'events'}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        className="w-full h-[40px] block"
        role="img"
        aria-label="Movement timeline"
      >
        <line
          x1={0}
          x2={VB_W}
          y1={lineY}
          y2={lineY}
          stroke="#7a7a75"
          strokeWidth="1"
          opacity="0.6"
          vectorEffect="non-scaling-stroke"
        />
        <line
          x1={x(now)}
          x2={x(now)}
          y1={lineY - 8}
          y2={lineY + 8}
          stroke="#7a7a75"
          strokeWidth="1"
          strokeDasharray="2,2"
          vectorEffect="non-scaling-stroke"
        />
        {sorted.map(ev => {
          const cx = x(ev.block_timestamp);
          const fill = EVENT_COLOR[ev.event_type] ?? '#bfbfbf';
          return (
            <circle key={ev.id} cx={cx} cy={lineY} r={4} fill={fill}>
              <title>{`${EVENT_LABEL[ev.event_type] ?? ev.event_type} · ${fullDate(ev.block_timestamp)}`}</title>
            </circle>
          );
        })}
      </svg>
      <div className="flex justify-between mt-1 text-[9px] tracking-[0.08em] uppercase text-bone-dim">
        <span>{monthYear(tMin)}</span>
        <span>now</span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[10px] tracking-[0.08em] uppercase text-bone-dim">
        {(['inscribed', 'sold', 'transferred'] as const)
          .filter(t => counts[t])
          .map(t => (
            <div key={t} className="flex items-center gap-1.5">
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ backgroundColor: EVENT_COLOR[t] }}
                aria-hidden
              />
              <span>{EVENT_LABEL[t]}</span>
              <span className="text-bone tabular-nums">{counts[t]}</span>
            </div>
          ))}
      </div>
    </div>
  );
}
