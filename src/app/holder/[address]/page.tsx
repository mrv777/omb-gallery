import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import SubpageShell from '@/components/SubpageShell';
import HolderProfile from '@/components/HolderProfile/HolderProfile';
import {
  getStmts,
  type InscriptionRow,
  type OwnershipDeltaRow,
  type WalletLinkRow,
} from '@/lib/db';
import { truncateAddr } from '@/lib/format';
import { lookupInscription } from '@/lib/inscriptionLookup';
import { buildSocial } from '@/lib/metadata';
import { lookupWalletLabel } from '@/lib/walletLabels';
import {
  encodeCursor,
  fetchHolderColorHighlights,
  fetchHolderEventsPage,
  resolveAggregatedWallets,
} from '@/lib/holderEvents';

type Params = { address: string };

// Bech32 / base58 addresses fit comfortably in this range. The bound exists
// only to bail fast on obviously-junk URLs (no DB hit), not to validate the
// address — bad input just renders an empty profile.
const MAX_ADDR_LEN = 100;

// Cap on how many OMB tiles we render. Effectively unlimited for any real
// wallet — the largest holder in the dataset sits well below this. Tiles
// use `content-visibility: auto`, native lazy-loaded <img>, and 128w WebP
// thumbnails so even the entire collection (~9k) renders cheaply: only
// in-viewport tiles do layout, paint, and image fetch work. The cap stays
// nonzero purely as a defensive ceiling against a future catastrophic
// data shape (e.g. an indexer bug pinning every OMB to one address).
const TILE_CAP = 10_000;

// Initial event-page size delivered with SSR. Subsequent pages are loaded
// client-side via /api/holder/[address]/events, keyset-paginated by
// (block_timestamp, id). Match this to the API route's DEFAULT_LIMIT so the
// "showing N of M" math reads naturally.
const RECENT_EVENTS_DISPLAY = 50;

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { address } = await params;
  const stmts = getStmts();
  const link = stmts.getWalletLink.get({ wallet_addr: address }) as WalletLinkRow | undefined;
  // Manual label (treasury etc.) wins over Matrica handle, which wins over
  // the truncated address. Curated overrides need to be authoritative.
  const manual = lookupWalletLabel(address);
  const display = manual
    ? manual.name
    : link?.username && !looksLikeAddress(link.username)
      ? link.username
      : truncateAddr(address, 8, 6);

  // OG image cascade: Matrica avatar → first OMB the wallet holds → site
  // default. Only hit the inscriptions table when the avatar is missing,
  // which keeps the metadata cost to one indexed LIMIT-1 SELECT in the rare
  // branch. For aggregated Matrica users we look up holdings on the URL-param
  // address only — the goal is "an OMB this wallet holds" for preview, not
  // a canonical pick across siblings.
  let ogImage: string | null = link?.avatar_url ?? null;
  if (!ogImage) {
    const first = stmts.firstInscriptionByOwner.get({
      owner: address,
      collection: 'omb',
    }) as { inscription_number: number } | undefined;
    const hit = first ? lookupInscription(first.inscription_number) : null;
    if (hit) ogImage = hit.full;
  }

  const description = `Holdings and on-chain activity for ${display}.`;
  return {
    title: display,
    description,
    ...buildSocial({
      title: display,
      description,
      customImage: ogImage ? { url: ogImage, alt: display } : undefined,
    }),
  };
}

