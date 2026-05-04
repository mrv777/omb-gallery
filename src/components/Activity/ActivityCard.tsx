'use client';

import { memo } from 'react';
import Link from 'next/link';
import type { ApiEvent } from './types';
import { lookupInscription } from '@/lib/inscriptionLookup';
import {
  formatBtc,
  formatRelTime,
  marketplaceLabel,
  ordinalsLink,
  truncateAddr,
} from '@/lib/format';
import SafeImg from '@/components/SafeImg';
import { Tooltip } from '../ui/Tooltip';

// Per-event-type display config. Keeps the JSX below readable instead of
// six nested ternaries. Subtitle is a short human caption shown under the
// type label (e.g. "collateral locked in escrow").
const EVENT_DISPLAY: Record<
  ApiEvent['event_type'],
  { label: string; color: string; subtitle?: string }
> = {
  sold:               { label: 'SOLD',            color: 'text-accent-green' },
  transferred:        { label: 'TRANSFERRED',     color: 'text-bone' },
  inscribed:          { label: 'INSCRIBED',       color: 'text-bone-dim' },
  'loan-originated':  { label: 'LOAN ORIGINATED', color: 'text-accent-blue',   subtitle: 'collateral locked in escrow' },
  'loan-defaulted':   { label: 'LOAN DEFAULTED',  color: 'text-accent-red',    subtitle: 'lender claimed collateral' },
  'loan-repaid':      { label: 'LOAN REPAID',     color: 'text-accent-blue',   subtitle: 'borrower paid lender' },
  'loan-unlocked':    { label: 'LOAN UNLOCKED',   color: 'text-accent-orange', subtitle: 'borrower reclaimed collateral' },
};

// Loan amount lives in raw_json.loan_amount_sats for loan-originated rows.
// Defaults don't carry a loan amount (we only know it from the origination
// trace, which the script doesn't replicate onto the default row).
function loanAmountSats(event: ApiEvent): number | null {
  if (event.event_type !== 'loan-originated' || !event.raw_json) return null;
  try {
    const rj = JSON.parse(event.raw_json) as { loan_amount_sats?: number };
    return typeof rj.loan_amount_sats === 'number' ? rj.loan_amount_sats : null;
  } catch {
    return null;
  }
}

const COLOR_TILE_BG: Record<string, string> = {
  red: 'bg-accent-red/20',
  blue: 'bg-accent-blue/20',
  green: 'bg-accent-green/20',
  orange: 'bg-accent-orange/20',
  black: 'bg-accent-black/10',
};

const OWNER_VISIBLE_TYPES = new Set<ApiEvent['event_type']>([
  'transferred',
  'loan-originated',
  'loan-defaulted',
  'loan-repaid',
  'loan-unlocked',
]);

type Props = { event: ApiEvent };

const ActivityCard = memo(function ActivityCard({ event }: Props) {
  const hit = lookupInscription(event.inscription_number);
  const isOmb = hit?.kind === 'omb';
  const isExternal = hit?.external ?? false;
  // OMB hits open the full local image; bravocado / unknown rows open the
  // ordinals.com inscription page in a new tab.
  const link = isOmb ? hit.full : ordinalsLink(event.inscription_id, event.inscription_number);
  const tileBg = hit && hit.color ? (COLOR_TILE_BG[hit.color] ?? 'bg-ink-2') : 'bg-ink-2';

  const display = EVENT_DISPLAY[event.event_type];

  const loanSats = loanAmountSats(event);
  const priceStr =
    event.event_type === 'sold' ? formatBtc(event.sale_price_sats)
    : loanSats != null ? formatBtc(loanSats)
    : '';
  const market = event.event_type === 'sold' ? marketplaceLabel(event.marketplace) : '';

  const showOwners = OWNER_VISIBLE_TYPES.has(event.event_type) && !!(event.old_owner || event.new_owner);

  return (
    <div className="group block border border-ink-2 hover:border-bone-dim transition-colors bg-ink-1">
      <a href={link} target="_blank" rel="noopener noreferrer" className="block">
        <div className={`relative aspect-square ${tileBg} overflow-hidden`}>
          {hit ? (
            isExternal ? (
              <SafeImg
                src={hit.thumbnail}
                alt={`Inscription ${event.inscription_number}`}
                loading="lazy"
                decoding="async"
                className="w-full h-full object-cover"
                fallback={
                  <div className="w-full h-full flex items-center justify-center">
                    <span className="font-mono text-bone-dim text-xs tracking-[0.12em]">
                      #{event.inscription_number}
                    </span>
                  </div>
                }
              />
            ) : (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={hit.thumbnail}
                alt={`Inscription ${event.inscription_number}`}
                loading="lazy"
                decoding="async"
                className="w-full h-full object-cover"
              />
            )
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <span className="font-mono text-bone-dim text-xs tracking-[0.12em]">
                #{event.inscription_number}
              </span>
            </div>
          )}
        </div>
        <div className="p-3 pb-1 font-mono text-[11px] tracking-[0.08em] uppercase">
          <div className="flex items-center justify-between text-bone">
            <span className="tabular-nums">#{event.inscription_number}</span>
            <span className="text-bone-dim normal-case tracking-normal">
              {formatRelTime(event.block_timestamp)}
            </span>
          </div>
          <div className={`mt-1 ${display.color}`}>
            {display.label}
            {priceStr && (
              <span className="text-bone normal-case tracking-normal"> · {priceStr}</span>
            )}
          </div>
          {event.event_type === 'sold' && market ? (
            <div className="mt-0.5 text-bone-dim normal-case tracking-normal text-[10px]">
              via {market}
            </div>
          ) : display.subtitle ? (
            <div className="mt-0.5 text-bone-dim normal-case tracking-normal text-[10px]">
              {display.subtitle}
            </div>
          ) : null}
        </div>
      </a>
      {showOwners && (
        <div className="px-3 pb-3 font-mono text-[10px] tracking-normal text-bone-dim normal-case truncate">
          {event.old_owner ? (
            <Tooltip content={event.old_owner}>
              <Link
                href={`/holder/${event.old_owner}`}
                prefetch={false}
                className="hover:text-accent-orange"
              >
                {truncateAddr(event.old_owner)}
              </Link>
            </Tooltip>
          ) : (
            <span>—</span>
          )}
          <span> → </span>
          {event.new_owner ? (
            <Tooltip content={event.new_owner}>
              <Link
                href={`/holder/${event.new_owner}`}
                prefetch={false}
                className="hover:text-accent-orange"
              >
                {truncateAddr(event.new_owner)}
              </Link>
            </Tooltip>
          ) : (
            <span>—</span>
          )}
        </div>
      )}
    </div>
  );
});

export default ActivityCard;
