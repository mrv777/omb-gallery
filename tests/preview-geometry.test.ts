import { describe, expect, it } from 'vitest';

import {
  PREVIEW_MAX_CELL_PX,
  computePreviewPlacement,
  isPreviewEnabled,
  type Rect,
} from '@/components/VirtualizedZoomGrid/previewGeometry';

const VIEWPORT = { width: 1440, height: 900 };
// Scroll container sits below an 88px toolbar and runs to the bottom.
const BOUNDS: Rect = { left: 0, top: 88, width: 1440, height: 812 };
const SIZE = 256;
const GAP = 10;
const PAD = 12;

const place = (anchor: Rect, viewport = VIEWPORT, bounds = BOUNDS) =>
  computePreviewPlacement(anchor, bounds, viewport, SIZE, GAP, PAD);

describe('isPreviewEnabled', () => {
  it('is off before the container has measured', () => {
    // cellSize defaults to 100 pre-measure and is 0 if width is 0.
    expect(isPreviewEnabled(0)).toBe(false);
    expect(isPreviewEnabled(100)).toBe(false);
  });

  it('is on for small cells, off for large ones', () => {
    expect(isPreviewEnabled(28)).toBe(true); // 50 cols @ 1440
    expect(isPreviewEnabled(48)).toBe(true); // 30 cols @ 1440
    expect(isPreviewEnabled(PREVIEW_MAX_CELL_PX)).toBe(true); // 20 cols @ 1440
    expect(isPreviewEnabled(PREVIEW_MAX_CELL_PX + 1)).toBe(false);
    expect(isPreviewEnabled(96)).toBe(false); // 15 cols @ 1440
    expect(isPreviewEnabled(720)).toBe(false); // 2 cols @ 1440
  });
});

describe('computePreviewPlacement', () => {
  it('sits to the right of the cell and is vertically centred on it', () => {
    const anchor: Rect = { left: 700, top: 400, width: 28, height: 28 };
    const { x, y, side } = place(anchor);
    expect(side).toBe('right');
    expect(x).toBe(700 + 28 + GAP);
    expect(y).toBe(400 + 14 - SIZE / 2);
  });

  it('flips to the left when the card would run past the right edge', () => {
    // Right-most column of a 50-col grid.
    const anchor: Rect = { left: 1400, top: 400, width: 28, height: 28 };
    const { x, side } = place(anchor);
    expect(side).toBe('left');
    expect(x).toBe(1400 - GAP - SIZE);
  });

  it('keeps the card on-screen when flipping left near the left edge too', () => {
    const anchor: Rect = { left: 1436, top: 400, width: 4, height: 28 };
    const narrow = { width: 260, height: 900 };
    const { x } = place(anchor, narrow, { left: 0, top: 88, width: 260, height: 812 });
    expect(x).toBeGreaterThanOrEqual(PAD);
  });

  it('never rides up over the header', () => {
    // Cell in the very first visible row.
    const anchor: Rect = { left: 300, top: 90, width: 28, height: 28 };
    const { y } = place(anchor);
    expect(y).toBe(BOUNDS.top + PAD);
    expect(y).toBeGreaterThanOrEqual(BOUNDS.top);
  });

  it('clamps to the bottom of the viewport', () => {
    const anchor: Rect = { left: 300, top: 880, width: 28, height: 28 };
    const { y } = place(anchor);
    expect(y).toBe(VIEWPORT.height - SIZE - PAD);
    expect(y + SIZE).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it('clamps against the container bottom when it is shorter than the viewport', () => {
    const shortBounds: Rect = { left: 0, top: 88, width: 1440, height: 400 };
    const anchor: Rect = { left: 300, top: 460, width: 28, height: 28 };
    const { y } = place(anchor, VIEWPORT, shortBounds);
    expect(y).toBe(88 + 400 - SIZE - PAD);
  });

  it('degrades to the pad, not NaN or a negative, when the card cannot fit', () => {
    const tiny = { width: 200, height: 200 };
    const tinyBounds: Rect = { left: 0, top: 0, width: 200, height: 200 };
    const anchor: Rect = { left: 100, top: 100, width: 28, height: 28 };
    const { x, y } = place(anchor, tiny, tinyBounds);
    expect(x).toBe(PAD);
    expect(y).toBe(PAD);
    expect(Number.isFinite(x)).toBe(true);
    expect(Number.isFinite(y)).toBe(true);
  });

  it('returns integers so the transform lands on whole pixels', () => {
    const anchor: Rect = { left: 700, top: 401, width: 27, height: 27 };
    const { x, y } = place(anchor);
    expect(Number.isInteger(x)).toBe(true);
    expect(Number.isInteger(y)).toBe(true);
  });
});
