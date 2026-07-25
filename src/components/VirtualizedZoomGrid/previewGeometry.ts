/**
 * Placement math for the grid's hover preview card. Framework-free and pure so
 * it can be unit-tested in the repo's node vitest env (no jsdom is configured).
 */

/**
 * Cells at or below this many pixels get a hover preview. Deliberately a px
 * threshold and not a column count: 20 columns is 72px wide at 1440px but 96px
 * at 1920px, and the question "is this tile too small to read" is about pixels.
 *
 * On a 1440px viewport this turns on at 20 columns; on 1920px, at 30.
 */
export const PREVIEW_MAX_CELL_PX = 72;

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Placement {
  x: number;
  y: number;
  side: 'left' | 'right';
}

function clamp(v: number, min: number, max: number): number {
  // max < min happens when the card can't fit between the pads at all (very
  // narrow viewport). Pinning to min keeps the card on-screen-ish instead of
  // returning a coordinate above the clamp floor.
  if (max < min) return min;
  return Math.min(Math.max(v, min), max);
}

/**
 * `cellSize` is 100 before the container has measured (see VirtualizedZoomGrid),
 * and 0 is not a real layout — both must read as "off".
 */
export function isPreviewEnabled(cellSize: number): boolean {
  return cellSize > 0 && cellSize <= PREVIEW_MAX_CELL_PX;
}

/**
 * Place a `size`-square card beside `anchor`, vertically centred on it.
 *
 * Prefers the right of the cell, flipping left when the card would run past the
 * viewport edge. The side is decided from the *cell* rect rather than the cursor
 * so it stays put for as long as the pointer is on a given cell — sweeping the
 * right-hand column yields a consistently left-side card, not a flicker.
 *
 * Vertical travel is clamped into `bounds` (the scroll container) so the card
 * can never ride up over the header toolbar.
 *
 * All rects are viewport coordinates, as returned by getBoundingClientRect().
 */
export function computePreviewPlacement(
  anchor: Rect,
  bounds: Rect,
  viewport: { width: number; height: number },
  size: number,
  gap: number,
  pad: number
): Placement {
  const anchorRight = anchor.left + anchor.width;

  let side: Placement['side'] = 'right';
  let x = anchorRight + gap;
  if (x + size + pad > viewport.width) {
    side = 'left';
    x = anchor.left - gap - size;
  }
  x = clamp(x, pad, viewport.width - size - pad);

  const boundsBottom = bounds.top + bounds.height;
  const minY = Math.max(pad, bounds.top + pad);
  const maxY = Math.min(viewport.height, boundsBottom) - size - pad;
  const y = clamp(anchor.top + anchor.height / 2 - size / 2, minY, maxY);

  return { x: Math.round(x), y: Math.round(y), side };
}
