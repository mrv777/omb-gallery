"use client";

import React, { memo, useEffect } from 'react';
import Image from 'next/image';
import { GalleryImage } from '@/lib/types';
import { useFavorites } from '@/lib/FavoritesContext';

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

  // Warm the browser cache for the adjacent pieces so arrow-key nav is
  // instant. Effect runs after paint, so it doesn't starve the current
  // image's initial load. Wraps at the ends of the list.
  useEffect(() => {
    if (images.length < 2 || currentImage < 0 || currentImage >= images.length) return;
    const len = images.length;
    const neighbors = [
      images[(currentImage - 1 + len) % len],
      images[(currentImage + 1) % len],
    ];
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

  return (
    <div
      className="fixed inset-0 bg-ink-0 z-[1500] flex flex-col"
      onClick={onClose}
    >
      {/* Top chrome: inscription / color / close */}
      <div
        className="flex items-center justify-between pl-4 sm:pl-6 pr-1 sm:pr-2 py-1 font-mono text-xs tracking-[0.12em] uppercase text-bone-dim shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-bone">
          <a
            href={`https://ordinals.com/inscription/${id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline underline-offset-4 decoration-bone-dim"
            title="View on ordinals.com"
          >
            #{id}
          </a>
          <span className="mx-2 text-bone-dim">·</span>
          <span>{colorLabel}</span>
          <span className="mx-2 text-bone-dim hidden sm:inline">·</span>
          <span className="text-bone-dim hidden sm:inline">{currentImage + 1}/{images.length}</span>
        </div>
        <div className="flex items-center">
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
        onClick={(e) => e.stopPropagation()}
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
          style={{ maxWidth: 'min(92vw, 1200px)', maxHeight: '100%', width: 'auto', height: 'auto' }}
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
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="text-bone uppercase max-w-3xl line-clamp-2"
          style={{ minHeight: '2lh' }}
          title={image.caption}
        >
          {image.caption ? `"${image.caption}"` : ''}
        </div>
      </div>
    </div>
  );
});

export default ImageModal;
