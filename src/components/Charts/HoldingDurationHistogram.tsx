import type { HoldingDurationBucketRow } from '@/lib/db';
import { shortenCount } from './chartUtils';

const BUCKETS: HoldingDurationBucketRow['bucket'][] = [
  '<1mo',
  '1-6mo',
  '6-12mo',
  '1-2y',
  '2y+',
];

const VB_W = 320;
const VB_H = 140;
const PAD_L = 24;
const PAD_R = 8;
const PAD_T = 14;
const PAD_B = 28;
const BAR_GAP = 10;

export default function HoldingDurationHistogram({
  buckets,
}: {
  buckets: HoldingDurationBucketRow[];
}) {
  const lookup = new Map(buckets.map(b => [b.bucket, b.count]));
  const counts = BUCKETS.map(b => lookup.get(b) ?? 0);
  const total = counts.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...counts);

  if (total === 0) {
    return <ChartFrame title="holding duration" subtitle="time at current address" empty />;
  }

  const innerW = VB_W - PAD_L - PAD_R;
  const innerH = VB_H - PAD_T - PAD_B;
  const slot = innerW / BUCKETS.length;
  const barW = slot - BAR_GAP;

  return (
    <ChartFrame title="holding duration" subtitle="time at current address">
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="w-full h-[140px] block"
        role="img"
        aria-label="Histogram of inscriptions by time at current address"
      >
        <line
          x1={PAD_L}
          x2={VB_W - PAD_R}
          y1={VB_H - PAD_B}
          y2={VB_H - PAD_B}
          stroke="#7a7a75"
          strokeWidth="0.5"
        />
        {counts.map((c, i) => {
          const h = c === 0 ? 0 : Math.max(2, (c / max) * innerH);
          const x = PAD_L + i * slot + BAR_GAP / 2;
          const y = VB_H - PAD_B - h;
          return (
            <g key={BUCKETS[i]}>
              <rect x={x} y={y} width={barW} height={h} fill="#2f4cff" />
              {c > 0 && (
                <text
                  x={x + barW / 2}
                  y={y - 4}
                  textAnchor="middle"
                  fontFamily="ui-monospace, Menlo, monospace"
                  fontSize="9"
                  fill="#ededea"
                >
                  {shortenCount(c)}
                </text>
              )}
              <text
                x={x + barW / 2}
                y={VB_H - PAD_B + 12}
                textAnchor="middle"
                fontFamily="ui-monospace, Menlo, monospace"
                fontSize="9"
                fill="#7a7a75"
              >
                {BUCKETS[i]}
              </text>
            </g>
          );
        })}
        <text
          x={PAD_L}
          y={VB_H - 4}
          fontFamily="ui-monospace, Menlo, monospace"
          fontSize="8"
          fill="#7a7a75"
          letterSpacing="0.08em"
        >
          SINCE LAST MOVE / MINT
        </text>
      </svg>
    </ChartFrame>
  );
}

function ChartFrame({
  title,
  subtitle,
  empty,
  children,
}: {
  title: string;
  subtitle?: string;
  empty?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="border border-ink-2 bg-ink-1 px-3 py-3 font-mono">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-[11px] tracking-[0.12em] uppercase text-bone">{title}</h3>
        {subtitle && (
          <span className="text-[9px] tracking-[0.08em] uppercase text-bone-dim">{subtitle}</span>
        )}
      </div>
      {empty ? (
        <div className="h-[140px] flex items-center justify-center text-[10px] tracking-[0.08em] uppercase text-bone-dim">
          no data yet
        </div>
      ) : (
        children
      )}
    </div>
  );
}
