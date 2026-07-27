// Sat provenance — what satoshi an OMB sits on, and what that satoshi is.
//
// Imported by both server pages (/history, /inscription/[number]) and the
// client gallery, so this file MUST stay framework-free — no `'use client'`,
// no `server-only`, no React/next imports, no hooks. Plain data + pure
// functions only, same contract as src/lib/nav.ts and src/lib/roles.ts.
//
// The gallery never touches SQLite, so the data comes from a baked ~5 KB file
// rather than the `inscriptions.sat` column. That file stores per-color default
// blocks for the colors whose sats are uniform plus every sat for the ones that
// aren't — see scripts/build-sat-provenance.js for why, and for the invariant
// check that keeps the compression honest.

import baked from '../data/collections/omb/sat-provenance.json';

export const HALVING_INTERVAL = 210_000;
export const INITIAL_SUBSIDY = 5_000_000_000;

// Total supply is ~2.1e15 sats, comfortably under Number.MAX_SAFE_INTEGER
// (9.007e15), so plain numbers are exact throughout this file — unlike
// scripts/backfill-transfers.js, which needs BigInt because it sums arbitrary
// transaction output values.

export type BlockPosition = {
  /** Block whose coinbase minted this sat. */
  height: number;
  /** Halving epoch (0 = blocks 0–209,999). */
  epoch: number;
  /** Index of this sat within its block's subsidy. 0 = the block's first sat. */
  offsetInBlock: number;
};

/**
 * Decode a sat number into the block that minted it.
 *
 * Returns null past the final subsidy epoch (unreachable for real sats — the
 * subsidy hits zero long after the last satoshi is issued), so callers never
 * have to trust a fabricated height.
 */
export function blockForSat(sat: number): BlockPosition | null {
  if (!Number.isFinite(sat) || sat < 0 || !Number.isSafeInteger(sat)) return null;
  let subsidy = INITIAL_SUBSIDY;
  let epochStartSat = 0;
  let epochStartHeight = 0;
  let epoch = 0;
  while (subsidy > 0) {
    const epochSats = subsidy * HALVING_INTERVAL;
    if (sat < epochStartSat + epochSats) {
      const into = sat - epochStartSat;
      const blocksIn = Math.floor(into / subsidy);
      return {
        height: epochStartHeight + blocksIn,
        epoch,
        offsetInBlock: into - blocksIn * subsidy,
      };
    }
    epochStartSat += epochSats;
    epochStartHeight += HALVING_INTERVAL;
    subsidy = Math.floor(subsidy / 2);
    epoch += 1;
  }
  return null;
}

/**
 * A block worth naming on a piece's provenance line.
 *
 * `confidence` is load-bearing and must not be flattened. "Block 9's coinbase
 * funded the first ever Bitcoin transaction" is provable from the chain.
 * "Block 9 was mined by Satoshi" is an inference from the Patoshi nonce
 * pattern, and "block 78 was Hal Finney" is community attribution. Note the
 * community ALSO calls 78 the first non-Satoshi block, which Patoshi itself
 * contradicts (12 and 64 precede it and are out of range) — don't reinstate
 * that phrasing. The UI
 * renders `attributed` claims with a † and the source link; stating both in one
 * voice is the difference between a wiki and a Twitter thread.
 */
export type NotableBlock = {
  height: number;
  /** Collector shorthand, e.g. 'nineball'. Empty when there isn't one. */
  nickname: string;
  attributedMiner: string;
  confidence: 'proven' | 'attributed';
  note: string;
  source: { label: string; href: string };
};

export const NOTABLE_BLOCKS: Readonly<Record<number, NotableBlock>> = {
  0: {
    height: 0,
    nickname: 'genesis',
    attributedMiner: 'Satoshi Nakamoto',
    confidence: 'proven',
    note: 'The genesis block. Its 50 BTC coinbase is unspendable by consensus, so no inscription can ever sit on it.',
    source: {
      label: 'Bitcoin Wiki — Genesis block',
      href: 'https://en.bitcoin.it/wiki/Genesis_block',
    },
  },
  9: {
    height: 9,
    nickname: 'nineball',
    attributedMiner: 'Satoshi Nakamoto',
    confidence: 'attributed',
    note: "Block 9's coinbase funded the first ever Bitcoin transaction — 10 BTC to Hal Finney in block 170. The block itself is attributed to Satoshi via the Patoshi nonce pattern rather than proven on-chain.",
    source: {
      label: 'Patoshi pattern — Sergio Demian Lerner',
      href: 'https://bitslog.com/2013/04/17/the-well-deserved-fortune-of-satoshi-nakamoto/',
    },
  },
  78: {
    height: 78,
    nickname: '',
    attributedMiner: 'Hal Finney',
    confidence: 'attributed',
    note: 'The earliest block credibly attributed to a named miner other than Satoshi — widely called the first such block, though blocks 12 and 64 precede it and also fall outside the Patoshi nonce range. Attributed to Hal Finney — the first person to receive a Bitcoin transaction — by Nullish, who located these satoshis and later sourced sats for OMB. The attribution is inferred from the block timestamp lining up with Finney\'s "Running bitcoin" tweet and his early correspondence with Satoshi, not proven on-chain.',
    source: {
      label: "Nullish — Ordinal sats from Hal Finney's first mined block",
      href: 'https://medium.com/@nullish/ordinal-sats-from-hal-finneys-first-mined-bitcoin-block-have-been-found-6636b3c4925e',
    },
  },
};

