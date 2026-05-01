import ombData from '../data/collections/omb/inscriptions.json';
import bravocadosData from '../data/collections/bravocados/inscriptions.json';

type OmbEntry = { filename: string; description: string; tags: string[] };
type OmbByColor = Record<string, OmbEntry[]>;
type BravocadosEntry = { inscription_id: string; inscription_number: number };

export type LookupHit = {
  /** OMBs have one of the five color groups; bravocados have null. */
  color: string | null;
  thumbnail: string;
  full: string;
  description: string;
  /** Which collection the hit came from. */
  kind: 'omb' | 'bravocados';
  /** Stable ordinal id when known. OMB seed data has only the inscription
   * number, so this is null until the on-chain poller reconciles. */
  inscriptionId: string | null;
  /** True when `thumbnail` / `full` point to a remote URL (ordinals.com).
   * Renderers should use SafeImg for these. */
  external: boolean;
};

const THUMBNAIL_SIZE = 128;

let cached: Map<number, LookupHit> | null = null;

export function getInscriptionLookup(): Map<number, LookupHit> {
  if (cached) return cached;
  const map = new Map<number, LookupHit>();

  const omb = ombData as OmbByColor;
  for (const [color, list] of Object.entries(omb)) {
    for (const entry of list) {
      const stem = entry.filename.replace(/\.[^/.]+$/, '');
      const num = Number(stem);
      if (!Number.isFinite(num)) continue;
      map.set(num, {
        color,
        thumbnail: `/optimized-images/${color}/${stem}_${THUMBNAIL_SIZE}.webp`,
        full: `/images/${color}/${entry.filename}`,
        description: entry.description ?? '',
        kind: 'omb',
        inscriptionId: null,
        external: false,
      });
    }
  }

  // Bravocados: no local thumbnails — pulled live from ordinals.com via SafeImg.
  for (const entry of bravocadosData as BravocadosEntry[]) {
    if (!Number.isFinite(entry.inscription_number)) continue;
    map.set(entry.inscription_number, {
      color: null,
      thumbnail: `https://ordinals.com/content/${entry.inscription_id}`,
      full: `https://ordinals.com/content/${entry.inscription_id}`,
      description: '',
      kind: 'bravocados',
      inscriptionId: entry.inscription_id,
      external: true,
    });
  }

  cached = map;
  return map;
}

export function lookupInscription(num: number): LookupHit | undefined {
  return getInscriptionLookup().get(num);
}
