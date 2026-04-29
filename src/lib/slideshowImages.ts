import 'server-only';
import { lookupInscription } from './inscriptionLookup';

export type SlideshowImage = {
  id: string;
  src: string;
  color: string;
  caption: string;
};

export function resolveSlideshowImages(ids: string[]): {
  images: SlideshowImage[];
  missing: number;
} {
  const images: SlideshowImage[] = [];
  let missing = 0;
  for (const idStr of ids) {
    const num = Number(idStr);
    if (!Number.isFinite(num)) {
      missing++;
      continue;
    }
    const hit = lookupInscription(num);
    if (!hit) {
      missing++;
      continue;
    }
    images.push({
      id: idStr,
      src: hit.full,
      color: hit.color,
      caption: hit.description,
    });
  }
  return { images, missing };
}
