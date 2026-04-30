import Link from 'next/link';
import type { EventRow, InscriptionRow } from '@/lib/db';
import { lookupInscription } from '@/lib/inscriptionLookup';
import {
  formatBtc,
  formatRelTime,
  ordinalsLink,
  satflowInscriptionLink,
  truncateAddr,
} from '@/lib/format';
import EventTimelineRow from './EventTimelineRow';
import NotificationButton, { BellIcon } from '@/components/NotificationButton/NotificationButton';
import MovementTimeline from '@/components/Charts/MovementTimeline';
import { Tooltip } from '../ui/Tooltip';

const COLOR_TILE_BG: Record<string, string> = {
  red: 'bg-accent-red/20',
  blue: 'bg-accent-blue/20',
  green: 'bg-accent-green/20',
  orange: 'bg-accent-orange/20',
  black: 'bg-accent-black/10',
};

type Props = {
  inscription: InscriptionRow;
  events: EventRow[];
  /** Unix timestamp of the most recent movement (or mint, if never moved). */
  heldSince: number | null;
  /** Other inscription numbers owned by the current owner. */
  ownerOthers: number[];
  /** True when there are more holdings than ownerOthers includes. */
  ownerOthersHasMore: boolean;
};

export default function InscriptionDetail({
  inscription,
  events,
  heldSince,
  ownerOthers,
  ownerOthersHasMore,
}: Props) {
  const hit = lookupInscription(inscription.inscription_number);
  const tileBg = hit?.color ? (COLOR_TILE_BG[hit.color] ?? 'bg-ink-2') : 'bg-ink-2';
  const ordLink = ordinalsLink(inscription.inscription_id, inscription.inscription_number);
  const satflowLink = satflowInscriptionLink(inscription.inscription_id);
  const currentTxid = inscription.current_output ? inscription.current_output.split(':')[0] : null;
  const totalEvents = events.length;
  const transferCount = inscription.transfer_count ?? 0;
  const saleCount = inscription.sale_count ?? 0;

  return (
    <section className="px-4 sm:px-6 pb-16 max-w-6xl mx-auto">
      <Link
        href="/activity"
        className="inline-block font-mono text-[11px] tracking-[0.08em] uppercase text-bone-dim hover:text-bone mb-6"
      >
        ← back to activity
      </Link>

      {/* Hero: image + meta */}
      <div className="grid grid-cols-1 md:grid-cols-[18rem_1fr] gap-6 mb-10">
        <div className={`relative ${tileBg} border border-ink-2 aspect-square w-full md:w-72`}>
          {hit ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={hit.full}
              alt={`Inscription ${inscription.inscription_number}`}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center font-mono text-bone-dim">
              #{inscription.inscription_number}
            </div>
          )}
        </div>

        <div className="font-mono">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-2">
            <h1 className="text-2xl sm:text-3xl text-bone tabular-nums">
              #{inscription.inscription_number.toLocaleString()}
            </h1>
            {hit?.color && (
              <span className="text-[10px] tracking-[0.12em] uppercase text-bone-dim border border-bone-dim/40 px-1.5 py-0.5">
                {hit.color}
              </span>
            )}
          </div>

          {hit?.description && (
            <p className="text-xs text-bone-dim mb-4 normal-case tracking-normal italic">
              {hit.description}
            </p>
          )}

          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3 text-[11px] tracking-[0.08em] uppercase text-bone-dim mb-5">
            <Stat label="transfers" value={transferCount.toLocaleString()} />
            <Stat label="sales" value={saleCount.toLocaleString()} />
            <Stat label="volume" value={formatBtc(inscription.total_volume_sats) || '—'} />
            <Stat label="highest" value={formatBtc(inscription.highest_sale_sats) || '—'} />
          </dl>

          <div className="text-[11px] tracking-[0.08em] uppercase text-bone-dim space-y-1.5 mb-5">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span>owner</span>
              {inscription.current_owner ? (
                <Tooltip content={inscription.current_owner}>
                  <Link
                    href={`/holder/${inscription.current_owner}`}
                    prefetch={false}
                    className="text-bone hover:text-accent-orange normal-case tracking-normal"
                  >
                    {truncateAddr(inscription.current_owner, 10, 8)}
                  </Link>
                </Tooltip>
              ) : (
                <span className="text-bone-dim">—</span>
              )}
              {heldSince != null && inscription.current_owner && (
                <Tooltip content={new Date(heldSince * 1000).toISOString()}>
                  <span className="text-bone-dim normal-case tracking-normal">
                    · held {formatRelTime(heldSince)}
                  </span>
                </Tooltip>
              )}
            </div>
            {inscription.current_output && (
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span>output</span>
                <Tooltip content={inscription.current_output}>
                  <span className="text-bone normal-case tracking-normal break-all">
                    {(() => {
                      const [txid, vout] = inscription.current_output.split(':');
                      return vout != null
                        ? `${txid.slice(0, 16)}…:${vout}`
                        : inscription.current_output;
                    })()}
                  </span>
                </Tooltip>
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2 text-[10px] tracking-[0.12em] uppercase">
            <a
              href={ordLink}
              target="_blank"
              rel="noopener noreferrer"
              className="border border-ink-2 hover:border-bone-dim px-2 py-1 text-bone-dim hover:text-bone"
            >
              ordinals.com ↗
            </a>
            {satflowLink && (
              <a
                href={satflowLink}
                target="_blank"
                rel="noopener noreferrer"
                className="border border-ink-2 hover:border-bone-dim px-2 py-1 text-bone-dim hover:text-bone"
              >
                satflow ↗
              </a>
            )}
            {currentTxid && (
              <a
                href={`https://memepool.space/tx/${currentTxid}`}
                target="_blank"
                rel="noopener noreferrer"
                className="border border-ink-2 hover:border-bone-dim px-2 py-1 text-bone-dim hover:text-bone"
              >
                memepool ↗
              </a>
            )}
            {hit && (
              <a
                href={hit.full}
                target="_blank"
                rel="noopener noreferrer"
                className="border border-ink-2 hover:border-bone-dim px-2 py-1 text-bone-dim hover:text-bone"
              >
                full image ↗
              </a>
            )}
            <NotificationButton
              kind="inscription"
              targetKey={String(inscription.inscription_number)}
              label={
                <span className="inline-flex items-center gap-1.5">
                  <BellIcon />
                  <span>Watch</span>
                </span>
              }
              className="inline-flex items-center border border-ink-2 hover:border-bone-dim px-2 py-1 text-bone-dim hover:text-bone"
            />
          </div>
        </div>
      </div>

      {events.length > 1 && <MovementTimeline events={events} />}

      {/* Activity timeline */}
      <div>
        <div className="font-mono text-[11px] tracking-[0.08em] uppercase text-bone-dim mb-3">
          activity <span className="text-bone tabular-nums">{totalEvents.toLocaleString()}</span>{' '}
          {totalEvents === 1 ? 'event' : 'events'}
        </div>

        {events.length === 0 ? (
          <div className="font-mono text-xs tracking-[0.08em] uppercase text-bone-dim py-12 text-center border border-ink-2">
            no recorded activity yet · indexer warming up
          </div>
        ) : (
          <div className="border border-ink-2 bg-ink-0">
            {events.map(ev => (
              <EventTimelineRow key={ev.id} event={ev} />
            ))}
          </div>
        )}
      </div>

      {ownerOthers.length > 0 && inscription.current_owner && (
        <div className="mt-10">
          <div className="font-mono text-[11px] tracking-[0.08em] uppercase text-bone-dim mb-3">
            also held by{' '}
            <Tooltip content={inscription.current_owner}>
              <Link
                href={`/holder/${inscription.current_owner}`}
                prefetch={false}
                className="text-bone hover:text-accent-orange normal-case tracking-normal"
              >
                {truncateAddr(inscription.current_owner, 8, 6)}
              </Link>
            </Tooltip>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            {ownerOthers.map(n => {
              const otherHit = lookupInscription(n);
              const otherTileBg = otherHit?.color
                ? (COLOR_TILE_BG[otherHit.color] ?? 'bg-ink-2')
                : 'bg-ink-2';
              return (
                <Tooltip key={n} content={`#${n}`}>
                <Link
                  href={`/inscription/${n}`}
                  prefetch={false}
                  className={`block w-16 h-16 ${otherTileBg} overflow-hidden border border-ink-2 hover:border-bone-dim transition-colors`}
                >
                  {otherHit ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={otherHit.thumbnail}
                      alt={`#${n}`}
                      loading="lazy"
                      decoding="async"
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center font-mono text-[9px] text-bone-dim">
                      #{n}
                    </div>
                  )}
                </Link>
                </Tooltip>
              );
            })}
            {ownerOthersHasMore && (
              <span className="font-mono text-[10px] tracking-[0.08em] uppercase text-bone-dim self-center px-2">
                + more
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-bone-dim">{label}</dt>
      <dd className="text-bone normal-case tracking-normal tabular-nums mt-0.5">{value}</dd>
    </div>
  );
}
