import Link from 'next/link';
import type { EventRow, InscriptionRow } from '@/lib/db';
import { lookupInscription } from '@/lib/inscriptionLookup';
import {
  addressLink,
  formatBtc,
  formatRelTime,
  marketplaceLabel,
  memepoolTxLink,
  ordNetWalletLink,
  truncateAddr,
} from '@/lib/format';
import { WalletsList } from './WalletsList';

const COLOR_TILE_BG: Record<string, string> = {
  red: 'bg-accent-red/20',
  blue: 'bg-accent-blue/20',
  green: 'bg-accent-green/20',
  orange: 'bg-accent-orange/20',
  black: 'bg-accent-black/10',
};

// Bravocados thumbnails come straight from ordinals.com — there's no local
// optimized variant. Limit how many we render before collapsing into a
// summary tail, since each is full-resolution content.
const BRAVO_TILE_CAP = 60;

type Props = {
  address: string;
  /** Every wallet aggregated into this view. Always includes `address`.
   * When a Matrica user is linked, also includes their other wallets we've
   * indexed. Single-element when no Matrica profile or only one wallet linked. */
  wallets: string[];
  username: string | null;
  avatarUrl: string | null;
  ombHoldings: InscriptionRow[];
  bravoHoldings: InscriptionRow[];
  events: EventRow[];
  eventTotal: number;
  tileCap: number;
};

