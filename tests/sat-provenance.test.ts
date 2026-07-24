import { describe, expect, it } from 'vitest';

import baked from '@/data/collections/omb/sat-provenance.json';
import {
  HALVING_INTERVAL,
  INITIAL_SUBSIDY,
  NOTABLE_BLOCKS,
  VARIED_COLORS,
  blockForSat,
  defaultBlockForColor,
  provenanceForInscription,
  satForInscription,
  satProvenance,
} from '@/lib/satProvenance';

describe('blockForSat', () => {
  it('decodes the genesis sat', () => {
    expect(blockForSat(0)).toEqual({ height: 0, epoch: 0, offsetInBlock: 0 });
  });

  it('decodes the first sat of each early block', () => {
    expect(blockForSat(9 * INITIAL_SUBSIDY)).toEqual({ height: 9, epoch: 0, offsetInBlock: 0 });
    expect(blockForSat(78 * INITIAL_SUBSIDY)).toEqual({ height: 78, epoch: 0, offsetInBlock: 0 });
  });

  it('decodes a mid-block sat with its offset', () => {
    // The earliest OMB red sat: block 30,917, well inside epoch 0.
    expect(blockForSat(154_589_387_704_014)).toEqual({
      height: 30_917,
      epoch: 0,
      offsetInBlock: 154_589_387_704_014 - 30_917 * INITIAL_SUBSIDY,
    });
  });

  it('handles the epoch 0 → 1 boundary exactly', () => {
    const firstEpoch1Sat = INITIAL_SUBSIDY * HALVING_INTERVAL;
    expect(blockForSat(firstEpoch1Sat - 1)).toEqual({
      height: HALVING_INTERVAL - 1,
      epoch: 0,
      offsetInBlock: INITIAL_SUBSIDY - 1,
    });
    expect(blockForSat(firstEpoch1Sat)).toEqual({
      height: HALVING_INTERVAL,
      epoch: 1,
      offsetInBlock: 0,
    });
  });

  it('rejects nonsense rather than fabricating a height', () => {
    expect(blockForSat(-1)).toBeNull();
    expect(blockForSat(1.5)).toBeNull();
    expect(blockForSat(Number.NaN)).toBeNull();
    // Past the last subsidy epoch — no real sat lives here.
    expect(blockForSat(Number.MAX_SAFE_INTEGER)).toBeNull();
  });
});

describe('satProvenance', () => {
  it('names block 9 as attributed, not proven', () => {
    const p = satProvenance(45_015_167_499)!;
    expect(p.height).toBe(9);
    expect(p.notable?.attributedMiner).toBe('Satoshi Nakamoto');
    // The Patoshi pattern is an inference. Flattening this to 'proven' is the
    // exact mistake this field exists to prevent.
    expect(p.notable?.confidence).toBe('attributed');
    expect(p.vintage).toBe('2009');
  });

  it('reports every OMB sat as ord-common', () => {
    // No OMB sat is the first sat of its block, so there is no rarity tier to
    // chase. If this ever fails, the collection acquired an uncommon sat and
    // the /history copy needs revisiting.
    for (const [num, sat] of Object.entries(baked.sats as Record<string, number>)) {
      const p = satProvenance(sat);
      expect(p, `#${num} sat ${sat} should decode`).not.toBeNull();
      expect(p!.ordRarity, `#${num} should be common`).toBe('common');
    }
  });
});

describe('committed sat-provenance.json', () => {
  // Guards the baked file from the reader's side; scripts/build-sat-provenance.js
  // guards it from the writer's side. Corrupting a colorDefaults entry must fail
  // here even if nobody re-runs the generator.
  it('still has every uniform color on the block it claims', () => {
    expect(baked.colorDefaults).toEqual({ black: 9, blue: 78, green: 9, orange: 9 });
    for (const height of Object.values(baked.colorDefaults as Record<string, number>)) {
      expect(NOTABLE_BLOCKS[height], `block ${height} should be a named block`).toBeDefined();
      expect(baked.blockTimes[String(height) as keyof typeof baked.blockTimes]).toBeTypeOf(
        'number'
      );
    }
  });

  it('carries an explicit sat for every varied-color piece and no others', () => {
    expect(VARIED_COLORS).toEqual(['red']);
    expect(Object.keys(baked.sats)).toHaveLength(102);
    expect(baked.total).toBe(9001);
  });

  it('has a block time for every block its sats decode to', () => {
    for (const sat of Object.values(baked.sats as Record<string, number>)) {
      const pos = blockForSat(sat)!;
      expect(
        baked.blockTimes[String(pos.height) as keyof typeof baked.blockTimes],
        `missing block time for height ${pos.height}`
      ).toBeTypeOf('number');
    }
  });

  it('stays small enough to ship to every gallery visitor', () => {
    // The whole point of the per-color-default compression. A jump here means
    // someone baked all 9,001 sats — see the header of the generator script.
    expect(JSON.stringify(baked).length).toBeLessThan(20_000);
  });
});

describe('provenanceForInscription', () => {
  it('resolves a uniform color through its default block, without a sat', () => {
    // Orange #60563252 — the all-time-high sale. Client-side we know its block
    // but deliberately do not ship its sat number.
    const p = provenanceForInscription(60_563_252, 'orange')!;
    expect(p.height).toBe(9);
    expect(p.sat).toBeNull();
    expect(p.offsetInBlock).toBeNull();
    expect(p.notable?.nickname).toBe('nineball');
  });

  it('resolves a red through its explicit sat', () => {
    const p = provenanceForInscription(489_040, 'red')!;
    expect(satForInscription(489_040)).toBe(154_589_387_704_014);
    expect(p.height).toBe(30_917);
    expect(p.sat).toBe(154_589_387_704_014);
    // The only OMB on a 2009 satoshi.
    expect(p.vintage).toBe('2009');
    expect(p.notable).toBeNull();
  });

  it('returns null for an unknown color rather than guessing', () => {
    expect(defaultBlockForColor('chartreuse')).toBeNull();
    expect(provenanceForInscription(1, 'chartreuse')).toBeNull();
  });
});
