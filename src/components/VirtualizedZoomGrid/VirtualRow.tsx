"use client";

import React, { memo, useCallback, useRef } from 'react';
import { GalleryImage } from '@/lib/types';
import { useFavorites } from '@/lib/FavoritesContext';

// Get the appropriate thumbnail URL based on cell size
function getThumbnailUrl(originalThumbnail: string, cellSize: number): string {
  const useSmallThumbnail = cellSize < 50;
  if (useSmallThumbnail) {
    return originalThumbnail.replace('_128.webp', '_48.webp');
  }
  return originalThumbnail;
}

function inscriptionId(src: string): string {
  const file = src.split('/').pop() ?? '';
  return file.replace(/\.[^./]+$/, '');
}

interface VirtualRowProps {
  rowIndex: number;
  images: GalleryImage[];
  columnCount: number;
  cellSize: number;
  onImageClick: (index: number) => void;
  style: React.CSSProperties;
}

const VirtualRow = memo(
  function VirtualRow({
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
    const { isFavorite, toggleFavorite } = useFavorites();

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
      // Ignore if the click originated inside the favorite button.
      if ((e.target as HTMLElement).closest('[data-fav-btn]')) return;
      const target = e.target as HTMLElement;
      const cell = target.closest('[data-index]') as HTMLElement;
      if (cell) {
        mouseDownTime.current = Date.now();
        mouseDownIndex.current = parseInt(cell.dataset.index || '-1', 10);
      }
    }, []);

    const handleMouseUp = useCallback(
      (e: React.MouseEvent) => {
        if ((e.target as HTMLElement).closest('[data-fav-btn]')) return;
        const target = e.target as HTMLElement;
        const cell = target.closest('[data-index]') as HTMLElement;
        if (cell && mouseDownTime.current > 0) {
          const clickDuration = Date.now() - mouseDownTime.current;
          const index = parseInt(cell.dataset.index || '-1', 10);
          if (clickDuration < 300 && index === mouseDownIndex.current && index >= 0) {
            const img = images[index];
            // Shift-click toggles favorite instead of opening the modal.
            if (e.shiftKey && img) {
              toggleFavorite(img.src);
            } else {
              onImageClick(index);
            }
          }
        }
        mouseDownTime.current = 0;
        mouseDownIndex.current = -1;
      },
      [onImageClick, images, toggleFavorite]
    );

    const handleFavClick = useCallback(
      (e: React.MouseEvent<HTMLButtonElement>, src: string) => {
        e.stopPropagation();
        toggleFavorite(src);
      },
      [toggleFavorite]
    );

    // Labels only read well at mid-close zoom; same threshold gates the
    // hairline separator so it doesn't turn into visual noise at bird's-eye.
    const enableHover = columnCount <= 20;
    const cellShadow = enableHover ? 'inset 0 0 0 1px var(--ink-2)' : undefined;

    return (
      <div
        style={{
          ...style,
          display: 'flex',
          justifyContent: 'center',
          contain: enableHover ? 'layout style' : 'strict',
          willChange: 'transform',
          overflow: 'hidden',
        }}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
      >
        {rowImages.map((image, colIndex) => {
          const globalIndex = startIndex + colIndex;
          const thumbnailUrl = getThumbnailUrl(image.thumbnail, cellSize);
          const label = enableHover ? `#${inscriptionId(image.src)}` : undefined;

          const favorited = isFavorite(image.src);
          return (
            <div
              key={globalIndex}
              data-index={globalIndex}
              data-label={label}
              className={enableHover ? 'grid-cell-hover' : undefined}
              style={{
                width: cellSize,
                height: cellSize,
                flexShrink: 0,
                backgroundImage: `url(${thumbnailUrl})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                cursor: 'pointer',
                boxShadow: cellShadow,
              }}
            >
              {enableHover && (
                <button
                  type="button"
                  data-fav-btn=""
                  data-fav={favorited ? 'true' : undefined}
                  className="grid-cell-fav"
                  onClick={(e) => handleFavClick(e, image.src)}
                  onMouseDown={(e) => e.stopPropagation()}
                  onMouseUp={(e) => e.stopPropagation()}
                  aria-label={favorited ? 'Remove from favorites' : 'Add to favorites'}
                  aria-pressed={favorited}
                >
                  {favorited ? '♥' : '♡'}
                </button>
              )}
            </div>
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
  },
  (prevProps, nextProps) => {
    return (
      prevProps.rowIndex === nextProps.rowIndex &&
      prevProps.columnCount === nextProps.columnCount &&
      prevProps.cellSize === nextProps.cellSize &&
      prevProps.images === nextProps.images
    );
  }
);

export default VirtualRow;
