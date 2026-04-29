export const ZOOM_LEVELS = [
  { columns: 2 },
  { columns: 3 },
  { columns: 5 },
  { columns: 8 },
  { columns: 10 },
  { columns: 15 },
  { columns: 20 },
  { columns: 25 },
  { columns: 30 },
  { columns: 35 },
  { columns: 40 },
  { columns: 45 },
  { columns: 50 },
] as const;

export const DEFAULT_ZOOM_INDEX = 4; // 10 columns
export const MIN_ZOOM_INDEX = 0; // 2 columns (most zoomed in)
export const MAX_ZOOM_INDEX = ZOOM_LEVELS.length - 1; // 50 columns (most zoomed out)

// Threshold for continuous zoom gestures (prevents over-sensitivity)
export const ZOOM_DELTA_THRESHOLD = 50;
