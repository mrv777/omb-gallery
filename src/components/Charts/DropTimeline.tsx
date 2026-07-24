import { timeTicks } from './chartUtils';

export type DropBand = {
  color: string;
  count: number;
  /** Inscribe window — when the drop was written to chain. */
  inscribedFrom: number;
  inscribedTo: number;
  /** Distribution window — when it actually reached holders. May be absent. */
  mintedFrom: number | null;
  mintedTo: number | null;
};

const BAR_CLASS: Record<string, string> = {
  red: 'bg-accent-red',
  blue: 'bg-accent-blue',
  green: 'bg-accent-green',
  orange: 'bg-accent-orange',
  black: 'bg-accent-black',
};

const TICK_COUNT = 5;
/** A single-day window would otherwise render as a 0px-wide bar. */
const MIN_BAR_PCT = 0.9;

/**
 * Inscribe vs. distribution windows for each drop, on one shared time axis.
 *
 * The gap between the two bars is the actual story: orange was inscribed in a
 * single day and then handed out over thirteen months, while black was
 * inscribed over three weeks and distributed in two days. A table of dates
 * hides that; a shared axis makes it obvious.
 *
 * Pure HTML/CSS rather than SVG — the bars are plain percent-positioned divs,
 * so they stretch to any width without the ellipse problem that forces
 * MovementTimeline to overlay HTML on a `preserveAspectRatio="none"` chart.
 * Renders as RSC; no client bundle.
 */
export default function DropTimeline({ bands }: { bands: DropBand[] }) {
  if (bands.length === 0) return null;

  const stamps = bands.flatMap(b =>
    [b.inscribedFrom, b.inscribedTo, b.mintedFrom, b.mintedTo].filter(
      (t): t is number => typeof t === 'number'
    )
  );
  const tMin = Math.min(...stamps);
  const tMax = Math.max(...stamps);
  const span = Math.max(1, tMax - tMin);
  const pct = (t: number) => ((t - tMin) / span) * 100;
  const width = (from: number, to: number) => Math.max(MIN_BAR_PCT, pct(to) - pct(from));
  const ticks = timeTicks(tMin, tMax, TICK_COUNT);

  return (
    <div className="font-mono text-[10px] uppercase tracking-[0.08em]">
      <div className="flex items-center gap-4 mb-3 text-bone-dim">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-4 bg-bone" />
          inscribed
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-4 border border-bone-dim" />
          distributed
        </span>
      </div>

      <div className="space-y-2">
        {bands.map(b => (
          <div key={b.color} className="flex items-center gap-3">
            <span className="w-14 shrink-0 text-bone-dim">{b.color}</span>
            <div className="relative h-5 flex-1 border-l border-r border-ink-2">
              <div
                className={`absolute top-0 h-2 ${BAR_CLASS[b.color] ?? 'bg-bone'}`}
                style={{
                  left: `${pct(b.inscribedFrom)}%`,
                  width: `${width(b.inscribedFrom, b.inscribedTo)}%`,
                }}
              />
              {b.mintedFrom != null && b.mintedTo != null && (
                <div
                  className="absolute top-2.5 h-2 border border-bone-dim"
                  style={{
                    left: `${pct(b.mintedFrom)}%`,
                    width: `${width(b.mintedFrom, b.mintedTo)}%`,
                  }}
                />
              )}
            </div>
            <span className="w-12 shrink-0 text-right text-bone-dim">
              {b.count.toLocaleString()}
            </span>
          </div>
        ))}
      </div>

      <div className="relative mt-2 ml-[4.25rem] mr-[3.75rem] h-4 text-bone-dim">
        {ticks.map(t => (
          <span
            key={t.t}
            className="absolute whitespace-nowrap"
            style={{ left: `${t.pct}%`, transform: 'translateX(-50%)' }}
          >
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}
