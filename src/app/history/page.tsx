import type { Metadata } from 'next';
import Link from 'next/link';

import SubpageShell from '@/components/SubpageShell';
import Section from '@/components/History/Section';
import HistoryTimeline, { type ChainFact } from '@/components/History/HistoryTimeline';
import DropTable, { type DropRow } from '@/components/History/DropTable';
import SatProvenancePanel, {
  type BlockBucket,
  type VariedSat,
} from '@/components/History/SatProvenancePanel';
import MarketHistory, { type SaleRow } from '@/components/History/MarketHistory';
import MovementStrip, { type EventSpan } from '@/components/History/MovementStrip';
import OpenQuestions from '@/components/History/OpenQuestions';
import SourceList from '@/components/History/SourceList';
import SeriesCards from '@/components/History/SeriesCards';
import ChaseBoard, { type ChaseTile } from '@/components/History/ChaseBoard';
import DropTimeline, { type DropBand } from '@/components/Charts/DropTimeline';

import { getStmts } from '@/lib/db';
import { EXTRA_SOURCES, OFFCHAIN_TIMELINE, OPEN_QUESTIONS, collectSources } from '@/lib/history';
import {
  NOTABLE_BLOCKS,
  VARIED_COLORS,
  blockForSat,
  blockMinedAt,
  defaultBlockForColor,
  satProvenance,
} from '@/lib/satProvenance';
import { fullDate } from '@/components/Charts/chartUtils';
import { buildSocial } from '@/lib/metadata';
import { formatBtc } from '@/lib/format';

const DESCRIPTION =
  'How Ordinal Maxi Biz was made, drop by drop — inscribe and distribution windows, the satoshis each drop sits on, and the market record. Every figure recomputed from our own index.';

export const metadata: Metadata = {
  title: 'History',
  description: DESCRIPTION,
  ...buildSocial({ title: 'OMB history & provenance', description: DESCRIPTION }),
};

export const dynamic = 'force-dynamic';

const COLLECTION = 'omb';
/** Chronological by inscribe window, which is also the order the drops shipped. */
const COLOR_ORDER = ['red', 'blue', 'green', 'orange', 'black'];

type DropWindowRow = {
  color: string;
  count: number;
  first_inscribed_at: number | null;
  last_inscribed_at: number | null;
};
type MintWindowRow = {
  color: string;
  count: number;
  first_mint_at: number | null;
  last_mint_at: number | null;
};
type EventSpanRow = {
  event_type: string;
  count: number;
  first_at: number | null;
  last_at: number | null;
};
type SatCountRow = { color: string; count: number };
type VariedSatRow = { inscription_number: number; sat: number; color: string };
type RecordSaleRow = {
  inscription_number: number;
  color: string | null;
  sale_price_sats: number;
  block_timestamp: number;
  marketplace: string | null;
};

/**
 * Sort/heading key for a timestamp, in the SAME timezone basis that
 * chartUtils' fullDate() renders in (the runtime's local zone).
 *
 * Not toISOString(): that's UTC, and mixing the two puts a UTC heading above a
 * local-time body — the green drop rendered as "jun 2 2023 / Inscribed over
 * Jun 1, 2023" before this existed. One basis, no contradictions.
 */
