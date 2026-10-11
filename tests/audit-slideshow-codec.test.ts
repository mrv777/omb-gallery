import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { decodeIds, encodeIds } from '../src/lib/slideshowCodec';
import { shuffledIndices } from '../src/lib/slideshowShuffle';

describe('audit: slideshow deterministic property checks', () => {
  it('round-trips valid integer playlists through sort and deduplication', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 99_999_999 }), { maxLength: 1500 }), nums => {
        const expected = Array.from(new Set(nums))
          .sort((a, b) => a - b)
          .map(String);
        expect(decodeIds(encodeIds(nums.map(String)))).toEqual(expected);
      }),
      { seed: 10112026, numRuns: 1000 }
    );
  });
  it('always yields a deterministic complete shuffle for random lengths and seeds', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1500 }),
        fc.integer({ min: 0, max: 0xffffffff }),
        (length, seed) => {
          const shuffled = shuffledIndices(length, seed);
          expect(shuffledIndices(length, seed)).toEqual(shuffled);
          expect(shuffled.toSorted((a, b) => a - b)).toEqual(Array.from({ length }, (_, i) => i));
        }
      ),
      { seed: 10112026, numRuns: 1000 }
    );
  });
  it('rejects a truncated encoded varint', () => {
    expect(() => decodeIds('gA')).toThrow('truncated varint');
  });
});
