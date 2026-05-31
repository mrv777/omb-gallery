'use client';

import React, { memo, useEffect, useRef } from 'react';
import Image from 'next/image';
import { GalleryImage } from '@/lib/types';
import { useFavorites } from '@/lib/FavoritesContext';
import { formatBtcCompact, formatBtcPreciseCompact } from '@/lib/format';
import type { MarketplaceLiteListing } from '@/lib/marketplace/types';
import NotificationButton, { BellIcon } from './NotificationButton/NotificationButton';
import DownloadMenu from './DownloadMenu/DownloadMenu';
import { Tooltip } from './ui/Tooltip';

interface ImageModalProps {
  onClose: () => void;
  currentImage: number;
  images: GalleryImage[];
  listings?: Map<number, MarketplaceLiteListing>;
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

function neighborLabel(direction: 'prev' | 'next', image: GalleryImage | null): string {
  if (!image) return direction === 'prev' ? 'No previous OMB' : 'No next OMB';
  const label = direction === 'prev' ? 'Previous' : 'Next';
  return `${label} OMB #${inscriptionId(image.src)}`;
}

interface NeighborTileProps {
  direction: 'prev' | 'next';
  image: GalleryImage | null;
  onClick: () => void;
}

function NeighborTile({ direction, image, onClick }: NeighborTileProps) {
  const isPrev = direction === 'prev';
  const id = image ? inscriptionId(image.src) : '';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!image}
      className={`group flex h-16 min-w-0 items-center gap-2 border border-ink-2 bg-ink-0 px-2 font-mono uppercase transition-colors sm:h-20 sm:gap-3 sm:px-3 ${
        isPrev ? 'justify-start text-left' : 'justify-end text-right'
      } ${
        image
          ? 'text-bone-dim hover:border-bone-dim/60 hover:bg-ink-1 hover:text-bone'
          : 'cursor-default opacity-30'
      }`}
      aria-label={neighborLabel(direction, image)}
    >
      {image ? (
        <>
          {isPrev && (
            <Image
              src={image.thumbnail}
              alt=""
              width={64}
              height={64}
              className="h-12 w-12 shrink-0 border border-ink-2 object-cover sm:h-14 sm:w-14"
            />
          )}
          <span className="hidden min-w-0 flex-col sm:flex">
            <span className="text-[10px] tracking-[0.18em] text-bone-dim">
              {isPrev ? 'Previous' : 'Next'}
            </span>
            <span className="truncate text-xs tracking-[0.12em] text-bone">#{id}</span>
          </span>
          {!isPrev && (
            <Image
              src={image.thumbnail}
              alt=""
              width={64}
              height={64}
              className="h-12 w-12 shrink-0 border border-ink-2 object-cover sm:h-14 sm:w-14"
            />
          )}
        </>
      ) : (
        <span className="hidden text-[10px] tracking-[0.18em] sm:inline">Only OMB</span>
      )}
    </button>
  );
}

interface CurrentTileProps {
  image: GalleryImage;
  currentIndex: number;
  total: number;
}

function CurrentTile({ image, currentIndex, total }: CurrentTileProps) {
  const id = inscriptionId(image.src);

  return (
    <div
      className="flex h-16 min-w-0 items-center justify-center gap-2 border border-bone-dim/60 bg-ink-1 px-2 font-mono uppercase text-bone sm:h-20 sm:gap-3 sm:px-3"
      aria-current="true"
    >
      <Image
        src={image.thumbnail}
        alt={`Current OMB #${id}`}
        width={72}
        height={72}
        className="h-12 w-12 shrink-0 border border-bone-dim/40 object-cover sm:h-14 sm:w-14"
      />
      <span className="min-w-0 text-center sm:text-left">
        <span className="block text-[10px] tracking-[0.18em] text-bone-dim">Current</span>
        <span className="block truncate text-xs tracking-[0.12em]">#{id}</span>
        <span className="block text-[10px] tracking-[0.14em] text-bone-dim tabular-nums">
          {currentIndex + 1}/{total}
        </span>
      </span>
    </div>
  );
}