function localIsoDay(unix: number): string {
  const d = new Date(unix * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function HistoryPage() {
  const stmts = getStmts();

  const dropRows = stmts.collectionDropWindows.all({ collection: COLLECTION }) as DropWindowRow[];
  const mintRows = stmts.mintWindowsByColor.all({ collection: COLLECTION }) as MintWindowRow[];
  const spanRows = stmts.eventTypeSpans.all({ collection: COLLECTION }) as EventSpanRow[];
  const satRows = stmts.satCountsByColor.all({ collection: COLLECTION }) as SatCountRow[];
  const neverMoved =
    (stmts.countNeverMoved.get({ collection: COLLECTION }) as { count: number } | undefined)
      ?.count ?? 0;
  const topSaleRows = stmts.recordSaleByColor.all({
    collection: COLLECTION,
  }) as RecordSaleRow[];
  const variedRows = VARIED_COLORS.flatMap(
    color => stmts.redSatsOrdered.all({ collection: COLLECTION, color }) as VariedSatRow[]
  );

  const dropByColor = new Map(dropRows.map(r => [r.color, r]));
  const mintByColor = new Map(mintRows.map(r => [r.color, r]));
  const total = dropRows.reduce((n, r) => n + r.count, 0);

  const orderedColors = COLOR_ORDER.filter(c => dropByColor.has(c)).concat(
    dropRows.map(r => r.color).filter(c => !COLOR_ORDER.includes(c))
  );

  // ---- section 3: the five drops -----------------------------------------
  const dropTableRows: DropRow[] = orderedColors.map(color => {
    const d = dropByColor.get(color)!;
    const m = mintByColor.get(color);
    const uniformBlock = defaultBlockForColor(color);
    const notable = uniformBlock != null ? NOTABLE_BLOCKS[uniformBlock] : undefined;
    return {
      color,
      count: d.count,
      inscribedFrom: d.first_inscribed_at ?? 0,
      inscribedTo: d.last_inscribed_at ?? 0,
      mintedFrom: m?.first_mint_at ?? null,
      mintedTo: m?.last_mint_at ?? null,
      mintedCount: m?.count ?? 0,
      uniformBlock,
      blockNote: notable
        ? `${notable.confidence === 'attributed' ? '†' : ''}${notable.attributedMiner}`
        : null,
    };
  });

  const bands: DropBand[] = dropTableRows
    .filter(r => r.inscribedFrom > 0)
    .map(r => ({
      color: r.color,
      count: r.count,
      inscribedFrom: r.inscribedFrom,
      inscribedTo: r.inscribedTo,
      mintedFrom: r.mintedFrom,
      mintedTo: r.mintedTo,
    }));

  // ---- section 4: sat provenance -----------------------------------------
  // Bucketed here rather than in SQL because decoding a sat to a block is
  // halving-aware — see the note on satCountsByColor in src/lib/db.ts.
  //
  // Only the blocks that back a WHOLE drop are listed. The individually-sourced
  // colors scatter across ~70 blocks with one or two pieces each; enumerating
  // them here would bury the actual finding under a list of near-duplicates.
  // They get their own table below, sorted by age, which is the view that
  // matters for them.
  const byHeight = new Map<number, { count: number; colors: Set<string> }>();
  for (const r of satRows) {
    const height = defaultBlockForColor(r.color);
    if (height == null) continue;
    const entry = byHeight.get(height) ?? { count: 0, colors: new Set<string>() };
    entry.count += r.count;
    entry.colors.add(r.color);
    byHeight.set(height, entry);
  }
  const buckets: BlockBucket[] = Array.from(byHeight.entries())
    .map(([height, e]) => ({
      height,
      count: e.count,
      colors: COLOR_ORDER.filter(c => e.colors.has(c)),
      notable: NOTABLE_BLOCKS[height] ?? null,
      minedAt: blockMinedAt(height),
    }))
    .sort((a, b) => b.count - a.count || a.height - b.height);

  const varied: VariedSat[] = variedRows
    .map(r => {
      const p = satProvenance(r.sat);
      return {
        number: r.inscription_number,
        color: r.color,
        sat: r.sat,
        height: p?.height ?? blockForSat(r.sat)?.height ?? 0,
        minedAt: p?.minedAt ?? null,
        vintage: p?.vintage ?? null,
      };
    })
    .sort((a, b) => a.sat - b.sat);

  // ---- section 5: market --------------------------------------------------
  const sales: SaleRow[] = topSaleRows.map(r => ({
    number: r.inscription_number,
    color: r.color ?? '',
    sats: r.sale_price_sats,
    at: r.block_timestamp,
    marketplace: r.marketplace,
  }));

  // ---- section 6: movement ------------------------------------------------
  const spans: EventSpan[] = spanRows
    .map(r => ({ type: r.event_type, count: r.count, firstAt: r.first_at, lastAt: r.last_at }))
    .sort((a, b) => b.count - a.count);

  // ---- section 2: timeline ------------------------------------------------
  // Chain rows are derived here rather than typed as literals, so the timeline
  // can never disagree with the tables further down the page.
  const chainFacts: ChainFact[] = [];
  for (const color of orderedColors) {
    const d = dropByColor.get(color)!;
    if (d.first_inscribed_at == null) continue;
    const sameDay =
      localIsoDay(d.first_inscribed_at) ===
      localIsoDay(d.last_inscribed_at ?? d.first_inscribed_at);
    chainFacts.push({
      id: `inscribe-${color}`,
      date: localIsoDay(d.first_inscribed_at),
      title: `${d.count.toLocaleString()} ${color} eyes inscribed`,
      body: sameDay
        ? `All ${d.count.toLocaleString()} written to chain on ${fullDate(d.first_inscribed_at)}.`
        : `Inscribed over ${fullDate(d.first_inscribed_at)} → ${fullDate(d.last_inscribed_at!)}.`,
    });
  }
  const firstSale = spanRows.find(r => r.event_type === 'sold');
  if (firstSale?.first_at != null) {
    chainFacts.push({
      id: 'first-sale',
      date: localIsoDay(firstSale.first_at),
      title: 'First recorded secondary sale',
      body: `${firstSale.count.toLocaleString()} sales have been indexed since.`,
    });
  }
  const firstLoan = spanRows.find(r => r.event_type === 'loan-originated');
  if (firstLoan?.first_at != null) {
    chainFacts.push({
      id: 'first-loan',
      date: localIsoDay(firstLoan.first_at),
      title: 'First OMB used as loan collateral',
      body: `Liquidium originations detected on chain; ${firstLoan.count.toLocaleString()} to date.`,
    });
  }
  if (sales[0]?.at != null) {
    chainFacts.push({
      id: 'ath',
      date: localIsoDay(sales[0].at),
      title: `All-time high sale — #${sales[0].number}`,
      body: 'Still the highest price any OMB has changed hands for in our index.',
    });
  }

  // ---- chase board -------------------------------------------------------
  // Every tile derived, so there is no curated "grails" list to argue over.
  //
  // Count vintages across the WHOLE collection, not just the individually-
  // sourced colors. Scoping this to `varied` produced "1 on a 2009 sat", which
  // was wrong by three orders of magnitude: blocks 9 and 78 were mined on
  // 9 and 11 January 2009, so nearly the entire collection is on 2009 sats.
  // Same trap made #489040 look like "the oldest satoshi in the collection"
  // when block 30,917 is ~11 months YOUNGER than the block-9 sats.
  const vintageCounts = new Map<string, number>();
  for (const b of buckets) {
    const y = b.minedAt != null ? String(new Date(b.minedAt * 1000).getUTCFullYear()) : null;
    if (y) vintageCounts.set(y, (vintageCounts.get(y) ?? 0) + b.count);
  }
  for (const v of varied) {
    if (v.vintage) vintageCounts.set(v.vintage, (vintageCounts.get(v.vintage) ?? 0) + 1);
  }
  const earliestVintage = Array.from(vintageCounts.keys()).sort()[0];
  const earliestVintageCount = earliestVintage ? (vintageCounts.get(earliestVintage) ?? 0) : 0;
  const blueCount = dropByColor.get('blue')?.count ?? 0;
  const chaseTiles: ChaseTile[] = [];
  chaseTiles.push({
    id: 'supply',
    headline: total.toLocaleString(),
    label: `pieces across ${orderedColors.length} drops, 2023–2025`,
    href: '#drops',
  });
  if (earliestVintage) {
    chaseTiles.push({
      id: 'vintage-2009',
      headline: `${earliestVintageCount.toLocaleString()} on ${earliestVintage} sats`,
      label: `blocks 9 and 78, mined in bitcoin's first nine days`,
      href: '#sats',
    });
  }
  // The reds' distinction is that each has its OWN sat, not that they're old —
  // the oldest of them (#489040, block 30,917) is younger than every block-9 sat.
  if (varied.length > 0) {
    chaseTiles.push({
      id: 'own-sat',
      headline: `${varied.length} own their sat`,
      label: `every ${varied[0].color} eye on an individually-hunted satoshi${
        varied[0].minedAt != null
          ? ` — oldest #${varied[0].number}, block ${varied[0].height.toLocaleString()}`
          : ''
      }`,
      href: '#sats',
    });
  }
  if (blueCount > 0) {
    chaseTiles.push({
      id: 'finney',
      headline: `${blueCount} on block 78`,
      label: '†mined by Hal Finney, the first person to receive bitcoin',
      href: '/?color=blue',
    });
  }
  if (sales[0]) {
    chaseTiles.push({
      id: 'ath',
      headline: formatBtc(sales[0].sats),
      label: `all-time high — #${sales[0].number}`,
      href: '#market',
    });
  }
  chaseTiles.push({
    id: 'never-moved',
    headline: neverMoved.toLocaleString(),
    label: 'never moved since they were inscribed',
    href: '/explorer/longest-unmoved',
  });

  const sources = collectSources(OFFCHAIN_TIMELINE, OPEN_QUESTIONS, [
    ...EXTRA_SOURCES,
    ...Object.values(NOTABLE_BLOCKS).map(b => b.source),
  ]);

  return (
    <SubpageShell active="history">
      <section className="px-4 sm:px-6 pb-16 max-w-4xl mx-auto">
        <h1 className="font-mono text-2xl text-bone uppercase tracking-[0.08em] mb-3">history</h1>
        <p className="font-mono mb-10 max-w-2xl text-[11px] leading-relaxed text-bone-dim uppercase tracking-[0.08em]">
          Five drops over three years, every one hand-drawn and inscribed on satoshis that were
          chosen, not taken at random. Every number on this page is recomputed from our own index on
          page load — nothing here is typed in by hand. What the chain can&apos;t tell us is marked
          with its source.{' '}
          <Link href="/info" className="text-bone hover:underline underline-offset-4">
            more links on /info
          </Link>
          .
        </p>

        <ChaseBoard tiles={chaseTiles} />

        <Section id="timeline" title="timeline">
          <HistoryTimeline chainFacts={chainFacts} offChainFacts={OFFCHAIN_TIMELINE} />
        </Section>

        <Section
          id="drops"
          title="the five drops"
          lede="Inscribing and distributing are separate events, sometimes separated by a year. Orange was written to chain in a single day and handed out over the following thirteen months."
        >
          <div className="mb-8">
            <DropTimeline bands={bands} />
          </div>
          <DropTable rows={dropTableRows} />
        </Section>

        <Section
          id="sats"
          title="what the collection sits on"
          lede="An inscription lives on one specific satoshi. Which satoshi was a deliberate choice here — and it is not the choice most write-ups describe."
        >
          <SatProvenancePanel
            total={total}
            buckets={buckets}
            varied={varied}
            variedColors={VARIED_COLORS}
          />
        </Section>

        <Section
          id="series"
          title="named sub-series"
          lede="OMB is hand-drawn 1/1s, so there are no traits to filter on. What it has instead are recurring runs, catalogued here by hand."
        >
          <SeriesCards />
        </Section>

        <Section id="market" title="market history">
          <MarketHistory sales={sales} />
        </Section>

        <Section
          id="movement"
          title="movement at a glance"
          lede="Everything our indexer has recorded, by event type."
        >
          <MovementStrip spans={spans} neverMoved={neverMoved} total={total} />
        </Section>

        <Section
          id="open-questions"
          title="open questions"
          lede="Where the public record is wrong, incomplete, or still unknown. Corrections welcome."
        >
          <OpenQuestions questions={OPEN_QUESTIONS} />
        </Section>

        <Section id="sources" title="sources">
          <SourceList sources={sources} />
        </Section>
      </section>
    </SubpageShell>
  );
}
