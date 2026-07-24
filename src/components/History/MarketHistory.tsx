import Link from 'next/link';
import { fullDate } from '../Charts/chartUtils';
import { formatBtc, marketplaceLabel } from '@/lib/format';

export type SaleRow = {
  number: number;
  color: string;
  sats: number;
  at: number | null;
  marketplace: string | null;
};

const DOT_CLASS: Record<string, string> = {
  red: 'bg-accent-red',
  blue: 'bg-accent-blue',
  green: 'bg-accent-green',
  orange: 'bg-accent-orange',
  black: 'bg-accent-black',
};

export default function MarketHistory({ sales }: { sales: SaleRow[] }) {
  const ath = sales[0];
  if (!ath) return null;

  return (
    <div className="space-y-6">
      <div className="border border-ink-2 bg-ink-1 p-4 sm:p-5">
        <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-bone-dim mb-1">
          all-time high sale
        </div>
        <div className="font-mono text-2xl sm:text-3xl text-bone tracking-[0.04em]">
          {formatBtc(ath.sats)}
        </div>
        <p className="font-mono mt-2 text-[11px] uppercase tracking-[0.08em] text-bone-dim">
          <Link
            href={`/inscription/${ath.number}`}
            className="text-bone hover:underline underline-offset-4"
          >
            #{ath.number}
          </Link>{' '}
          · {ath.color}
          {ath.at != null && <> · {fullDate(ath.at)}</>}
          {ath.marketplace && <> · {marketplaceLabel(ath.marketplace)}</>}
        </p>
      </div>

      <div>
        <h3 className="font-mono text-sm text-bone uppercase tracking-[0.08em] mb-3">
          highest sales on record
        </h3>
        <ul className="font-mono text-[11px] uppercase tracking-[0.08em] space-y-1.5">
          {sales.map((s, i) => (
            <li key={`${s.number}-${i}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-bone-dim w-5 shrink-0">{i + 1}</span>
              <span
                className={`inline-block h-2 w-2 shrink-0 ${DOT_CLASS[s.color] ?? 'bg-bone'}`}
                aria-hidden
              />
              <Link
                href={`/inscription/${s.number}`}
                className="text-bone hover:underline underline-offset-4 w-24 shrink-0"
              >
                #{s.number}
              </Link>
              <span className="text-bone w-20 shrink-0">{formatBtc(s.sats)}</span>
              {s.at != null && <span className="text-bone-dim">{fullDate(s.at)}</span>}
            </li>
          ))}
        </ul>
        <Link
          href="/explorer/highest-sale"
          className="font-mono mt-3 inline-block text-[10px] uppercase tracking-[0.08em] text-bone-dim hover:text-bone underline underline-offset-4"
        >
          full highest-sale leaderboard →
        </Link>
      </div>
    </div>
  );
}
