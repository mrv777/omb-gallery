import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getStmts, type EventRow, type InscriptionRow } from '@/lib/db';
import { lookupInscription } from '@/lib/inscriptionLookup';
import SubpageShell from '@/components/SubpageShell';
import InscriptionDetail from '@/components/InscriptionDetail/InscriptionDetail';
import { buildSocial } from '@/lib/metadata';
import { estimateLoanExpiration, type LoanExpirationEstimate } from '@/lib/loanExpiration';

type Params = { number: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { number } = await params;
  const num = parseInt(number, 10);
  if (!Number.isFinite(num)) return { title: 'Inscription' };
  const hit = lookupInscription(num);
  const description = hit?.description
    ? `OMB #${num} — ${hit.description}`
    : `On-chain history for OMB inscription #${num}.`;
  const title = `OMB #${num}`;
  return {
    title: `#${num}`,
    description,
    ...buildSocial({
      title,
      description,
      customImage: hit ? { url: hit.full, width: 336, height: 336, alt: title } : undefined,
    }),
  };
}

export default async function InscriptionPage({ params }: { params: Promise<Params> }) {
  const { number } = await params;
  const num = parseInt(number, 10);
  if (!Number.isFinite(num) || num < 0) notFound();

  const stmts = getStmts();
  // This route is OMB-specific (it pulls thumbnail metadata from
  // inscriptionLookup, which is OMB-only). Phase 5 will add a collection-
  // parameterized variant for Bravocados et al.
  const inscription = stmts.getInscription.get({
    inscription_number: num,
    collection: 'omb',
  }) as InscriptionRow | undefined;
  if (!inscription) notFound();

  const events = stmts.getAllInscriptionEvents.all(num) as EventRow[];

  // "Other OMBs by this owner" — fetch one extra so we can show a "+N more" hint
  // without paying for a separate COUNT query.
  const OWNER_OTHERS_DISPLAY = 100;
  const rawOwnerOthers = inscription.current_owner
    ? (stmts.otherInscriptionsByOwner.all({
        owner: inscription.current_owner,
        exclude: num,
        limit: OWNER_OTHERS_DISPLAY + 1,
        collection: 'omb',
      }) as { inscription_number: number }[])
    : [];
  const ownerOthers = rawOwnerOthers.slice(0, OWNER_OTHERS_DISPLAY).map(r => r.inscription_number);
  const ownerOthersHasMore = rawOwnerOthers.length > OWNER_OTHERS_DISPLAY;

  // "Held since": prefer the most recent move (events[0]); fall back to the
  // inscription's mint timestamp for OMBs that have never moved.
  const heldSince = events.length > 0 ? events[0].block_timestamp : inscription.inscribe_at;

  // Active-loan expiration estimate. Only meaningful when active_loan_count > 0;
  // we still pass it through so the component can render a "loan in progress"
  // callout with an estimated date.
  let activeLoanEstimate:
    | (LoanExpirationEstimate & {
        started_at: number;
        lender_vault: string | null;
      })
    | null = null;
  if ((inscription.active_loan_count ?? 0) > 0) {
    const lastOrig = events
      .filter(e => e.event_type === 'loan-originated')
      .sort((a, b) => b.id - a.id)[0];
    if (lastOrig && typeof lastOrig.block_timestamp === 'number') {
      let lender: string | null = null;
      try {
        const rj = JSON.parse(lastOrig.raw_json ?? 'null') as { lender_addr?: unknown };
        if (typeof rj?.lender_addr === 'string') lender = rj.lender_addr;
      } catch {
        // ignore
      }
      const est = estimateLoanExpiration({
        originationTs: lastOrig.block_timestamp,
        lenderVault: lender,
      });
      if (est) {
        activeLoanEstimate = { ...est, started_at: lastOrig.block_timestamp, lender_vault: lender };
      }
    }
  }

  return (
    <SubpageShell active="activity">
      <InscriptionDetail
        inscription={inscription}
        events={events}
        heldSince={heldSince}
        ownerOthers={ownerOthers}
        ownerOthersHasMore={ownerOthersHasMore}
        activeLoanEstimate={activeLoanEstimate}
      />
    </SubpageShell>
  );
}
