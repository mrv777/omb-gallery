"use client";

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import debounce from 'lodash.debounce';
import { GalleryImage, ColorFilter } from '@/lib/types';
import { useFavorites } from '@/lib/FavoritesContext';
import { encodeIds } from '@/lib/slideshowCodec';
import ImageModal from '../ImageModal';
import FilterControls from '../FilterControls';
import ZoomGestureHandler from './ZoomGestureHandler';
import VirtualRow from './VirtualRow';
import { useZoomLevel } from './useZoomLevel';
import { useGridDimensions } from './useGridDimensions';

interface VirtualizedZoomGridProps {
  images: GalleryImage[];
}

export default function VirtualizedZoomGrid({ images }: VirtualizedZoomGridProps) {
  // Modal state
  const [currentImage, setCurrentImage] = useState<number>(-1);
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Header visibility state
  const [headerVisible, setHeaderVisible] = useState(true);
  const lastScrollTop = useRef(0);
  const scrollThreshold = 10; // Minimum scroll distance to trigger hide/show

  // Mobile lays out the toolbar in two rows (filters + search/zoom).
  const [isDesktop, setIsDesktop] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  // Filter state
  const [colorFilter, setColorFilter] = useState<ColorFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);

  // Favorites
  const { isFavorite } = useFavorites();

  // Zoom state
  const {
    columnCount,
    maxColumnCount,
    handleZoomGesture,
    zoomIn,
    zoomOut,
    canZoomIn,
    canZoomOut,
  } = useZoomLevel();

  // Container ref and dimensions
  const parentRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { width: containerWidth } = useGridDimensions(parentRef);

  // Debounced search
  const debouncedSetSearch = useMemo(
    () =>
      debounce((value: string) => {
        setDebouncedSearchQuery(value);
      }, 500),
    []
  );

  useEffect(() => {
    debouncedSetSearch(searchQuery);
    return () => {
      debouncedSetSearch.cancel();
    };
  }, [searchQuery, debouncedSetSearch]);

  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
  }, []);

  // Filtered images — split so isFavorite only influences the favorites-only
  // branch. Toggling a heart with no filters active keeps filteredImages
  // referentially equal, letting VirtualRow.memo skip re-renders.
  const baseFiltered = useMemo(() => {
    let filtered =
      colorFilter === 'all'
        ? images
        : images.filter((img) => img.color === colorFilter);

    if (debouncedSearchQuery.trim() !== '') {
      const q = debouncedSearchQuery.toLowerCase();
      filtered = filtered.filter((img) => img.searchText.includes(q));
    }

    return filtered;
  }, [images, colorFilter, debouncedSearchQuery]);

  const filteredImages = useMemo(() => {
    if (!showFavoritesOnly) return baseFiltered;
    return baseFiltered.filter((img) => isFavorite(img.src));
  }, [baseFiltered, showFavoritesOnly, isFavorite]);

  const playHref = useMemo<string | null>(() => {
    if (filteredImages.length === 0) return null;
    // Cap the encoded playlist to keep the URL under browser/server limits.
    // Matches MAX_IDS in the slideshow create API; broader filters just play
    // the first slice in filter order.
    const MAX_PLAY_IDS = 1500;
    const ids: string[] = [];
    for (const img of filteredImages) {
      if (ids.length >= MAX_PLAY_IDS) break;
      const file = img.src.split('/').pop() ?? '';
      const stem = file.replace(/\.[^./]+$/, '');
      if (/^\d{1,8}$/.test(stem)) ids.push(stem);
    }
    if (ids.length === 0) return null;
    try {
      return `/slideshow?ids=${encodeIds(ids)}`;
    } catch {
      return null;
    }
  }, [filteredImages]);

  // Calculate grid dimensions - use floor to avoid sub-pixel gaps between cells
  const cellSize = containerWidth > 0 ? Math.floor(containerWidth / columnCount) : 100;
  const rowCount = Math.ceil(filteredImages.length / columnCount);

  // Dynamic overscan based on column count
  const overscan = useMemo(() => {
    if (columnCount >= 40) return 3;
    if (columnCount >= 25) return 4;
    if (columnCount >= 10) return 6;
    return 8;
  }, [columnCount]);

  // Virtualizer
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: useCallback(() => cellSize, [cellSize]),
    overscan,
  });

  // Force virtualizer to recalculate when cellSize changes
  useEffect(() => {
    rowVirtualizer.measure();
  }, [cellSize, rowVirtualizer]);

  // Reset scroll when filters change significantly
  useEffect(() => {
    rowVirtualizer.scrollToIndex(0);
  }, [colorFilter, debouncedSearchQuery, rowVirtualizer]);

  // Image click handlers
  const handleImageClick = useCallback((index: number) => {
    setCurrentImage(index);
    setIsModalOpen(true);
  }, []);

  const handleClose = useCallback(() => {
    setIsModalOpen(false);
  }, []);

  const handleToggleFavoritesOnly = useCallback(() => {
    setShowFavoritesOnly((prev) => !prev);
  }, []);

  const handleMovePrev = useCallback(() => {
    setCurrentImage((prev) =>
      (prev - 1 + filteredImages.length) % filteredImages.length
    );
  }, [filteredImages.length]);

  const handleMoveNext = useCallback(() => {
    setCurrentImage((prev) => (prev + 1) % filteredImages.length);
  }, [filteredImages.length]);

  // Reset current image if filtered images change and current image is out of bounds.
  // Clamp to the last valid index so unfavoriting the last open piece slides to its
  // neighbor rather than jumping back to zero.
  useEffect(() => {
    if (currentImage < 0) return;
    if (filteredImages.length === 0) {
      setCurrentImage(-1);
    } else if (currentImage >= filteredImages.length) {
      setCurrentImage(filteredImages.length - 1);
    }
  }, [filteredImages.length, currentImage]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Modal navigation
      if (isModalOpen) {
        switch (e.key) {
          case 'ArrowLeft':
            handleMovePrev();
            break;
          case 'ArrowRight':
            handleMoveNext();
            break;
          case 'Escape':
            handleClose();
            break;
        }
        return;
      }

      // Don't hijack keys while the user is typing in an input.
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);

      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      if (typing) return;

      // Zoom shortcuts (when modal is closed)
      switch (e.key) {
        case '=':
        case '+':
          zoomIn();
          break;
        case '-':
        case '_':
          zoomOut();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isModalOpen, handleMovePrev, handleMoveNext, handleClose, zoomIn, zoomOut]);

  // Scroll handler for header visibility
  const handleScroll = useCallback(() => {
    const scrollElement = parentRef.current;
    if (!scrollElement) return;

    const currentScrollTop = scrollElement.scrollTop;
    const scrollDelta = currentScrollTop - lastScrollTop.current;

    // Show header when at the top
    if (currentScrollTop <= 0) {
      setHeaderVisible(true);
    }
    // Only trigger hide/show after passing threshold
    else if (Math.abs(scrollDelta) > scrollThreshold) {
      if (scrollDelta > 0) {
        // Scrolling down - hide header
        setHeaderVisible(false);
      } else {
        // Scrolling up - show header
        setHeaderVisible(true);
      }
    }

    lastScrollTop.current = currentScrollTop;
  }, [scrollThreshold]);

  // Attach scroll listener
  useEffect(() => {
    const scrollElement = parentRef.current;
    if (!scrollElement) return;

    scrollElement.addEventListener('scroll', handleScroll, { passive: true });
    return () => scrollElement.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  const headerHeight = isDesktop ? 48 : 88;

  return (
    <div className="gallery-container h-screen flex flex-col relative">
      <div
        className={`header-wrapper fixed top-0 left-0 right-0 z-50 bg-ink-1 border-b border-ink-2 transition-transform duration-300 ease-in-out ${
          headerVisible ? 'translate-y-0' : '-translate-y-full'
        }`}
        style={{ height: headerHeight }}
      >
        <FilterControls
          colorFilter={colorFilter}
          onColorFilterChange={setColorFilter}
          searchQuery={searchQuery}
          onSearchChange={handleSearchChange}
          columnCount={columnCount}
          maxColumnCount={maxColumnCount}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          canZoomIn={canZoomIn}
          canZoomOut={canZoomOut}
          showFavoritesOnly={showFavoritesOnly}
          onToggleFavoritesOnly={handleToggleFavoritesOnly}
          searchInputRef={searchInputRef}
          playHref={playHref}
        />
      </div>

      <ZoomGestureHandler onZoom={handleZoomGesture}>
        <div
          ref={parentRef}
          className="virtualized-grid-container flex-1 overflow-y-auto overflow-x-hidden transition-[margin-top] duration-300 ease-in-out"
          style={{
            height: '100vh',
            marginTop: headerVisible ? headerHeight : 0,
          }}
        >
          <div
            style={{
              height: rowVirtualizer.getTotalSize(),
              width: '100%',
              position: 'relative',
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => (
              <VirtualRow
                key={virtualRow.key}
                rowIndex={virtualRow.index}
                images={filteredImages}
                columnCount={columnCount}
                cellSize={cellSize}
                onImageClick={handleImageClick}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: cellSize,
                  transform: `translateY(${virtualRow.index * cellSize}px)`,
                }}
              />
            ))}
          </div>
        </div>
      </ZoomGestureHandler>

      {isModalOpen && (
        <ImageModal
          onClose={handleClose}
          currentImage={currentImage}
          images={filteredImages}
          onPrev={handleMovePrev}
          onNext={handleMoveNext}
        />
      )}
    </div>
  );
}
