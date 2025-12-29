"use client";

import React, { memo, useCallback, useRef } from 'react';
import { GalleryImage } from '@/lib/types';

// Get the appropriate thumbnail URL based on cell size
function getThumbnailUrl(originalThumbnail: string, cellSize: number): string {
  const useSmallThumbnail = cellSize < 50;
  if (useSmallThumbnail) {
    return originalThumbnail.replace('_128.webp', '_48.webp');
  }
  return originalThumbnail;
}

interface VirtualRowProps {
  rowIndex: number;
  images: GalleryImage[];
  columnCount: number;
  cellSize: number;
  onImageClick: (index: number) => void;
  style: React.CSSProperties;
}

const VirtualRow = memo(function VirtualRow({
  rowIndex,
  images,
  columnCount,
  cellSize,
  onImageClick,
  style,
}: VirtualRowProps) {
  const startIndex = rowIndex * columnCount;
  const endIndex = Math.min(startIndex + columnCount, images.length);
  const rowImages = images.slice(startIndex, endIndex);
  const mouseDownTime = useRef<number>(0);
  const mouseDownIndex = useRef<number>(-1);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const cell = target.closest('[data-index]') as HTMLElement;
    if (cell) {
      mouseDownTime.current = Date.now();
      mouseDownIndex.current = parseInt(cell.dataset.index || '-1', 10);
    }
  }, []);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const cell = target.closest('[data-index]') as HTMLElement;
    if (cell && mouseDownTime.current > 0) {
      const clickDuration = Date.now() - mouseDownTime.current;
      const index = parseInt(cell.dataset.index || '-1', 10);
      if (clickDuration < 300 && index === mouseDownIndex.current && index >= 0) {
        onImageClick(index);
      }
    }
    mouseDownTime.current = 0;
    mouseDownIndex.current = -1;
  }, [onImageClick]);

  const enableHover = columnCount <= 20;

  return (
    <div
      style={{
        ...style,
        display: 'flex',
        contain: enableHover ? 'layout style' : 'strict',
        willChange: 'transform',
        overflow: enableHover ? 'visible' : undefined,
      }}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
    >
      {rowImages.map((image, colIndex) => {
        const globalIndex = startIndex + colIndex;
        const thumbnailUrl = getThumbnailUrl(image.thumbnail, cellSize);

        return (
          <div
            key={globalIndex}
            data-index={globalIndex}
            className={enableHover ? 'grid-cell-hover' : undefined}
            style={{
              width: cellSize,
              height: cellSize,
              flexShrink: 0,
              backgroundImage: `url(${thumbnailUrl})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              cursor: 'pointer',
            }}
          />
        );
      })}
      {rowImages.length < columnCount &&
        Array(columnCount - rowImages.length)
          .fill(null)
          .map((_, i) => (
            <div
              key={`empty-${i}`}
              style={{ width: cellSize, height: cellSize, flexShrink: 0 }}
            />
          ))}
    </div>
  );
}, (prevProps, nextProps) => {
  return (
    prevProps.rowIndex === nextProps.rowIndex &&
    prevProps.columnCount === nextProps.columnCount &&
    prevProps.cellSize === nextProps.cellSize &&
    prevProps.images === nextProps.images
  );
});

export default VirtualRow;
