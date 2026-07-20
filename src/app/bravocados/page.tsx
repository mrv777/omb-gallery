import type { Metadata } from 'next';
import SubpageShell from '@/components/SubpageShell';
import BravocadosStats, { type BravocadoStats } from '@/components/Bravocados/BravocadosStats';
import DispensarySection from '@/components/Bravocados/DispensarySection';
import BravocadosGrid, { type BravocadoGridItem } from '@/components/Bravocados/BravocadosGrid';
import { getStmts } from '@/lib/db';
import { BRAVOCADO_DISTRIBUTION_WALLETS } from '@/lib/walletLabels';
import { buildSocial } from '@/lib/metadata';

const DESCRIPTION =
  'Bitcoin Bravocados — the 1,002-piece OMB companion collection. The first 100 are dispensed one at a time to Parasite pool miners.';

export const metadata: Metadata = {
  title: 'Bravocados',
  description: DESCRIPTION,
  ...buildSocial({ title: 'Bitcoin Bravocados', description: DESCRIPTION }),
};

export const dynamic = 'force-dynamic';

const DISPENSARY_COUNT = 100;

type Row = {
  inscription_number: number;
  inscription_id: string | null;
  effective_owner: string | null;
};

export default function BravocadosPage() {
  const stmts = getStmts();
  const rows = stmts.listBravocados.all({}) as Row[];
  const distributionWallets = new Set<string>(BRAVOCADO_DISTRIBUTION_WALLETS);

  const items: BravocadoGridItem[] = rows.map(r => ({
    number: r.inscription_number,
    dispensed: r.effective_owner != null && !distributionWallets.has(r.effective_owner),
  }));

  const holders = new Set<string>();
  let unindexed = 0;
  for (const r of rows) {
    if (r.effective_owner == null) unindexed++;
    else if (!distributionWallets.has(r.effective_owner)) holders.add(r.effective_owner);
  }
  const overlapRow = stmts.countBravocadoOmbOverlap.get({}) as { n: number } | undefined;
  const stats: BravocadoStats = {
    total: rows.length,
    distributed: items.filter(i => i.dispensed).length,
    uniqueHolders: holders.size,
    ombOverlap: overlapRow?.n ?? 0,
    unindexed,
  };

  // The dispensary run is the first 100 by inscription number; rows come back
  // number-ASC from the statement.
  const dispensaryItems = items.slice(0, DISPENSARY_COUNT);

  return (
    <SubpageShell>
      <section className="px-4 sm:px-6 pb-16 max-w-6xl mx-auto">
        <h1 className="font-mono text-2xl text-bone uppercase tracking-[0.08em] mb-3">
          bitcoin bravocados
        </h1>
        <p className="font-mono mb-6 text-[11px] leading-relaxed text-bone-dim uppercase tracking-[0.08em] max-w-2xl">
          The OMB companion collection — 1,002 on-chain avocados. Distribution status is derived
          straight from the chain: a piece counts as distributed once it leaves the dispensary and
          reserve wallets.
        </p>

        <div className="mb-10">
          <BravocadosStats stats={stats} />
        </div>

        <DispensarySection items={dispensaryItems} />

        <h2 className="font-mono text-lg text-bone uppercase tracking-[0.08em] mb-4">
          the collection
        </h2>
        <BravocadosGrid items={items} />
      </section>
    </SubpageShell>
  );
}
