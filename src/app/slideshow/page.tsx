import type { Metadata } from 'next';
import { decodeIds } from '@/lib/slideshowCodec';
import { resolveSlideshowImages } from '@/lib/slideshowImages';
import Slideshow, { DEFAULT_SPEED, clampSpeed, type Order, type Speed } from '@/components/Slideshow/Slideshow';

export const metadata: Metadata = {
  title: 'Slideshow · OMB Archive',
  description: 'Play through OMB inscriptions in sequence.',
};

function parseSpeed(raw: string | undefined): Speed {
  if (!raw) return DEFAULT_SPEED;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_SPEED;
  return clampSpeed(n);
}

function parseOrder(raw: string | undefined): Order {
  return raw === 'random' ? 'random' : 'seq';
}

function parseLoop(raw: string | undefined): boolean {
  if (raw === '0' || raw === 'false') return false;
  return true;
}

function firstValue(raw: string | string[] | undefined): string | undefined {
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

export default async function SlideshowPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const encoded = firstValue(params.ids) ?? '';
  const title = firstValue(params.title) ?? null;

  let ids: string[] = [];
  if (encoded) {
    try {
      ids = decodeIds(encoded);
    } catch {
      ids = [];
    }
  }
  const { images, missing } = resolveSlideshowImages(ids);

  return (
    <Slideshow
      images={images}
      missing={missing}
      title={title && title.trim() ? title.trim() : null}
      shareSlug={null}
      initialSpeed={parseSpeed(firstValue(params.speed))}
      initialOrder={parseOrder(firstValue(params.order))}
      initialLoop={parseLoop(firstValue(params.loop))}
    />
  );
}
