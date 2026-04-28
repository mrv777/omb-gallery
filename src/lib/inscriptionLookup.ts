import imageData from '../data/collections/omb/inscriptions.json';

type ImageEntry = { filename: string; description: string; tags: string[] };
type ImagesByColor = Record<string, ImageEntry[]>;

export type LookupHit = {
  color: string;
  thumbnail: string;
  full: string;
  description: string;
};

const THUMBNAIL_SIZE = 128;

let cached: Map<number, LookupHit> | null = null;

export function getInscriptionLookup(): Map<number, LookupHit> {
  if (cached) return cached;
  const map = new Map<number, LookupHit>();
  const data = imageData as ImagesByColor;
  for (const [color, list] of Object.entries(data)) {
    for (const entry of list) {
      const stem = entry.filename.replace(/\.[^/.]+$/, '');
      const num = Number(stem);
      if (!Number.isFinite(num)) continue;
      map.set(num, {
        color,
        thumbnail: `/optimized-images/${color}/${stem}_${THUMBNAIL_SIZE}.webp`,
        full: `/images/${color}/${entry.filename}`,
        description: entry.description ?? '',
      });
    }
  }
  cached = map;
  return map;
}

export function lookupInscription(num: number): LookupHit | undefined {
  return getInscriptionLookup().get(num);
}
