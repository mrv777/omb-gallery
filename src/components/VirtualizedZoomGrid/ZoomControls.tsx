"use client";

import React, { memo } from 'react';

interface ZoomControlsProps {
  columnCount: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  canZoomIn: boolean;
  canZoomOut: boolean;
}

const ZoomControls = memo(function ZoomControls({
  columnCount,
  onZoomIn,
  onZoomOut,
  canZoomIn,
  canZoomOut,
}: ZoomControlsProps) {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2 bg-black bg-opacity-60 dark:bg-gray-800 dark:bg-opacity-80 rounded-full px-3 py-2 shadow-lg">
      <button
        onClick={onZoomIn}
        disabled={!canZoomIn}
        className={`w-8 h-8 flex items-center justify-center rounded-full text-white text-lg font-bold transition-colors ${
          canZoomIn
            ? 'hover:bg-white hover:bg-opacity-20 active:bg-opacity-30'
            : 'opacity-40 cursor-not-allowed'
        }`}
        aria-label="Zoom in (fewer columns)"
      >
        +
      </button>
      <span className="text-white text-sm font-medium min-w-[50px] text-center">
        {columnCount} col{columnCount !== 1 ? 's' : ''}
      </span>
      <button
        onClick={onZoomOut}
        disabled={!canZoomOut}
        className={`w-8 h-8 flex items-center justify-center rounded-full text-white text-lg font-bold transition-colors ${
          canZoomOut
            ? 'hover:bg-white hover:bg-opacity-20 active:bg-opacity-30'
            : 'opacity-40 cursor-not-allowed'
        }`}
        aria-label="Zoom out (more columns)"
      >
        −
      </button>
    </div>
  );
});

export default ZoomControls;
