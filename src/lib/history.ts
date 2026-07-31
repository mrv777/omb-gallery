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
  /**
   * A published source this entry supersedes. Set when the press got it wrong
   * and someone who was there corrected it — the correction is the fact, and
   * the thing it replaces stays visible so a reader can check both.
   */
  corrects?: Citation;
};

const LEATHER: Citation = {
  label: 'Leather — Guide to Ordinal Maxi Biz',
  // Leather has shuffled this guide between /posts/, /support/guide/ and
  // /support/ paths over time. The /posts/ path serves it directly (200, no
  // redirect) as of 2026-07-30. One caution when leaning on it: its own
  // per-color breakdown (100/200/1900/3000) contradicts its 5,141 headline —
  // fine for the narrative claims we cite it for, never for counts.
  href: 'https://app.leather.io/posts/guide-to-bitcoin-ordinals-collections-what-is-ordinal-maxi-biz',
};
/**
 * Wayback, deliberately. The live URL now 301s to Xverse's /ordinals-wallet
 * product page, which carries none of the OMB claims — a soft 404. Two entries
 * here CORRECT this post, so the thing being corrected has to stay readable or
 * the correction is unfalsifiable.
 */
const XVERSE: Citation = {
  label: 'Xverse — What Is Ordinal Maxi Biz? (archived)',
  href: 'https://web.archive.org/web/20260218002859/https://www.xverse.app/blog/ordinals-maxi-biz-omb',
};
const NFTNOW: Citation = {
  label: "nft now — Christie's announces first Ordinals auction",
  href: 'https://nftnow.com/art/christies-ordinals-auction-ordinal-maxi-biz-omb-zk-shark/',
};
/**
 * First-hand community testimony. Not a published article, so it carries no
 * deep link — but it is frequently the ONLY correct account, since the press
 * coverage was written from a distance. Labelled as testimony rather than
 * dressed up as a citation.
 */
const OMB_COMMUNITY: Citation = {
  label: 'OMB community, via Discord (first-hand account)',
  href: 'https://discord.gg/ordinalmaxibiz',
};
const NFTCULTURE: Citation = {
  label: "NFT Culture — Christie's dives into Bitcoin Ordinals",
  href: 'https://www.nftculture.com/nft-news/christies-dives-into-bitcoin-ordinals-with-ordinal-maxi-biz-auction/',
};
/**
 * The seller's own results page — primary, and the only source that ties each
 * price to its lot number rather than listing them as a bag of figures.
 */
const CHRISTIES: Citation = {
  label: "Christie's — Ordinal Maxi Biz (OMB), sale 23443, results",
  href: 'https://onlineonly.christies.com/s/ordinal-maxi-biz-omb/lots/3717',
};
/** The only secondary write-up found that publishes the per-lot results. */
const CRYPTOFLIES: Citation = {
  label: "Cryptoflies — Christie's OMB auction results, lot by lot",
  href: 'https://cryptoflies.com/christies-first-bitcoin-nft-auction-ordinal-maxi-biz-rakes-in-730k/',
};
/** Contemporaneous reporting on the Punk burns and the whitelist allocation. */
const NFTNOW_PUNKS: Citation = {
  label: 'nft now — Why are people burning CryptoPunks for Ordinals?',
  href: 'https://nftnow.com/features/why-are-people-burning-cryptopunks-for-ordinals-nfts/',
};
/**
 * The only source found that states the exact launch date. The Xverse post
 * this entry used to cite says only "created in 2023" — no date at all — and
 * Leather corroborates just the month ("in March of last year").
 */
const NFTPRICEFLOOR: Citation = {
  label: 'NFT Price Floor — Ordinal Maxi Biz',
  href: 'https://nftpricefloor.com/omb',
};

