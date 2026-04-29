import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { bumpSlideshowView, getSlideshow } from '@/lib/slideshowStore';
import { resolveSlideshowImages } from '@/lib/slideshowImages';
import Slideshow, {
  DEFAULT_SPEED,
  clampSpeed,
  type Order,
  type Speed,
} from '@/components/Slideshow/Slideshow';

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

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const row = getSlideshow(slug);
  if (!row) return { title: 'Slideshow · OMB Archive' };
  const label = row.title ? `"${row.title}"` : 'OMB Slideshow';
  const description = `${label} — ${row.image_count} inscription${row.image_count === 1 ? '' : 's'}.`;
  const title = row.title
    ? `${row.title} · OMB Slideshow`
    : `OMB Slideshow · ${row.image_count} image${row.image_count === 1 ? '' : 's'}`;
  return {
    title,
    description,
    openGraph: { title, description, type: 'website' },
    twitter: { card: 'summary', title, description },
  };
}

export default async function SharedSlideshowPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const row = getSlideshow(slug);
  if (!row) notFound();
  bumpSlideshowView(slug);

  const { images, missing } = resolveSlideshowImages(row.ids);
  const qp = await searchParams;

  return (
    <Slideshow
      images={images}
      missing={missing}
      title={row.title}
      shareSlug={slug}
      initialSpeed={parseSpeed(firstValue(qp.speed))}
      initialOrder={parseOrder(firstValue(qp.order))}
      initialLoop={parseLoop(firstValue(qp.loop))}
    />
  );
}
