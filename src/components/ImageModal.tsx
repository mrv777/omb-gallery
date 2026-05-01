'use client';

import React, { memo, useEffect, useRef } from 'react';
import Image from 'next/image';
import { GalleryImage } from '@/lib/types';
import { useFavorites } from '@/lib/FavoritesContext';
import NotificationButton, { BellIcon } from './NotificationButton/NotificationButton';
import { Tooltip } from './ui/Tooltip';

interface ImageModalProps {
  onClose: () => void;
  currentImage: number;
  images: GalleryImage[];
  onPrev: () => void;
  onNext: () => void;
}

const COLOR_LABELS: Record<string, string> = {
  red: 'RED',
  blue: 'BLUE',
  green: 'GREEN',
  orange: 'ORANGE',
  black: 'BLACK',
};

function inscriptionId(src: string): string {
  const file = src.split('/').pop() ?? '';
  return file.replace(/\.[^./]+$/, '');
}

const ImageModal = memo(function ImageModal({
  onClose,
  currentImage,
  images,
  onPrev,
  onNext,
}: ImageModalProps) {
  const { isFavorite, toggleFavorite } = useFavorites();

  // Touch-swipe horizontal nav (mirror of the slideshow gesture). Declared
  // before any conditional return to keep hook order stable.
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  // Warm the browser cache for the adjacent pieces so arrow-key nav is
  // instant. Effect runs after paint, so it doesn't starve the current
  // image's initial load. Wraps at the ends of the list.
  useEffect(() => {
    if (images.length < 2 || currentImage < 0 || currentImage >= images.length) return;
    const len = images.length;
    const neighbors = [images[(currentImage - 1 + len) % len], images[(currentImage + 1) % len]];
    const loaders: HTMLImageElement[] = [];
    for (const neighbor of neighbors) {
      if (!neighbor || neighbor === images[currentImage]) continue;
      const img = new window.Image();
      img.decoding = 'async';
      img.src = neighbor.src;
      loaders.push(img);
    }
    return () => {
      for (const img of loaders) {
        img.onload = null;
        img.onerror = null;
      }
    };
  }, [currentImage, images]);

  if (images.length === 0 || currentImage < 0 || currentImage >= images.length) {
    return null;
  }

  const image = images[currentImage];
  const favorited = isFavorite(image.src);
  const id = inscriptionId(image.src);
  const colorLabel = COLOR_LABELS[image.color] ?? image.color.toUpperCase();

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    touchStart.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (!touchStart.current) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.current.x;
    const dy = t.clientY - touchStart.current.y;
    touchStart.current = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) onNext();
      else onPrev();
    }
  };

  return (
    <div className="fixed inset-0 bg-ink-0 z-[1500] flex flex-col" onClick={onClose}>
      {/* Top chrome: inscription / color / close */}
      <div
        className="flex items-center justify-between pl-4 sm:pl-6 pr-1 sm:pr-2 py-1 font-mono text-xs tracking-[0.12em] uppercase text-bone-dim shrink-0"
        onClick={e => e.stopPropagation()}
      >
        <div className="text-bone">
          <Tooltip content="View on ordinals.com">
            <a
              href={`https://ordinals.com/inscription/${id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline underline-offset-4 decoration-bone-dim"
            >
              #{id}
            </a>
          </Tooltip>
          <span className="mx-2 text-bone-dim">·</span>
          <span>{colorLabel}</span>
          <span className="mx-2 text-bone-dim hidden sm:inline">·</span>
          <span className="text-bone-dim hidden sm:inline">
            {currentImage + 1}/{images.length}
          </span>
        </div>
        <div className="flex items-center">
          <Tooltip content="Open detail page">
            <a
              href={`/inscription/${id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="h-11 w-11 flex items-center justify-center text-bone-dim hover:text-bone transition-colors"
              aria-label="Open detail page in new tab"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.25"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="8" cy="8" r="6.5" />
                <line x1="8" y1="7" x2="8" y2="11.5" />
                <line x1="8" y1="4.75" x2="8" y2="4.75" />
              </svg>
            </a>
          </Tooltip>
          <NotificationButton
            kind="inscription"
            targetKey={id}
            label={<BellIcon />}
            className="h-11 w-11 flex items-center justify-center text-bone-dim hover:text-bone transition-colors"
          />
          <button
            type="button"
            onClick={() => toggleFavorite(image.src)}
            className={`h-11 w-11 flex items-center justify-center text-xl leading-none transition-colors ${
              favorited ? 'text-accent-red' : 'text-bone-dim hover:text-bone'
            }`}
            aria-label={favorited ? 'Remove from favorites' : 'Add to favorites'}
          >
            {favorited ? '♥' : '♡'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="h-11 w-11 flex items-center justify-center text-lg leading-none text-bone-dim hover:text-bone transition-colors"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Image + side nav */}
      <div
        className="flex-1 flex items-center justify-center min-h-0 px-4 sm:px-12 relative"
        onClick={e => e.stopPropagation()}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <button
          type="button"
          onClick={onPrev}
          className="absolute left-1 sm:left-4 top-1/2 -translate-y-1/2 h-12 w-12 flex items-center justify-center text-bone-dim hover:text-bone font-mono text-3xl leading-none z-10 transition-colors"
          aria-label="Previous"
        >
          ←
        </button>

        <Image
          src={image.src}
          alt={image.caption || `Inscription ${id}`}
          className="object-contain select-none"
          width={1200}
          height={1200}
          style={{
            maxWidth: 'min(92vw, 1200px)',
            maxHeight: '100%',
            width: 'auto',
            height: 'auto',
          }}
          priority
        />

        <button
          type="button"
          onClick={onNext}
          className="absolute right-1 sm:right-4 top-1/2 -translate-y-1/2 h-12 w-12 flex items-center justify-center text-bone-dim hover:text-bone font-mono text-3xl leading-none z-10 transition-colors"
          aria-label="Next"
        >
          →
        </button>
      </div>

      {/* Wall label — fixed height so the image doesn't shift between pieces */}
      <div
        className="px-4 sm:px-6 py-4 font-mono text-[11px] tracking-[0.08em] leading-relaxed text-bone-dim shrink-0"
        onClick={e => e.stopPropagation()}
      >
        <Tooltip content={image.caption} side="top" align="start">
          <div className="text-bone uppercase max-w-3xl line-clamp-2" style={{ minHeight: '2lh' }}>
            {image.caption ? `"${image.caption}"` : ''}
          </div>
        </Tooltip>
      </div>
    </div>
  );
});

export default ImageModal;
