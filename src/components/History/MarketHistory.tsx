import Link from 'next/link';
import { fullDate } from '../Charts/chartUtils';
import { formatBtc, marketplaceLabel } from '@/lib/format';
import { lookupInscription } from '@/lib/inscriptionLookup';

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
        <h3 className="font-mono text-sm text-bone uppercase tracking-[0.08em] mb-1">
          record sale per eye colour
        </h3>
        <p className="font-mono mb-4 max-w-2xl text-[11px] leading-relaxed text-bone-dim uppercase tracking-[0.08em]">
          The most any piece of each drop has changed hands for. Ordered by price, so the top row is
          also the all-time high above.
        </p>
        <ul className="space-y-px">
          {sales.map(s => {
            const hit = lookupInscription(s.number);
            return (
              <li key={s.color || s.number}>
                <Link
                  href={`/inscription/${s.number}`}
                  className="group flex items-center gap-3 border border-transparent hover:border-ink-2 hover:bg-ink-1 p-1.5 transition-colors"
                >
                  {hit ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={hit.thumbnail}
                      alt={`OMB #${s.number}`}
                      width={40}
                      height={40}
                      loading="lazy"
                      className="h-10 w-10 shrink-0 border border-ink-2"
                    />
                  ) : (
                    <span className="h-10 w-10 shrink-0 border border-ink-2 bg-ink-1" />
                  )}
                  <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5 font-mono text-[11px] uppercase tracking-[0.08em]">
                    <span className="flex w-20 shrink-0 items-center gap-1.5 text-bone-dim">
                      <span
                        className={`inline-block h-2 w-2 shrink-0 ${DOT_CLASS[s.color] ?? 'bg-bone'}`}
                        aria-hidden
                      />
                      {s.color}
                    </span>
                    <span className="w-20 shrink-0 text-bone tabular-nums">
                      {formatBtc(s.sats)}
                    </span>
                    <span className="w-24 shrink-0 text-bone-dim group-hover:text-bone">
                      #{s.number}
                    </span>
                    {/* No marketplace column: every row currently reads "Magic
                        Eden", so it adds a wrapped second line per row and no
                        information. It stays on the all-time-high card above and
                        on each piece's own page. */}
                    {s.at != null && <span className="text-bone-dim">{fullDate(s.at)}</span>}
                  </span>
                </Link>
              </li>
            );
          })}
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
