export function slideshowSeed(ids: readonly string[]): number {
  let hash = 0x811c9dc5;
  for (const id of ids) {
    for (let index = 0; index < id.length; index++) {
      hash ^= id.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function nextSlideshowSeed(seed: number): number {
  return (Math.imul(seed >>> 0, 1664525) + 1013904223) >>> 0;
}

export function shuffledIndices(length: number, seed: number): number[] {
  const indices = Array.from({ length }, (_, index) => index);
  let state = seed >>> 0;
  const random = () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  for (let index = indices.length - 1; index > 0; index--) {
    const swapWith = Math.floor(random() * (index + 1));
    [indices[index], indices[swapWith]] = [indices[swapWith]!, indices[index]!];
  }
  return indices;
}
