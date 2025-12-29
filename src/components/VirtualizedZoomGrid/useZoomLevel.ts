import { useState, useCallback, useRef } from 'react';
import {
  ZOOM_LEVELS,
  DEFAULT_ZOOM_INDEX,
  MIN_ZOOM_INDEX,
  MAX_ZOOM_INDEX,
  ZOOM_DELTA_THRESHOLD
} from './constants';

export function useZoomLevel() {
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);
  const accumulatedDelta = useRef(0);

  const handleZoomGesture = useCallback((delta: number, isDiscrete: boolean) => {
    if (isDiscrete) {
      // Discrete changes (keyboard, button clicks)
      setZoomIndex(prev => {
        // Positive delta = zoom in (fewer columns)
        // Negative delta = zoom out (more columns)
        const next = delta > 0
          ? Math.max(MIN_ZOOM_INDEX, prev - 1)
          : Math.min(MAX_ZOOM_INDEX, prev + 1);
        return next;
      });
    } else {
      // Continuous changes (pinch, wheel)
      accumulatedDelta.current += delta;

      if (Math.abs(accumulatedDelta.current) > ZOOM_DELTA_THRESHOLD) {
        const direction = accumulatedDelta.current > 0 ? 1 : -1; // Positive = zoom out
        setZoomIndex(prev => {
          const next = Math.max(MIN_ZOOM_INDEX, Math.min(MAX_ZOOM_INDEX, prev + direction));
          return next;
        });
        accumulatedDelta.current = 0;
      }
    }
  }, []);

  const zoomIn = useCallback(() => {
    handleZoomGesture(1, true);
  }, [handleZoomGesture]);

  const zoomOut = useCallback(() => {
    handleZoomGesture(-1, true);
  }, [handleZoomGesture]);

  const resetZoom = useCallback(() => {
    setZoomIndex(DEFAULT_ZOOM_INDEX);
    accumulatedDelta.current = 0;
  }, []);

  return {
    zoomIndex,
    columnCount: ZOOM_LEVELS[zoomIndex].columns,
    handleZoomGesture,
    zoomIn,
    zoomOut,
    resetZoom,
    canZoomIn: zoomIndex > MIN_ZOOM_INDEX,
    canZoomOut: zoomIndex < MAX_ZOOM_INDEX,
  };
}
