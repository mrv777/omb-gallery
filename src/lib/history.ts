// Hand-written history content for /history.
//
// Framework-free (same contract as src/lib/nav.ts): plain data + pure helpers,
// imported by a server component but carrying nothing server-only.
//
// THE RULE THIS FILE ENFORCES: anything with a number in it belongs in a
// prepared statement in src/lib/db.ts, not here. This file holds only what the
// chain can't tell us — who made it, when it was announced, what happened off
// exchange. And every one of those claims carries a source, because `source` is
// a required field: an uncited off-chain claim does not compile.

export type Citation = { label: string; href: string };

/**
 * How much weight a claim carries.
 * - `confirmed` — reported consistently by multiple independent sources.
 * - `reported`  — a single source we have no reason to doubt but haven't corroborated.
 * - `disputed`  — sources conflict, or the widely-repeated version is wrong.
 */
export type Confidence = 'confirmed' | 'reported' | 'disputed';

export type OffChainFact = {
  id: string;
  /** 'YYYY-MM' or 'YYYY-MM-DD'. Merged and sorted against chain-derived rows. */
  date: string;
  title: string;
  body: string;
  source: Citation;
  confidence: Confidence;
};

const LEATHER: Citation = {
  label: 'Leather — Guide to Ordinal Maxi Biz',
  href: 'https://leather.io/posts/guide-to-bitcoin-ordinals-collections-what-is-ordinal-maxi-biz',
};
const XVERSE: Citation = {
  label: 'Xverse — What Is Ordinal Maxi Biz?',
  href: 'https://www.xverse.app/blog/ordinals-maxi-biz-omb',
};
const NFTNOW: Citation = {
  label: "nft now — Christie's announces first Ordinals auction",
  href: 'https://nftnow.com/art/christies-ordinals-auction-ordinal-maxi-biz-omb-zk-shark/',
};
const NFTCULTURE: Citation = {
  label: "NFT Culture — Christie's dives into Bitcoin Ordinals",
  href: 'https://www.nftculture.com/nft-news/christies-dives-into-bitcoin-ordinals-with-ordinal-maxi-biz-auction/',
};

export const OFFCHAIN_TIMELINE: readonly OffChainFact[] = [
  {
    id: 'origin',
    date: '2023-02',
    title: 'ZK Shark quits finance; Tony Tafuro starts drawing',
    body: 'Ordinal Maxi Biz is built by the pseudonymous ZK Shark, a former Wall Street professional who left his job to work on it full time, with artist Tony Tafuro drawing every head by hand. Nullish sourced the satoshis — the sat-hunting that put later drops on block 9 and block 78.',
    source: LEATHER,
    confidence: 'confirmed',
  },
  {
    id: 'launch',
    date: '2023-03-12',
    title: 'Public launch',
    body: 'The collection is announced. Note the chain disagrees slightly with the press: the red eyes were already inscribed a month earlier, starting 2023-02-14.',
    source: XVERSE,
    confidence: 'reported',
  },
  {
    id: 'punk-burn',
    date: '2023-06',
    title: 'CryptoPunk #8611 burned for whitelist',
    body: 'A group buys CryptoPunk #8611 and sends it to an Ethereum burn address. Everyone who took part is given a whitelist spot — an entry ritual that cost an actual Punk.',
    source: XVERSE,
    confidence: 'reported',
  },
  {
    id: 'christies',
    date: '2024-04',
    title: "Christie's first Ordinals auction",
    body: "Christie's runs its first-ever Ordinals auction with a set of four OMBs — one blue, one green, one red, one orange. The set sells for $441,000.",
    source: NFTNOW,
    confidence: 'confirmed',
  },
];

export type OpenQuestion = {
  id: string;
  question: string;
  whatWeKnow: string;
  sources: readonly Citation[];
};

/**
 * The bit that makes this a wiki rather than a brochure. Each entry is either a
 * claim the public record gets wrong, or a gap we're openly asking for help with.
 */
export const OPEN_QUESTIONS: readonly OpenQuestion[] = [
  {
    id: 'supply-5141',
    question: 'Why does everyone say OMB is 5,141 pieces?',
    whatWeKnow:
      'Because it was, for a while. 100 blue + 1,900 green + 3,141 orange is exactly 5,141 — the figure counts those three drops and nothing else. It leaves out the 102 reds, which were inscribed first and are still the only OMBs on individually-sourced satoshis, and it predates the 3,758 black eyes of January 2025. The full collection this wiki indexes is 9,001.',
    sources: [LEATHER, XVERSE],
  },
  {
    id: 'block-9-green-only',
    question: 'Is it only the green eyes that sit on block-9 satoshis?',
    whatWeKnow:
      "No — the guides describing this as green-only are incomplete. Green, orange and black all sit on satoshis minted in block 9; that's 8,799 of 9,001 pieces. Blue sits on block 78. Only the 102 reds are on ordinary sats. The counts on this page are recomputed from our own index on every page load, so you can check the arithmetic yourself.",
    sources: [LEATHER, XVERSE],
  },
  {
    id: 'block-attribution',
    question: 'Were blocks 9 and 78 really mined by Satoshi and Hal Finney?',
    whatWeKnow:
      "Neither is provable from the chain. Block 9's coinbase demonstrably funded the first ever Bitcoin transaction — 10 BTC to Hal Finney in block 170 — and that part is fact. Attributing the mining of block 9 to Satoshi rests on the Patoshi nonce pattern, and block 78 to Hal Finney on early-mining analysis. Both are strong community consensus, not proof. We mark them † throughout.",
    sources: [
      {
        label: 'Patoshi pattern — Sergio Demian Lerner',
        href: 'https://bitslog.com/2013/04/17/the-well-deserved-fortune-of-satoshi-nakamoto/',
      },
    ],
  },
];

/** Every citation used on the page, deduped by href, for the Sources footer. */
export function collectSources(
  facts: readonly OffChainFact[],
  questions: readonly OpenQuestion[],
  extra: readonly Citation[] = []
): Citation[] {
  const byHref = new Map<string, Citation>();
  for (const f of facts) byHref.set(f.source.href, f.source);
  for (const q of questions) for (const c of q.sources) byHref.set(c.href, c);
  for (const c of extra) byHref.set(c.href, c);
  return Array.from(byHref.values()).sort((a, b) => a.label.localeCompare(b.label));
}

export const EXTRA_SOURCES: readonly Citation[] = [NFTCULTURE];

/**
 * Sort key for merging hand-written facts with chain-derived rows. Partial
 * dates sort to the start of their period, which is what you want for a
 * timeline ('2023-02' lands before '2023-02-14').
 */
export function timelineSortKey(date: string): string {
  if (/^\d{4}-\d{2}$/.test(date)) return `${date}-00`;
  return date;
}
