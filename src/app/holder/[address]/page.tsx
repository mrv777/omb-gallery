import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import SubpageShell from '@/components/SubpageShell';
import HolderProfile from '@/components/HolderProfile/HolderProfile';
import { getStmts, type EventRow, type InscriptionRow } from '@/lib/db';
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

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { address } = await params;
  return {
    title: `${truncateAddr(address, 8, 6)} · OMB Archive`,
    description: `Holdings and on-chain activity for ${truncateAddr(address, 8, 6)}.`,
  };
}

export default async function HolderPage({ params }: { params: Promise<Params> }) {
  const { address: addressRaw } = await params;
  if (!addressRaw || addressRaw.length > MAX_ADDR_LEN) notFound();
  // Trust the URL param verbatim — bech32 is case-sensitive, and the DB
  // stores whatever ord returned. Don't normalize.
  const address = addressRaw;

  const stmts = getStmts();

  const ombHoldings = stmts.getInscriptionsByOwner.all({
    owner: address,
    collection: 'omb',
  }) as InscriptionRow[];

  const bravoHoldings = stmts.getInscriptionsByOwner.all({
    owner: address,
    collection: 'bravocados',
  }) as InscriptionRow[];

  const eventCount = (stmts.countEventsByAddress.get({ owner: address }) as { n: number }).n;

  // Show a real 404 only when nothing in the DB references this address —
  // a wallet that emptied out (no current holdings but has past events)
  // should still render so users can see the activity.
  if (ombHoldings.length === 0 && bravoHoldings.length === 0 && eventCount === 0) {
    notFound();
  }

  const events = stmts.getEventsByAddress.all({
    owner: address,
    limit: 50,
  }) as EventRow[];

  return (
    <SubpageShell>
      <HolderProfile
        address={address}
        ombHoldings={ombHoldings}
        bravoHoldings={bravoHoldings}
        events={events}
        eventTotal={eventCount}
        tileCap={TILE_CAP}
      />
    </SubpageShell>
  );
}
