import { describe, expect, it } from 'vitest';
import { nextSlideshowSeed, shuffledIndices, slideshowSeed } from '../src/lib/slideshowShuffle';

describe('slideshow shuffle', () => {
  it('is deterministic for hydration and remains a complete permutation', () => {
    const seed = slideshowSeed(['1', '2', '3', '4', '5']);
    const first = shuffledIndices(5, seed);
    expect(shuffledIndices(5, seed)).toEqual(first);
    expect(first.toSorted((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it('uses a new deterministic seed when random mode is enabled again', () => {
    const seed = slideshowSeed(['10', '20', '30', '40', '50', '60']);
    expect(nextSlideshowSeed(seed)).not.toBe(seed);
    expect(shuffledIndices(6, nextSlideshowSeed(seed))).not.toEqual(shuffledIndices(6, seed));
  });
});
