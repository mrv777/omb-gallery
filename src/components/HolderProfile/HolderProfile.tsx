import Link from 'next/link';
import type { EventRow, InscriptionRow, OwnershipDeltaRow } from '@/lib/db';
import type { HolderColorHighlight } from '@/lib/holderEvents';
import { lookupInscription } from '@/lib/inscriptionLookup';
import { addressLink, ordNetWalletLink, truncateAddr } from '@/lib/format';
import { lookupWalletLabel } from '@/lib/walletLabels';
import { WalletsList } from './WalletsList';
import SafeImg from '@/components/SafeImg';
import ColorPortfolioBar from '@/components/Charts/ColorPortfolioBar';
import BagSizeOverTime from '@/components/Charts/BagSizeOverTime';
import HolderActivityList from './HolderActivityList';
import { Tooltip } from '../ui/Tooltip';

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
  /** Cursor (encoded `${ts}:${id}`) for fetching the next page of events,
   * or null if SSR already returned the entire timeline. */
  initialEventsCursor: string | null;
  tileCap: number;
  /** Full ownership-change deltas across all linked wallets (for the
   * bag-size-over-time chart). Concatenated per-wallet rows; chart sorts. */
  ownershipDeltas: OwnershipDeltaRow[];
  /** Red/blue OMB receive/send events to render as colored markers on the
   * bag-size-over-time chart. Internal transfers (between two of the user's
   * own wallets) are pre-filtered out by the page. */
  colorHighlights: HolderColorHighlight[];
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
  initialEventsCursor,
  tileCap,
  ownershipDeltas,
  colorHighlights,
}: Props) {
  // Manual identity label (treasury etc.). Looked up against any wallet in
  // the aggregated set so it's stable regardless of which sibling wallet
  // the user navigated through. Takes precedence over Matrica username so
  // curated overrides win.
  const manual = wallets.map(lookupWalletLabel).find(Boolean) ?? null;
  // Render every OMB this wallet owns. Tiles lazy-load via native <img>
  // and use `content-visibility: auto` so offscreen tiles skip layout +
  // paint until they scroll into view. Even at ~9k tiles this stays cheap
  // because the eager work is bounded to whatever's in the viewport.
  // `tileCap` is preserved as a ceiling-of-safety should we ever blow up
  // the per-wallet count, but is set high enough that the typical bag
  // sees no truncation.
  const ombShown = ombHoldings.slice(0, tileCap);
  const ombHidden = ombHoldings.length - ombShown.length;
  const bravoShown = bravoHoldings.slice(0, BRAVO_TILE_CAP);
  const bravoHidden = bravoHoldings.length - bravoShown.length;
  const linked = !!manual || !!username;

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
                {!manual && avatarUrl && (
                  <SafeImg
                    src={avatarUrl}
                    alt=""
                    loading="lazy"
                    className="w-10 h-10 rounded-sm bg-ink-2 object-cover shrink-0"
                  />
                )}
                <div className="min-w-0">
                  <h1
                    className={`text-base sm:text-lg normal-case tracking-normal truncate ${
                      manual ? 'text-accent-orange' : 'text-bone'
                    }`}
                  >
                    {manual ? manual.name : username}
                  </h1>
                  {manual?.subtitle && (
                    <div className="text-[11px] tracking-[0.08em] uppercase text-bone-dim mt-0.5">
                      {manual.subtitle}
                    </div>
                  )}
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

      {ombHoldings.length > 0 && <ColorPortfolioBar holdings={ombHoldings} />}

      <BagSizeOverTime
        deltas={ownershipDeltas}
        highlights={colorHighlights}
        currentBagSize={ombHoldings.length}
      />

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
          wallet, when aggregated) on either side. The list is a client
          component so "load more" can keyset-paginate via /api/holder/.../events
          without re-rendering the rest of the profile. */}
      <HolderActivityList
        address={address}
        wallets={wallets}
        initialEvents={events}
        initialCursor={initialEventsCursor}
        eventTotal={eventTotal}
      />
    </section>
  );
}

function OmbTile({ number }: { number: number }) {
  const hit = lookupInscription(number);
  const tileBg = hit?.color ? (COLOR_TILE_BG[hit.color] ?? 'bg-ink-2') : 'bg-ink-2';
  return (
    <Tooltip content={`#${number}`}>
    <Link
      href={`/inscription/${number}`}
      prefetch={false}
      className={`block w-20 h-20 sm:w-24 sm:h-24 ${tileBg} overflow-hidden border border-ink-2 hover:border-bone-dim transition-colors`}
      // content-visibility:auto skips layout + paint for offscreen tiles;
      // contain-intrinsic-size reserves the right slot so the flex-wrap
      // layout still resolves up-front and scroll position stays stable.
      // 96px matches the sm:w-24 tile (we use the larger value so the
      // mobile-rendered 80px tiles still land within the reserved box).
      style={{
        contentVisibility: 'auto',
        containIntrinsicSize: '96px 96px',
      }}
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
    </Tooltip>
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
    <Tooltip content={`Bravocados #${number}`}>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="block w-10 h-10 bg-ink-2 overflow-hidden border border-ink-2 hover:border-bone-dim transition-colors"
      >
        <SafeImg
          src={src}
          alt={`Bravocados #${number}`}
          loading="lazy"
          decoding="async"
          className="w-full h-full object-cover"
          fallback={
            <div className="w-full h-full flex items-center justify-center font-mono text-[8px] text-bone-dim">
              #{number}
            </div>
          }
        />
      </a>
    </Tooltip>
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