export type SatProvenance = BlockPosition & {
  sat: number;
  notable: NotableBlock | null;
  /** Unix seconds the block was mined. Exact (from our own node), not interpolated. */
  minedAt: number | null;
  /** Calendar year the sat was mined, e.g. '2009'. Null when the block time is unknown. */
  vintage: string | null;
  /**
   * ord's rarity tier. A sat is `uncommon` only when it is the FIRST sat of its
   * block. No OMB sat is — every one is `common`. Kept as a real field so the
   * UI can say that plainly instead of implying a tier that doesn't exist.
   */
  ordRarity: 'common' | 'uncommon';
};

const BLOCK_TIMES = baked.blockTimes as Record<string, number>;
const COLOR_DEFAULTS = baked.colorDefaults as Record<string, number>;
const EXPLICIT_SATS = baked.sats as Record<string, number>;

/** Colors whose sats are individually sourced (no single default block). */
export const VARIED_COLORS: readonly string[] = baked.variedColors;

/** Per-color default block, for the colors whose sats are uniform. */
export function defaultBlockForColor(color: string): number | null {
  return COLOR_DEFAULTS[color] ?? null;
}

/** The sat an inscription sits on, when the baked file carries it explicitly. */
export function satForInscription(inscriptionNumber: number): number | null {
  return EXPLICIT_SATS[String(inscriptionNumber)] ?? null;
}

export function blockMinedAt(height: number): number | null {
  return BLOCK_TIMES[String(height)] ?? null;
}

function vintageOf(minedAt: number | null): string | null {
  if (minedAt == null) return null;
  return String(new Date(minedAt * 1000).getUTCFullYear());
}

/** Full provenance for a known sat number. Null when the sat can't be decoded. */
export function satProvenance(sat: number): SatProvenance | null {
  const pos = blockForSat(sat);
  if (!pos) return null;
  const minedAt = blockMinedAt(pos.height);
  return {
    ...pos,
    sat,
    notable: NOTABLE_BLOCKS[pos.height] ?? null,
    minedAt,
    vintage: vintageOf(minedAt),
    ordRarity: pos.offsetInBlock === 0 ? 'uncommon' : 'common',
  };
}

/**
 * Provenance for a gallery piece, which knows its number and color but not its
 * sat. Uniform colors resolve through the per-color default (so we can name the
 * block without shipping 8,799 redundant sat numbers); varied colors resolve
 * through the explicit sat map.
 *
 * `sat` is null for uniform-color pieces — we genuinely don't ship it
 * client-side. The server detail page has the real value from SQLite.
 */
export type InscriptionProvenance = Omit<SatProvenance, 'sat' | 'offsetInBlock'> & {
  sat: number | null;
  offsetInBlock: number | null;
};

export function provenanceForInscription(
  inscriptionNumber: number,
  color: string
): InscriptionProvenance | null {
  const sat = satForInscription(inscriptionNumber);
  if (sat != null) {
    const p = satProvenance(sat);
    return p ? { ...p, sat: p.sat, offsetInBlock: p.offsetInBlock } : null;
  }
  const height = defaultBlockForColor(color);
  if (height == null) return null;
  const minedAt = blockMinedAt(height);
  return {
    height,
    epoch: Math.floor(height / HALVING_INTERVAL),
    offsetInBlock: null,
    sat: null,
    notable: NOTABLE_BLOCKS[height] ?? null,
    minedAt,
    vintage: vintageOf(minedAt),
    // Every OMB sat is common (none is a block's first sat); the uniform colors
    // are no exception, and the generator's invariant check keeps that true.
    ordRarity: 'common',
  };
}

/** Metadata about the baked file, for rendering "as of" lines honestly. */
export const SAT_PROVENANCE_META = {
  generatedAt: baked.generatedAt,
  source: baked.source,
  total: baked.total,
} as const;