export default async function HolderPage({ params }: { params: Promise<Params> }) {
  const { address: addressRaw } = await params;
  if (!addressRaw || addressRaw.length > MAX_ADDR_LEN) notFound();
  // Trust the URL param verbatim — bech32 is case-sensitive, and the DB
  // stores whatever ord returned. Don't normalize.
  const address = addressRaw;

  const stmts = getStmts();

  // Look up Matrica linkage and resolve the wallet set we aggregate over.
  // When `matrica_user_id` is non-null, this is a multi-wallet identity and
  // we fan out across siblings; otherwise it's just `[address]`. Same logic
  // is shared with the /api/holder/[address]/events route so paginated
  // "load more" sees the same wallets.
  const { wallets, link } = resolveAggregatedWallets(address);

  // Holdings — fetch per wallet, concat, sort by inscription_number for
  // stable grid ordering. Each call walks idx_insc_owner; small N (typically 1).
  const ombHoldings: InscriptionRow[] = [];
  const bravoHoldings: InscriptionRow[] = [];
  for (const w of wallets) {
    const omb = stmts.getInscriptionsByOwner.all({
      owner: w,
      collection: 'omb',
    }) as InscriptionRow[];
    const bravo = stmts.getInscriptionsByOwner.all({
      owner: w,
      collection: 'bravocados',
    }) as InscriptionRow[];
    ombHoldings.push(...omb);
    bravoHoldings.push(...bravo);
  }
  ombHoldings.sort((a, b) => a.inscription_number - b.inscription_number);
  bravoHoldings.sort((a, b) => a.inscription_number - b.inscription_number);

  // Events — first SSR page. The same fan-out + dedupe logic powers
  // /api/holder/[address]/events for "load more" so the cursor returned here
  // is interpretable by that route. eventTotal is summed across wallets;
  // duplicates from internal transfers (same event id appearing in both
  // wallets' counts) are over-counted, but only by a small constant on a
  // typical multi-wallet identity, which is fine for the "showing N of M"
  // affordance.
  const { events, nextCursor: initialNextCursor } = fetchHolderEventsPage(
    wallets,
    null,
    RECENT_EVENTS_DISPLAY
  );
  let eventTotalSum = 0;
  for (const w of wallets) {
    const c = stmts.countEventsByAddress.get({ owner: w }) as { n: number };
    eventTotalSum += c.n;
  }
  const initialEventsCursor = initialNextCursor ? encodeCursor(initialNextCursor) : null;

  // Bag-size-over-time deltas — separate from the events list because we need
  // every event (not just the recent 50) to render the full step-line. Each
  // event involving any of our wallets contributes +1 (received) and/or -1
  // (sent); internal transfers between two of the user's wallets cancel out
  // on the chart side. Returns (event_id, timestamp, delta) so the chart can
  // correlate color highlight markers to the running bag size at that event.
  const ownershipDeltas: OwnershipDeltaRow[] = [];
  for (const w of wallets) {
    const rows = stmts.ownershipChangesByAddress.all({ owner: w }) as OwnershipDeltaRow[];
    ownershipDeltas.push(...rows);
  }

  // Red/blue eye highlights — small payload (only those two color buckets,
  // only events touching this wallet set). Dropping internal transfers
  // (sum of +1/-1 across wallet rows = 0) happens inside the helper.
  const colorHighlights = fetchHolderColorHighlights(wallets);

  // Show a real 404 only when nothing in the DB references this address —
  // a wallet that emptied out (no current holdings but has past events)
  // should still render so users can see the activity. For aggregated users,
  // we 404 only if NONE of their linked wallets has anything either.
  if (ombHoldings.length === 0 && bravoHoldings.length === 0 && eventTotalSum === 0) {
    notFound();
  }

  return (
    <SubpageShell>
      <HolderProfile
        address={address}
        wallets={wallets}
        username={link?.username && !looksLikeAddress(link.username) ? link.username : null}
        avatarUrl={link?.avatar_url ?? null}
        ombHoldings={ombHoldings}
        bravoHoldings={bravoHoldings}
        events={events}
        eventTotal={eventTotalSum}
        initialEventsCursor={initialEventsCursor}
        tileCap={TILE_CAP}
        ownershipDeltas={ownershipDeltas}
        colorHighlights={colorHighlights}
      />
    </SubpageShell>
  );
}

function looksLikeAddress(s: string): boolean {
  return /^bc1[a-z0-9]{30,}$/i.test(s) || /^0x[a-f0-9]{40}$/i.test(s) || s.length > 30;
}
