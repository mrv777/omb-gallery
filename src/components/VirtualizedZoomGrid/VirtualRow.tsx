'use client';

import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
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

const LONG_PRESS_MS = 500;
const TAP_MAX_MS = 300;
const MOVE_CANCEL_PX = 10;

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

    // Touch-device detection: gates heart rendering and chooses the long-press
    // gesture over the always-on hover heart.
    const [coarsePointer, setCoarsePointer] = useState(false);
    useEffect(() => {
      const mq = window.matchMedia('(hover: none) and (pointer: coarse)');
      const update = () => setCoarsePointer(mq.matches);
      update();
      mq.addEventListener('change', update);
      return () => mq.removeEventListener('change', update);
    }, []);

    // Long-press state
    const longPressTimer = useRef<number | null>(null);
    const touchStart = useRef<{ x: number; y: number; time: number; index: number } | null>(null);
    const longPressFired = useRef(false);
    const recentTouch = useRef(0);
    const [flashedKey, setFlashedKey] = useState<string | null>(null);
    const flashTimeout = useRef<number | null>(null);

    const cancelLongPress = useCallback(() => {
      if (longPressTimer.current !== null) {
        window.clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
      }
    }, []);

    useEffect(() => {
      return () => {
        if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
        if (flashTimeout.current !== null) window.clearTimeout(flashTimeout.current);
      };
    }, []);

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
      // Touch fires synthetic mouse events ~300ms later; ignore them so the
      // long-press flow doesn't double-fire.
      if (Date.now() - recentTouch.current < 500) return;
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
        if (Date.now() - recentTouch.current < 500) return;
        if ((e.target as HTMLElement).closest('[data-fav-btn]')) return;
        const target = e.target as HTMLElement;
        const cell = target.closest('[data-index]') as HTMLElement;
        if (cell && mouseDownTime.current > 0) {
          const clickDuration = Date.now() - mouseDownTime.current;
          const index = parseInt(cell.dataset.index || '-1', 10);
          if (clickDuration < TAP_MAX_MS && index === mouseDownIndex.current && index >= 0) {
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

    const flash = useCallback((key: string) => {
      setFlashedKey(key);
      if (flashTimeout.current !== null) window.clearTimeout(flashTimeout.current);
      flashTimeout.current = window.setTimeout(() => setFlashedKey(null), 300);
    }, []);

    const handleTouchStart = useCallback(
      (e: React.TouchEvent) => {
        // Multi-touch (pinch-to-zoom) — never long-press.
        if (e.touches.length > 1) {
          cancelLongPress();
          touchStart.current = null;
          return;
        }
        const target = e.target as HTMLElement;
        if (target.closest('[data-fav-btn]')) return;
        const cell = target.closest('[data-index]') as HTMLElement | null;
        if (!cell) return;
        const index = parseInt(cell.dataset.index || '-1', 10);
        if (index < 0 || index >= images.length) return;
        const t = e.touches[0];
        if (!t) return;
        touchStart.current = { x: t.clientX, y: t.clientY, time: Date.now(), index };
        longPressFired.current = false;
        cancelLongPress();
        longPressTimer.current = window.setTimeout(() => {
          const img = images[index];
          if (!img) return;
          longPressFired.current = true;
          toggleFavorite(img.src);
          if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
            navigator.vibrate(40);
          }
          flash(String(index));
        }, LONG_PRESS_MS);
      },
      [images, toggleFavorite, cancelLongPress, flash]
    );

    const handleTouchMove = useCallback(
      (e: React.TouchEvent) => {
        if (!touchStart.current) return;
        if (e.touches.length > 1) {
          cancelLongPress();
          return;
        }
        const t = e.touches[0];
        if (!t) return;
        const dx = t.clientX - touchStart.current.x;
        const dy = t.clientY - touchStart.current.y;
        if (Math.hypot(dx, dy) > MOVE_CANCEL_PX) cancelLongPress();
      },
      [cancelLongPress]
    );

    const handleTouchEnd = useCallback(() => {
      cancelLongPress();
      recentTouch.current = Date.now();
      const start = touchStart.current;
      touchStart.current = null;
      if (!start) return;
      if (longPressFired.current) {
        longPressFired.current = false;
        return;
      }
      const duration = Date.now() - start.time;
      if (duration < TAP_MAX_MS && start.index >= 0) {
        onImageClick(start.index);
      }
    }, [cancelLongPress, onImageClick]);

    const handleTouchCancel = useCallback(() => {
      cancelLongPress();
      touchStart.current = null;
      longPressFired.current = false;
    }, [cancelLongPress]);

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
    const showHeart = enableHover && !coarsePointer;

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
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
      >
        {rowImages.map((image, colIndex) => {
          const globalIndex = startIndex + colIndex;
          const thumbnailUrl = getThumbnailUrl(image.thumbnail, cellSize);
          const label = enableHover ? `#${inscriptionId(image.src)}` : undefined;

          const favorited = isFavorite(image.src);
          const isFlashed = flashedKey === String(globalIndex);
          // On touch the heart is gone — show a red ring on favorited cells so
          // users can still tell what they've saved at a glance.
          const cellBoxShadow =
            coarsePointer && favorited ? 'inset 0 0 0 2px var(--accent-red)' : cellShadow;
          return (
            <div
              key={globalIndex}
              data-index={globalIndex}
              data-label={label}
              className={`${enableHover ? 'grid-cell-hover' : ''} ${
                isFlashed ? 'grid-cell-flash' : ''
              }`.trim()}
              style={{
                width: cellSize,
                height: cellSize,
                flexShrink: 0,
                backgroundImage: `url(${thumbnailUrl})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                cursor: 'pointer',
                boxShadow: cellBoxShadow,
              }}
            >
              {showHeart && (
                <button
                  type="button"
                  data-fav-btn=""
                  data-fav={favorited ? 'true' : undefined}
                  className="grid-cell-fav"
                  onClick={e => handleFavClick(e, image.src)}
                  onMouseDown={e => e.stopPropagation()}
                  onMouseUp={e => e.stopPropagation()}
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
