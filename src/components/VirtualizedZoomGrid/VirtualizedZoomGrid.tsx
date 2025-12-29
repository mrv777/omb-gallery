"use client";

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import debounce from 'lodash.debounce';
import { GalleryImage, ColorFilter } from '@/lib/types';
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

  // Filter state
  const [colorFilter, setColorFilter] = useState<ColorFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');

  // Zoom state
  const {
    columnCount,
    handleZoomGesture,
    zoomIn,
    zoomOut,
    canZoomIn,
    canZoomOut,
  } = useZoomLevel();

  // Container ref and dimensions
  const parentRef = useRef<HTMLDivElement>(null);
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

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
  };

  // Filtered images
  const filteredImages = useMemo(() => {
    let filtered =
      colorFilter === 'all'
        ? images
        : images.filter((img) => img.color === colorFilter);

    if (debouncedSearchQuery.trim() !== '') {
      const searchLower = debouncedSearchQuery.toLowerCase();
      filtered = filtered.filter((img) => {
        const filename = img.src.split('/').pop() || '';
        const description = img.caption || '';
        const tags = img.tags || [];
        const tagString = tags.join(' ').toLowerCase();

        return (
          filename.toLowerCase().includes(searchLower) ||
          description.toLowerCase().includes(searchLower) ||
          tagString.includes(searchLower)
        );
      });
    }

    return filtered;
  }, [images, colorFilter, debouncedSearchQuery]);

  // Calculate grid dimensions
  const cellSize = containerWidth > 0 ? containerWidth / columnCount : 100;
  const rowCount = Math.ceil(filteredImages.length / columnCount);

  // Dynamic overscan - fewer extra rows at high column counts to reduce DOM nodes
  const overscan = useMemo(() => {
    if (columnCount >= 40) return 2;
    if (columnCount >= 25) return 3;
    if (columnCount >= 15) return 4;
    return 5;
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

  const handleMovePrev = useCallback(() => {
    setCurrentImage((prev) =>
      (prev - 1 + filteredImages.length) % filteredImages.length
    );
  }, [filteredImages.length]);

  const handleMoveNext = useCallback(() => {
    setCurrentImage((prev) => (prev + 1) % filteredImages.length);
  }, [filteredImages.length]);

  // Reset current image if filtered images change and current image is out of bounds
  useEffect(() => {
    if (currentImage >= filteredImages.length) {
      setCurrentImage(filteredImages.length > 0 ? 0 : -1);
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

  const headerHeight = 52;

  return (
    <div className="gallery-container h-screen flex flex-col relative">
      <div
        className={`header-wrapper fixed top-0 left-0 right-0 z-50 bg-white dark:bg-gray-900 transition-transform duration-300 ease-in-out ${
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
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          canZoomIn={canZoomIn}
          canZoomOut={canZoomOut}
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
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              />
            ))}
          </div>
        </div>
      </ZoomGestureHandler>

      {isModalOpen && (
        <ImageModal
          isOpen={isModalOpen}
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