export const OFFCHAIN_TIMELINE: readonly OffChainFact[] = [
  {
    id: 'origin',
    date: '2023-02',
    title: 'ZK Shark quits finance; Tony Tafuro starts drawing',
    // We stick to Leather's phrasing ("finance job"). The Wall Street version
    // IS first-party sourceable now — ZK Shark's own Substack
    // (zkshark.substack.com/p/ordinals-inscriptions-and-rare-sats) says
    // "resigned from my finance day job" and "trader on wall st" — so upgrade
    // it with that citation if we ever want to; never on nftpricefloor alone.
    body: 'Ordinal Maxi Biz is built by the pseudonymous ZK Shark, who quit his finance job to work on it full time, with artist Tony Tafuro drawing every head by hand and further artwork from berkin bags. Nullish — the sat-hunter who located and secured the block-78 satoshis in the first place — sourced the sats that later drops were inscribed on.',
    source: LEATHER,
    confidence: 'confirmed',
  },
  {
    id: 'launch',
    date: '2023-03-12',
    title: 'Public launch',
    body: 'The collection is announced. Note the chain disagrees slightly with the press: the red eyes were already inscribed a month earlier, starting 2023-02-14.',
    // NFT Price Floor is the only reachable source stating March 12 exactly;
    // Leather corroborates the month. Don't cite Xverse here — its archived
    // post says only "created in 2023".
    source: NFTPRICEFLOOR,
    confidence: 'reported',
  },
  {
    id: 'punk-burn',
    date: '2023-06',
    title: 'Two CryptoPunks burned for whitelist',
    body: 'Bitcoin Bandits open a burn site on June 15 — the standing offer was an allowlist spot for anyone who burned a Punk — and two Punks leave Ethereum for good: #8611 first, which had just sold for 54.49 ETH (~$94,000), then #9146 a few days later. In practice only those two community-funded burns happened, and the concrete Green Eyes allocation was 33 whitelist spots each for DeGods and Bitcoin Bandits, many of them raffled off. Community recollection adds a public-whitelist tier for everyone else who took part; the original mint checker is offline, so no published source records that detail. Corrected by the OMB community after this page first went up, and confirmed against contemporaneous reporting and the CryptoPunks contract.',
    source: NFTNOW_PUNKS,
    confidence: 'confirmed',
    corrects: XVERSE,
  },
  {
    id: 'christies',
    date: '2024-04',
    title: "Christie's first Ordinals auction — $730,800",
    body: "Christie's runs its first Bitcoin Ordinals auction, 9–16 April 2024, four lots selected by creator ZK Shark. Total realised: $730,800 — lot 1 $441,000, lot 2 $88,200, lot 3 $75,600, lot 4 $126,000. Watch the figure people quote: $441,000 was LOT 1 alone, itself a four-piece red/blue/green/orange set, which is how it ends up repeated as though it were the whole sale.",
    source: CHRISTIES,
    confidence: 'confirmed',
    corrects: NFTNOW,
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
      "Neither is provable from the chain. Block 9's coinbase demonstrably funded the first ever Bitcoin transaction — 10 BTC to Hal Finney in block 170 — and that part is fact. Attributing the mining of block 9 to Satoshi rests on the Patoshi nonce pattern. Block 78 is widely called the first block mined by someone other than Satoshi, and that part does not survive checking: blocks 12 and 64 both precede it and both fall outside the Patoshi nonce range, so the same heuristic that puts block 9 in Satoshi's hands rules them out of it too. Block 78 is better described as the earliest block credibly attributed to a named miner. The Finney attribution itself comes from Nullish, who traced it by lining the block timestamp up with Finney's \"Running bitcoin\" tweet and his early correspondence with Satoshi — a correlation, not a signature. We mark all of it † throughout.",
    sources: [
      {
        label: 'Patoshi pattern — Sergio Demian Lerner (2013, original extranonce analysis)',
        href: 'https://bitslog.com/2013/04/17/the-well-deserved-fortune-of-satoshi-nakamoto/',
      },
      // The 2013 post establishes the aggregate pattern; the per-block nonce
      // criterion (last byte in [0-9]∪[19-58]) that puts block 9 in and
      // blocks 12/64/78 out comes from Lerner's later work.
      {
        label: 'The Patoshi Mining Machine — Sergio Demian Lerner (2020)',
        href: 'https://bitslog.com/2020/08/22/the-patoshi-mining-machine/',
      },
      {
        label: "Nullish — Ordinal sats from Hal Finney's first mined block",
        href: 'https://medium.com/@nullish/ordinal-sats-from-hal-finneys-first-mined-bitcoin-block-have-been-found-6636b3c4925e',
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
  for (const f of facts) {
    byHref.set(f.source.href, f.source);
    if (f.corrects) byHref.set(f.corrects.href, f.corrects);
  }
  for (const q of questions) for (const c of q.sources) byHref.set(c.href, c);
  for (const c of extra) byHref.set(c.href, c);
  return Array.from(byHref.values()).sort((a, b) => a.label.localeCompare(b.label));
}

export const EXTRA_SOURCES: readonly Citation[] = [NFTCULTURE, OMB_COMMUNITY, CRYPTOFLIES];

/**
 * Sort key for merging hand-written facts with chain-derived rows. Partial
 * dates sort to the start of their period, which is what you want for a
 * timeline ('2023-02' lands before '2023-02-14').
 */
export function timelineSortKey(date: string): string {
  if (/^\d{4}-\d{2}$/.test(date)) return `${date}-00`;
  return date;
}
