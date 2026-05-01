import type { Metadata } from 'next';

// Brand surface in one place. Renames touch a single file (plus copy in
// telegram/discord which are intentionally per-channel).
export const SITE_NAME = 'OMB Wiki';
export const SITE_DESCRIPTION = 'The Ordinal Maxi Biz wiki.';

// 1200×630 site fallback. Keep the literal URL in sync with the asset path
// at public/og/default.png. metadataBase resolves the relative path to absolute.
export const DEFAULT_OG_IMAGE = {
  url: '/og/default.png',
  width: 1200,
  height: 630,
  alt: SITE_NAME,
} as const;

type OgImage = { url: string; width?: number; height?: number; alt?: string };

// Next merges metadata across segments shallowly: a child's `openGraph`
// object replaces the parent's wholesale (per
// https://nextjs.org/docs/app/api-reference/functions/generate-metadata#merging).
// To preserve the layout-level default image whenever a route overrides
// `openGraph` for any reason, every override goes through this helper so the
// shared defaults (siteName, type, image, twitter card) are spread in
// explicitly.
export function buildSocial(args: {
  /** Title used for og:title and twitter:title. Should already include the
   *  brand suffix when the route's metadata.title relies on a parent template. */
  title: string;
  description: string;
  /** A route-specific image (e.g. an inscription thumbnail or a holder
   *  avatar). When present, the Twitter card downgrades to `summary` (small
   *  square) since these images are typically 256–336px squares. When
   *  absent, falls through to DEFAULT_OG_IMAGE with the large card. */
  customImage?: OgImage;
}): Pick<Metadata, 'openGraph' | 'twitter'> {
  const { title, description, customImage } = args;
  if (customImage) {
    return {
      openGraph: {
        type: 'website',
        siteName: SITE_NAME,
        title,
        description,
        images: [customImage],
      },
      twitter: {
        card: 'summary',
        title,
        description,
        images: [customImage.url],
      },
    };
  }
  return {
    openGraph: {
      type: 'website',
      siteName: SITE_NAME,
      title,
      description,
      images: [DEFAULT_OG_IMAGE],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [DEFAULT_OG_IMAGE.url],
    },
  };
}
