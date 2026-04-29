import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import SubpageShell from '@/components/SubpageShell';
import HolderProfile from '@/components/HolderProfile/HolderProfile';
import {
  getStmts,
  type EventRow,
  type InscriptionRow,
  type WalletLinkRow,
} from '@/lib/db';
import { truncateAddr } from '@/lib/format';

type Params = { address: string };

// Bech32 / base58 addresses fit comfortably in this range. The bound exists
// only to bail fast on obviously-junk URLs (no DB hit), not to validate the
// address — bad input just renders an empty profile.
const MAX_ADDR_LEN = 100;

// Cap how many tiles we render per collection to keep DOM size reasonable
// for whales. Fits ~10 rows at the chosen tile size; anything beyond becomes
// "+N more". Activity is already capped at 50 in the prepared statement.
const TILE_CAP = 200;

// Per-wallet over-fetch when aggregating events across a Matrica user's
// linked wallets. Each call still hits the per-owner index (idx_events_*_ts_id),
// so this is bounded I/O — we only pay the cost when the user has multiple
// linked wallets, and the result is sorted+sliced down to RECENT_EVENTS_DISPLAY.
const EVENTS_PER_WALLET = 100;
const RECENT_EVENTS_DISPLAY = 50;

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { address } = await params;
  const stmts = getStmts();
  const link = stmts.getWalletLink.get({ wallet_addr: address }) as WalletLinkRow | undefined;
  // Prefer the Matrica username for the title when one's known and isn't
  // just the wallet address echoed back. Falls back cleanly otherwise.
  const display =
    link?.username && !looksLikeAddress(link.username)
      ? link.username
      : truncateAddr(address, 8, 6);
  return {
    title: `${display} · OMB Archive`,
    description: `Holdings and on-chain activity for ${display}.`,
  };
}

export default async function HolderPage({ params }: { params: Promise<Params> }) {
  const { address: addressRaw } = await params;
  if (!addressRaw || addressRaw.length > MAX_ADDR_LEN) notFound();
  // Trust the URL param verbatim — bech32 is case-sensitive, and the DB
  // stores whatever ord returned. Don't normalize.
  const address = addressRaw;

  const stmts = getStmts();

  // Look up Matrica linkage. If `link` exists with a non-null user_id, this
  // wallet belongs to a Matrica user; aggregate across all sibling wallets.
  // If `link` exists but matrica_user_id is null, we've checked and there's
  // no profile — render exactly as before. If no `link` row at all, we
  // haven't probed yet — also render as before; the matrica cron will
  // pick this address up on its next pass.
  const link = stmts.getWalletLink.get({ wallet_addr: address }) as WalletLinkRow | undefined;
  const userId = link?.matrica_user_id ?? null;

  // Wallet set we aggregate over. Always includes the URL address (even when
  // no Matrica row exists for it yet — single-wallet case). When linked, we
  // dedupe to ensure no wallet appears twice if the URL is one of the
  // already-known siblings.
  let wallets: string[] = [address];
  if (userId) {
    const siblings = stmts.getWalletsForUser.all({ user_id: userId }) as Array<{
      wallet_addr: string;
    }>;
    const set = new Set<string>([address, ...siblings.map(s => s.wallet_addr)]);
    wallets = Array.from(set);
  }

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

  // Events — same fan-out. Internal transfers between two wallets of the
  // same user surface as one event with old_owner=A new_owner=B; the SQL
  // already prevents same-row double-counting per wallet, but cross-wallet
  // we'd see the row for A AND for B. Dedup by event id to handle that.
  const eventMap = new Map<number, EventRow>();
  let eventTotalSum = 0;
  for (const w of wallets) {
    const rows = stmts.getEventsByAddress.all({
      owner: w,
      limit: EVENTS_PER_WALLET,
    }) as EventRow[];
    for (const r of rows) eventMap.set(r.id, r);
    const c = stmts.countEventsByAddress.get({ owner: w }) as { n: number };
    eventTotalSum += c.n;
  }
  const events = Array.from(eventMap.values())
    .sort((a, b) =>
      b.block_timestamp - a.block_timestamp || b.id - a.id
    )
    .slice(0, RECENT_EVENTS_DISPLAY);

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
        username={
          link?.username && !looksLikeAddress(link.username) ? link.username : null
        }
        avatarUrl={link?.avatar_url ?? null}
        ombHoldings={ombHoldings}
        bravoHoldings={bravoHoldings}
        events={events}
        eventTotal={eventTotalSum}
        tileCap={TILE_CAP}
      />
    </SubpageShell>
  );
}

function looksLikeAddress(s: string): boolean {
  return /^bc1[a-z0-9]{30,}$/i.test(s) || /^0x[a-f0-9]{40}$/i.test(s) || s.length > 30;
}