const ImageModal = memo(function ImageModal({
  onClose,
  currentImage,
  images,
  listings,
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
  const listing = listings?.get(Number(id)) ?? null;
  const colorLabel = COLOR_LABELS[image.color] ?? image.color.toUpperCase();
  const canNavigate = images.length > 1;
  const previousImage = canNavigate
    ? images[(currentImage - 1 + images.length) % images.length]
    : null;
  const nextImage = canNavigate ? images[(currentImage + 1) % images.length] : null;

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
          {listing && (
            <Tooltip content="Buy on OMB marketplace">
              <a
                href={`/marketplace?focus=${id}`}
                onClick={e => e.stopPropagation()}
                className="mr-1 inline-flex h-8 items-center border border-ink-2 px-2 font-mono text-[10px] uppercase tracking-[0.08em] text-bone-dim transition-colors hover:border-bone-dim hover:text-bone"
                aria-label={`Buy OMB #${id}`}
              >
                BUY
                <span className="hidden sm:inline">
                  {' '}
                  · {formatBtcCompact(listing.price_sats)} · est{' '}
                  {formatBtcPreciseCompact(listing.estimated_buyer_total_sats)} + network
                  {listing.listing_count > 1 ? ` · ${listing.listing_count} markets` : ''}
                </span>
              </a>
            </Tooltip>
          )}
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
          <DownloadMenu src={image.src} inscriptionId={id} />
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
        className="flex-1 flex flex-col min-h-0 px-4 sm:px-12 relative"
        onClick={e => e.stopPropagation()}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <div className="relative flex-1 min-h-0 flex items-center justify-center">
          <button
            type="button"
            onClick={onPrev}
            disabled={!canNavigate}
            className="absolute left-[-2rem] top-1/2 -translate-y-1/2 hidden h-12 w-12 items-center justify-center text-bone-dim hover:text-bone disabled:opacity-30 disabled:hover:text-bone-dim font-mono text-3xl leading-none z-10 transition-colors sm:flex"
            aria-label="Previous"
          >
            ←
          </button>

          <div className="flex h-full min-h-0 flex-col items-center justify-center gap-5 sm:gap-7">
            <Image
              src={image.src}
              alt={image.caption || `Inscription ${id}`}
              className="object-contain select-none"
              width={1200}
              height={1200}
              style={{
                maxWidth: 'min(92vw, 1200px)',
                maxHeight: 'calc(100% - 4.5rem)',
                width: 'auto',
                height: 'auto',
              }}
              priority
            />

            <div className="shrink-0 px-2 font-mono text-center text-[11px] tracking-[0.08em] leading-relaxed text-bone-dim">
              <Tooltip content={image.caption} side="top" align="center">
                <div
                  className="mx-auto max-w-3xl text-bone uppercase line-clamp-2"
                  style={{ minHeight: '2lh' }}
                >
                  {image.caption ? `"${image.caption}"` : ''}
                </div>
              </Tooltip>
            </div>
          </div>

          <button
            type="button"
            onClick={onNext}
            disabled={!canNavigate}
            className="absolute right-[-2rem] top-1/2 -translate-y-1/2 hidden h-12 w-12 items-center justify-center text-bone-dim hover:text-bone disabled:opacity-30 disabled:hover:text-bone-dim font-mono text-3xl leading-none z-10 transition-colors sm:flex"
            aria-label="Next"
          >
            →
          </button>
        </div>
      </div>

      {/* Neighbor strip */}
      <div
        className="shrink-0 border-t border-ink-2 bg-ink-0 px-2 py-2 sm:px-6 sm:py-3"
        onClick={e => e.stopPropagation()}
      >
        <nav
          className="mx-auto grid max-w-5xl grid-cols-[minmax(0,1fr)_minmax(112px,150px)_minmax(0,1fr)] items-stretch gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(170px,210px)_minmax(0,1fr)] sm:gap-4"
          aria-label="OMB navigation"
        >
          <NeighborTile direction="prev" image={previousImage} onClick={onPrev} />
          <CurrentTile image={image} currentIndex={currentImage} total={images.length} />
          <NeighborTile direction="next" image={nextImage} onClick={onNext} />
        </nav>
      </div>
    </div>
  );
});

export default ImageModal;
