'use client';

import { useState, type ImgHTMLAttributes, type ReactNode } from 'react';

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  src: string | null | undefined;
  /** Rendered when src is missing or the image fails to load. Defaults to nothing. */
  fallback?: ReactNode;
};

/** <img> that swaps to `fallback` (or renders nothing) on load error or missing
 * src. Use for any external/user-supplied image where 404s are realistic —
 * matrica avatars, ordinals.com content, etc. Local OMB thumbnails are baked
 * into the image and don't need this. */
export default function SafeImg({ src, fallback = null, alt = '', ...rest }: Props) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <>{fallback}</>;
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      key={src}
      src={src}
      alt={alt}
      onError={() => setFailed(true)}
      {...rest}
    />
  );
}
