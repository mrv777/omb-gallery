'use client';

import { useColorFilter } from '@/lib/useColorFilter';
import ColorSwatches from './ColorSwatches';

/** Client wrapper around ColorSwatches bound to the URL `?color=` param.
 * Drop into SubpageShell.headerControls on /activity and /explorer so the
 * filter persists across the gallery → activity → explorer triad. */
export default function HeaderColorSwatches() {
  const { color, setColor } = useColorFilter();
  return <ColorSwatches color={color} onChange={setColor} />;
}