export default function HolderProfile({
  address,
  wallets,
  username,
  avatarUrl,
  ombHoldings,
  bravoHoldings,
  events,
  eventTotal,
  tileCap,
}: Props) {
  const ombShown = ombHoldings.slice(0, tileCap);
  const ombHidden = ombHoldings.length - ombShown.length;
  const bravoShown = bravoHoldings.slice(0, BRAVO_TILE_CAP);
  const bravoHidden = bravoHoldings.length - bravoShown.length;
  const linked = !!username;

  return (
    <section className="px-4 sm:px-6 pb-16 max-w-6xl mx-auto">
      <Link
        href="/explorer"
        className="inline-block font-mono text-[11px] tracking-[0.08em] uppercase text-bone-dim hover:text-bone mb-6"
      >
        ← back to explorer
      </Link>

      <div className="border border-ink-2 bg-ink-1 px-4 sm:px-5 py-4 mb-8 font-mono">
        {linked ? (
          // ── User-centric header. Address is incidental (we got here via
          // one of N wallets); the wallets list below treats them all as peers.
          <>
            <div className="flex items-start justify-between gap-4 mb-4">
              <div className="flex items-center gap-3 min-w-0">
                {avatarUrl && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={avatarUrl}
                    alt=""
                    loading="lazy"
                    className="w-10 h-10 rounded-sm bg-ink-2 object-cover shrink-0"
                  />
                )}
                <div className="min-w-0">
                  <h1 className="text-base sm:text-lg text-bone normal-case tracking-normal truncate">
                    {username}
                  </h1>
                  <div className="text-[10px] text-bone-dim tracking-[0.08em] uppercase">
                    via matrica
                  </div>
                </div>
              </div>
            </div>
            <dl className="grid grid-cols-3 gap-x-4 text-[11px] tracking-[0.08em] uppercase text-bone-dim mb-4">
              <Stat label="OMB" value={ombHoldings.length.toLocaleString()} />
              <Stat label="bravocados" value={bravoHoldings.length.toLocaleString()} />
              <Stat label="events" value={eventTotal.toLocaleString()} />
            </dl>
            <WalletsList wallets={wallets} />
          </>
        ) : (
          // ── Wallet-centric header (no Matrica profile). Today's layout.
          <>
            <h1 className="tabular-nums text-bone text-lg sm:text-xl mb-2">
              {truncateAddr(address, 10, 8)}
            </h1>
            <div className="text-[10px] tracking-normal text-bone-dim break-all mb-4 normal-case select-all">
              {address}
            </div>
            <dl className="grid grid-cols-3 gap-x-4 text-[11px] tracking-[0.08em] uppercase text-bone-dim mb-4">
              <Stat label="OMB" value={ombHoldings.length.toLocaleString()} />
              <Stat label="bravocados" value={bravoHoldings.length.toLocaleString()} />
              <Stat label="events" value={eventTotal.toLocaleString()} />
            </dl>
            <div className="flex flex-wrap gap-2 text-[10px] tracking-[0.12em] uppercase">
              <a
                href={ordNetWalletLink(address)}
                target="_blank"
                rel="noopener noreferrer"
                className="border border-ink-2 hover:border-bone-dim px-2 py-1 text-bone-dim hover:text-bone"
              >
                ord.net ↗
              </a>
              <a
                href={addressLink(address)}
                target="_blank"
                rel="noopener noreferrer"
                className="border border-ink-2 hover:border-bone-dim px-2 py-1 text-bone-dim hover:text-bone"
              >
                ord.io ↗
              </a>
            </div>
          </>
        )}
      </div>

      {/* OMB holdings — primary surface */}
      <div className="mb-12">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="font-mono text-xs tracking-[0.12em] uppercase text-bone">
            OMB <span className="text-bone-dim tabular-nums">· {ombHoldings.length}</span>
          </h2>
          {ombHidden > 0 && (
            <span className="font-mono text-[10px] tracking-[0.08em] uppercase text-bone-dim">
              showing first {tileCap}
            </span>
          )}
        </div>
        {ombHoldings.length === 0 ? (
          <div className="font-mono text-xs tracking-[0.08em] uppercase text-bone-dim py-8 text-center border border-ink-2">
            no OMBs held
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {ombShown.map(row => (
              <OmbTile key={row.inscription_number} number={row.inscription_number} />
            ))}
            {ombHidden > 0 && (
              <span className="font-mono text-[10px] tracking-[0.08em] uppercase text-bone-dim self-center px-2">
                +{ombHidden.toLocaleString()} more
              </span>
            )}
          </div>
        )}
      </div>

      {/* Bravocados — secondary surface, intentionally muted */}
      {bravoHoldings.length > 0 && (
        <div className="mb-12 opacity-90">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="font-mono text-[11px] tracking-[0.12em] uppercase text-bone-dim">
              also holds bravocados{' '}
              <span className="text-bone-dim tabular-nums">· {bravoHoldings.length}</span>
            </h2>
            {bravoHidden > 0 && (
              <span className="font-mono text-[10px] tracking-[0.08em] uppercase text-bone-dim">
                showing first {BRAVO_TILE_CAP}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {bravoShown.map(row => (
              <BravocadosTile
                key={row.inscription_number}
                number={row.inscription_number}
                inscriptionId={row.inscription_id}
              />
            ))}
            {bravoHidden > 0 && (
              <span className="font-mono text-[10px] tracking-[0.08em] uppercase text-bone-dim self-center px-2">
                +{bravoHidden.toLocaleString()} more
              </span>
            )}
          </div>
        </div>
      )}

      {/* Activity timeline — events involving this address (or any sibling
          wallet, when aggregated) on either side. */}
      <div>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="font-mono text-xs tracking-[0.12em] uppercase text-bone">
            recent activity{' '}
            <span className="text-bone-dim tabular-nums">· {eventTotal.toLocaleString()}</span>
          </h2>
          {events.length < eventTotal && (
            <span className="font-mono text-[10px] tracking-[0.08em] uppercase text-bone-dim">
              showing first {events.length}
            </span>
          )}
        </div>
        {events.length === 0 ? (
          <div className="font-mono text-xs tracking-[0.08em] uppercase text-bone-dim py-8 text-center border border-ink-2">
            no recorded activity yet
          </div>
        ) : (
          <div className="border border-ink-2 bg-ink-0">
            {events.map(ev => (
              <HolderEventRow key={ev.id} event={ev} wallets={wallets} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function OmbTile({ number }: { number: number }) {
  const hit = lookupInscription(number);
  const tileBg = hit?.color ? (COLOR_TILE_BG[hit.color] ?? 'bg-ink-2') : 'bg-ink-2';
  return (
    <Link
      href={`/inscription/${number}`}
      prefetch={false}
      className={`block w-20 h-20 sm:w-24 sm:h-24 ${tileBg} overflow-hidden border border-ink-2 hover:border-bone-dim transition-colors`}
      title={`#${number}`}
    >
      {hit ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={hit.thumbnail}
          alt={`#${number}`}
          loading="lazy"
          decoding="async"
          className="w-full h-full object-cover"
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center font-mono text-[10px] text-bone-dim">
          #{number}
        </div>
      )}
    </Link>
  );
}

function BravocadosTile({
  number,
  inscriptionId,
}: {
  number: number;
  inscriptionId: string | null;
}) {
  // No /inscription/[n] page exists for non-OMB collections yet, so link out
  // to ordinals.com. Switch to internal once Phase 5 parametrizes it.
  const href = inscriptionId
    ? `https://ordinals.com/inscription/${inscriptionId}`
    : `https://ordinals.com/inscription/${number}`;
  const src = inscriptionId
    ? `https://ordinals.com/content/${inscriptionId}`
    : null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="block w-10 h-10 bg-ink-2 overflow-hidden border border-ink-2 hover:border-bone-dim transition-colors"
      title={`Bravocados #${number}`}
    >
      {src ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={src}
          alt={`Bravocados #${number}`}
          loading="lazy"
          decoding="async"
          className="w-full h-full object-cover"
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center font-mono text-[8px] text-bone-dim">
          #{number}
        </div>
      )}
    </a>
  );
}

function HolderEventRow({ event, wallets }: { event: EventRow; wallets: string[] }) {
  const hit = lookupInscription(event.inscription_number);
  const tileBg = hit?.color ? (COLOR_TILE_BG[hit.color] ?? 'bg-ink-2') : 'bg-ink-2';

  const isSold = event.event_type === 'sold';
  const isTransferred = event.event_type === 'transferred';
  const eventLabel = isSold ? 'SOLD' : isTransferred ? 'TRANSFERRED' : 'INSCRIBED';
  const eventColor = isSold
    ? 'text-accent-green'
    : isTransferred
      ? 'text-bone-dim'
      : 'text-accent-orange';
  const eventBg = isSold
    ? 'bg-accent-green/10 border-accent-green/40'
    : isTransferred
      ? 'border-bone-dim/40'
      : 'bg-accent-orange/10 border-accent-orange/40';

  // Direction relative to the user (any of their linked wallets counts as
  // "self"). When both sides are the user's own wallets, it's an internal
  // transfer — neither outgoing nor incoming, no counter-party shown.
  const selfSet = wallets;
  const oldIsSelf = event.old_owner != null && selfSet.includes(event.old_owner);
  const newIsSelf = event.new_owner != null && selfSet.includes(event.new_owner);
  const isOutgoing = oldIsSelf && !newIsSelf;
  const isIncoming = newIsSelf && !oldIsSelf;
  const isInternal = oldIsSelf && newIsSelf;
  const counterParty = isOutgoing ? event.new_owner : isIncoming ? event.old_owner : null;
  const directionLabel = isOutgoing
    ? 'sent →'
    : isIncoming
      ? '← received'
      : isInternal
        ? 'internal'
        : '';

  const priceStr = isSold ? formatBtc(event.sale_price_sats) : '';
  const market = isSold ? marketplaceLabel(event.marketplace) : '';
  const txLink = memepoolTxLink(event.txid);
  const inscriptionLink = `/inscription/${event.inscription_number}`;

  return (
    <div
      className={`flex items-center gap-x-3 sm:gap-x-4 px-2 sm:px-4 py-2 border-b border-ink-2 ${
        isSold ? 'bg-accent-green/[0.03]' : ''
      }`}
    >
      <Link
        href={inscriptionLink}
        prefetch={false}
        className={`block w-12 h-12 ${tileBg} overflow-hidden border border-ink-2 hover:border-bone-dim shrink-0`}
        title={`#${event.inscription_number}`}
      >
        {hit ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={hit.thumbnail}
            alt={`#${event.inscription_number}`}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center font-mono text-[9px] text-bone-dim">
            #{event.inscription_number}
          </div>
        )}
      </Link>

      <Link
        href={inscriptionLink}
        prefetch={false}
        className="font-mono text-xs text-bone tabular-nums hover:text-accent-orange w-20 shrink-0"
      >
        #{event.inscription_number}
      </Link>

      <div className="flex items-center gap-2 shrink-0">
        <span
          className={`font-mono text-[10px] tracking-[0.12em] uppercase px-1.5 py-0.5 border ${eventBg} ${eventColor} whitespace-nowrap`}
        >
          {eventLabel}
        </span>
        {priceStr && (
          <span className="font-mono text-xs text-accent-green tabular-nums whitespace-nowrap">
            {priceStr}
          </span>
        )}
        {market && (
          <span className="hidden sm:inline font-mono text-[10px] text-bone-dim tracking-normal whitespace-nowrap">
            via {market}
          </span>
        )}
      </div>

      <div className="hidden sm:flex items-center gap-1.5 font-mono text-[11px] text-bone-dim min-w-0">
        {directionLabel && (
          <span className="text-bone-dim/80 shrink-0 normal-case tracking-normal">
            {directionLabel}
          </span>
        )}
        {counterParty ? (
          <Link
            href={`/holder/${counterParty}`}
            prefetch={false}
            className="hover:text-accent-orange truncate normal-case tracking-normal"
            title={counterParty}
          >
            {truncateAddr(counterParty)}
          </Link>
        ) : null}
      </div>

      <div className="flex items-center gap-3 ml-auto shrink-0">
        {txLink && (
          <a
            href={txLink}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:inline font-mono text-[10px] text-bone-dim hover:text-accent-orange tracking-[0.08em] uppercase"
            title={`tx ${event.txid}`}
          >
            tx
          </a>
        )}
        <span
          className="font-mono text-[10px] text-bone-dim tracking-normal whitespace-nowrap"
          title={new Date(event.block_timestamp * 1000).toISOString()}
        >
          {formatRelTime(event.block_timestamp)}
        </span>
      </div>
    </div>
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

