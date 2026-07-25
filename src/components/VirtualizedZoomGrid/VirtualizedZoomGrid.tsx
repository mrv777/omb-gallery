'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import debounce from 'lodash.debounce';
import { GalleryImage } from '@/lib/types';
import { useFavorites } from '@/lib/FavoritesContext';
import { useColorFilter } from '@/lib/useColorFilter';
import { useSearchQueryParam } from '@/lib/useSearchQueryParam';
import { useFavoritesOnlyParam } from '@/lib/useFavoritesOnlyParam';
import { useSeriesParam } from '@/lib/useSeriesParam';
import { seriesMemberSet } from '@/lib/series';
import { encodeIds } from '@/lib/slideshowCodec';
import { useListings } from '@/components/Marketplace/useListings';
import ImageModal from '../ImageModal';
import FilterControls from '../FilterControls';
import ZoomGestureHandler from './ZoomGestureHandler';
import VirtualRow from './VirtualRow';
import GridHoverPreview from './GridHoverPreview';
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

  // Filter state lives in the URL so the full filtered view is shareable.
  // Search keeps a local buffer for snappy typing — the URL is updated on the
  // same 500ms debounce as the actual filter, not on every keystroke.
  const { color: colorFilter, setColor: setColorFilter } = useColorFilter();
  const { query: urlQuery, setQuery: setUrlQuery } = useSearchQueryParam();
  const { series: activeSeries, setSeries } = useSeriesParam();
  // Owned here because the header height below has to grow to fit the row.
  // Initialized open when the page LOADS with a series filter (a shared
  // /?series= link), so the chips explain the filter without a click. Not an
  // effect — deriving it once at mount is enough, since every other way to set
  // a series either goes through the chips (already open) or arrives as a full
  // navigation that remounts this component.
  const [seriesRowOpen, setSeriesRowOpen] = useState(() => activeSeries != null);
  const toggleSeriesRow = useCallback(() => setSeriesRowOpen(v => !v), []);
  const { favoritesOnly: showFavoritesOnly, setFavoritesOnly: setShowFavoritesOnly } =
    useFavoritesOnlyParam();
  const [searchQuery, setSearchQuery] = useState(urlQuery);
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState(urlQuery);

  // Favorites
  const { isFavorite } = useFavorites();
  const listings = useListings();

  // Zoom state
  const { columnCount, maxColumnCount, handleZoomGesture, zoomIn, zoomOut, canZoomIn, canZoomOut } =
    useZoomLevel();

  // Container ref and dimensions
  const parentRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { width: containerWidth } = useGridDimensions(parentRef);

  // Debounced search — also writes the URL so the filter is shareable, but
  // through a ref so each new searchParams snapshot doesn't cancel the
  // pending timer (setUrlQuery's identity changes whenever the URL changes).
  const setUrlQueryRef = useRef(setUrlQuery);
  useEffect(() => {
    setUrlQueryRef.current = setUrlQuery;
  }, [setUrlQuery]);

  const debouncedSetSearch = useMemo(
    () =>
      debounce((value: string) => {
        setDebouncedSearchQuery(value);
        setUrlQueryRef.current(value);
      }, 500),
    []
  );

  useEffect(() => {
    debouncedSetSearch(searchQuery);
    return () => {
      debouncedSetSearch.cancel();
    };
  }, [searchQuery, debouncedSetSearch]);

  // Reflect external URL changes (back/forward, paste) into the local input,
  // unless the user is actively typing — don't clobber an in-progress edit.
  const lastUrlQuery = useRef(urlQuery);
  useEffect(() => {
    if (urlQuery === lastUrlQuery.current) return;
    lastUrlQuery.current = urlQuery;
    if (document.activeElement === searchInputRef.current) return;
    setSearchQuery(urlQuery);
    setDebouncedSearchQuery(urlQuery);
  }, [urlQuery]);

  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
  }, []);

  // Filtered images — split so isFavorite only influences the favorites-only
  // branch. Toggling a heart with no filters active keeps filteredImages
  // referentially equal, letting VirtualRow.memo skip re-renders.
  const baseFiltered = useMemo(() => {
    let filtered = colorFilter === 'all' ? images : images.filter(img => img.color === colorFilter);

    // Runs BEFORE the substring pass: it's an O(1) Set probe that typically
    // cuts 9,001 down to a few dozen, so the (much more expensive) string scan
    // below then walks almost nothing.
    if (activeSeries) {
      const members = seriesMemberSet(activeSeries.id);
      filtered = filtered.filter(img => members.has(img.number));
    }

    if (debouncedSearchQuery.trim() !== '') {
      const q = debouncedSearchQuery.toLowerCase();
      filtered = filtered.filter(img => img.searchText.includes(q));
    }

    return filtered;
  }, [images, colorFilter, activeSeries, debouncedSearchQuery]);

  const filteredImages = useMemo(() => {
    if (!showFavoritesOnly) return baseFiltered;
    return baseFiltered.filter(img => isFavorite(img.src));
  }, [baseFiltered, showFavoritesOnly, isFavorite]);

  const playHref = useMemo<string | null>(() => {
    if (filteredImages.length === 0) return null;
    // Cap the encoded playlist to keep the URL under browser/server limits.
    // Matches MAX_IDS in the slideshow create API. The codec sorts + dedupes
    // before delta-varint encoding (load-bearing for URL compactness), so
    // playback is numeric-ascending across the first MAX_PLAY_IDS — not the
    // user's current filter sort.
    const MAX_PLAY_IDS = 1500;
    const ids: string[] = [];
    for (const img of filteredImages) {
      if (ids.length >= MAX_PLAY_IDS) break;
      // img.number is parsed once in imageLoader; the codec caps at 99,999,999.
      if (Number.isFinite(img.number) && img.number >= 0 && img.number < 100_000_000) {
        ids.push(String(img.number));
      }
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
  }, [colorFilter, debouncedSearchQuery, activeSeries, rowVirtualizer]);

  // Image click handlers
  const handleImageClick = useCallback((index: number) => {
    setCurrentImage(index);
    setIsModalOpen(true);
  }, []);

  const handleClose = useCallback(() => {
    setIsModalOpen(false);
  }, []);

  const handleToggleFavoritesOnly = useCallback(() => {
    setShowFavoritesOnly(!showFavoritesOnly);
  }, [showFavoritesOnly, setShowFavoritesOnly]);

  const handleMovePrev = useCallback(() => {
    setCurrentImage(prev => (prev - 1 + filteredImages.length) % filteredImages.length);
  }, [filteredImages.length]);

  const handleMoveNext = useCallback(() => {
    setCurrentImage(prev => (prev + 1) % filteredImages.length);
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
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

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

  // Two h-11 rows (nav/search, then filters) at every width — no breakpoint
  // term, so this constant can't desync from the toolbar's actual CSS height.
  const SERIES_ROW_H = 40;
  const headerHeight = 88 + (seriesRowOpen ? SERIES_ROW_H : 0);

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
          activeSeries={activeSeries}
          onSeriesChange={setSeries}
          seriesRowOpen={seriesRowOpen}
          onToggleSeriesRow={toggleSeriesRow}
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
            {rowVirtualizer.getVirtualItems().map(virtualRow => (
              <VirtualRow
                key={virtualRow.key}
                rowIndex={virtualRow.index}
                images={filteredImages}
                columnCount={columnCount}
                cellSize={cellSize}
                listings={listings}
                favoritesOnly={showFavoritesOnly}
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

      <GridHoverPreview
        scrollRef={parentRef}
        images={filteredImages}
        cellSize={cellSize}
        columnCount={columnCount}
        disabled={isModalOpen}
      />

      {isModalOpen && (
        <ImageModal
          onClose={handleClose}
          currentImage={currentImage}
          images={filteredImages}
          listings={listings}
          onPrev={handleMovePrev}
          onNext={handleMoveNext}
        />
      )}
    </div>
  );
}
