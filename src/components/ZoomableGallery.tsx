"use client";

import React, { useState, useEffect, useCallback, memo, useRef, useMemo } from 'react';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import { GalleryImage, ColorFilter } from '@/lib/types';
import Image from 'next/image';
import path from 'path';
import debounce from 'lodash.debounce';
import { useTheme } from '@/lib/ThemeContext';

// Memoized Modal component to prevent unnecessary re-renders
const ImageModal = memo(({ 
  isOpen, 
  onClose, 
  currentImage, 
  images, 
  onPrev, 
  onNext 
}: { 
  isOpen: boolean; 
  onClose: () => void; 
  currentImage: number; 
  images: GalleryImage[]; 
  onPrev: () => void; 
  onNext: () => void; 
}) => {
  if (!isOpen || images.length === 0 || currentImage < 0) {
    return null;
  }

  const image = images[currentImage];
  
  // Extract filename without extension
  const fullFilename = image.src.split('/').pop() || '';
  const filenameWithoutExt = fullFilename.split('.')[0];

  return (
    <div className="fixed inset-0 bg-black bg-opacity-75 dark:bg-black dark:bg-opacity-90 flex items-center justify-center z-[1500]" onClick={onClose}>
      <div className="relative max-w-[90vw] max-h-[90vh] flex flex-col items-center overflow-auto" onClick={(e) => e.stopPropagation()}>
        {/* Close button at the top */}
        <div className="w-full flex justify-end mb-2">
          <button 
            className="bg-black bg-opacity-50 text-white px-3 py-1.5 rounded-full hover:bg-opacity-70 dark:bg-gray-800 dark:bg-opacity-70"
            onClick={(e) => { e.stopPropagation(); onClose(); }}
          >
            ✕
          </button>
        </div>
        
        {/* Image and navigation row */}
        <div className="flex items-center justify-center w-full">
          <button 
            className="mr-4 bg-black bg-opacity-50 text-white px-2 py-1 rounded-full hover:bg-opacity-70 dark:bg-gray-800 dark:bg-opacity-70"
            onClick={(e) => { e.stopPropagation(); onPrev(); }}
          >
            ←
          </button>
          
          <div className="relative">
            <Image 
              src={image.src} 
              alt={image.caption || `Image ${currentImage}`}
              className="object-contain"
              width={336}
              height={336}
              style={{
                maxWidth: '75vw',
                maxHeight: '75vh',
                width: 'auto',
                height: 'auto',
                minWidth: '336px',
                minHeight: '336px'
              }}
              priority
              unoptimized={false} // Let Next.js optimize the image
            />
          </div>
          
          <button 
            className="ml-4 bg-black bg-opacity-50 text-white px-2 py-1 rounded-full hover:bg-opacity-70 dark:bg-gray-800 dark:bg-opacity-70"
            onClick={(e) => { e.stopPropagation(); onNext(); }}
          >
            →
          </button>
        </div>
        
        {/* Caption below the image */}
        <div className="text-white text-center p-2 mt-3">
          <div className="text-lg font-semibold">{filenameWithoutExt}</div>
          {image.caption && <div className="mt-1 text-sm">{image.caption}</div>}
        </div>
      </div>
    </div>
  );
});

// Memoized thumbnail component to prevent unnecessary re-renders
const ThumbnailImage = memo(({ 
  image, 
  index, 
  onClick 
}: { 
  image: GalleryImage; 
  index: number; 
  onClick: (index: number) => void;
}) => {
  const [mouseDownTime, setMouseDownTime] = useState<number | null>(null);
  
  const handleMouseDown = () => {
    setMouseDownTime(Date.now());
  };
  
  const handleMouseUp = () => {
    if (mouseDownTime) {
      const clickDuration = Date.now() - mouseDownTime;
      // Only trigger click if duration is less than 500ms
      if (clickDuration < 500) {
        onClick(index);
      }
      setMouseDownTime(null);
    }
  };
  
  const handleTouchStart = () => {
    setMouseDownTime(Date.now());
  };
  
  const handleTouchEnd = () => {
    if (mouseDownTime) {
      const clickDuration = Date.now() - mouseDownTime;
      // Only trigger click if duration is less than 100ms
      if (clickDuration < 100) {
        onClick(index);
      }
      setMouseDownTime(null);
    }
  };

  return (
    <div 
      className="gallery-item cursor-pointer transition-transform hover:scale-125 hover:z-10"
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseLeave={() => setMouseDownTime(null)} // Reset if mouse leaves the element
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={() => setMouseDownTime(null)} // Reset if touch is cancelled
    >
      <div className="relative">
        <Image 
          src={image.thumbnail} 
          alt={image.caption || `Image ${index}`}
          width={image.thumbnailWidth || 100}
          height={image.thumbnailHeight || 100}
          loading="lazy" // Explicitly set lazy loading
          unoptimized={false} // Let Next.js optimize the image
          sizes="100px" // Explicitly tell Next.js we want the 100px version
          quality={50} // Explicitly set lower quality for thumbnails
        />
      </div>
    </div>
  );
});

interface ZoomableGalleryProps {
  images: GalleryImage[];
}

export default function ZoomableGallery({ images }: ZoomableGalleryProps) {
  const { theme } = useTheme();
  const [currentImage, setCurrentImage] = useState<number>(-1);
  const [colorFilter, setColorFilter] = useState<ColorFilter>('all');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  
  // Create a debounced function (300ms is a common debounce delay)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const debouncedSetSearch = useCallback(
    debounce((value: string) => {
      setDebouncedSearchQuery(value);
    }, 500),
    [] // Empty dependency array ensures this is only created once
  );
  
  // Update the debounced value whenever searchQuery changes
  useEffect(() => {
    debouncedSetSearch(searchQuery);
    
    // Cleanup function to cancel any pending debounce calls
    return () => {
      debouncedSetSearch.cancel();
    };
  }, [searchQuery, debouncedSetSearch]);
  
  // Handle search input change
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
  };
  
  // Memoize filtered images to prevent recalculation on every render
  const filteredImages = React.useMemo(() => {
    // First filter by color
    const colorFiltered = colorFilter === 'all' 
      ? images 
      : images.filter(img => img.color === colorFilter);
    
    // Then filter by search query if it exists
    if (debouncedSearchQuery.trim() === '') {
      return colorFiltered;
    }
    
    // Extract filename from src and check if it contains the search query
    return colorFiltered.filter(img => {
      const filename = img.src.split('/').pop() || '';
      const description = img.caption || '';
      const tags = img.tags || [];
      const tagString = tags.join(' ').toLowerCase();
      
      const searchLower = debouncedSearchQuery.toLowerCase();
      
      return (
        filename.toLowerCase().includes(searchLower) ||
        description.toLowerCase().includes(searchLower) ||
        tagString.includes(searchLower)
      );
    });
  }, [images, colorFilter, debouncedSearchQuery]);
  
  const handleClick = useCallback((index: number) => {
    setCurrentImage(index);
    setIsModalOpen(true);
  }, []);
  
  const handleClose = useCallback(() => {
    setIsModalOpen(false);
  }, []);
  
  const handleMovePrev = useCallback(() => {
    setCurrentImage((prevImage) => 
      (prevImage - 1 + filteredImages.length) % filteredImages.length
    );
  }, [filteredImages.length]);
  
  const handleMoveNext = useCallback(() => {
    setCurrentImage((prevImage) => 
      (prevImage + 1) % filteredImages.length
    );
  }, [filteredImages.length]);

  // Reset current image if filtered images change and current image is out of bounds
  useEffect(() => {
    if (currentImage >= filteredImages.length) {
      setCurrentImage(filteredImages.length > 0 ? 0 : -1);
    }
  }, [filteredImages, currentImage]);

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isModalOpen) return;
      
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
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isModalOpen, handleMovePrev, handleMoveNext, handleClose]);
  
  // Memoize color filter buttons to prevent re-renders
  const colorFilterButtons = React.useMemo(() => (
    <div className="flex space-x-2">
      <button 
        className={`w-6 h-6 rounded-full ${colorFilter === 'all' ? 'ring-2 ring-gray-500 dark:ring-gray-300' : ''}`}
        onClick={() => setColorFilter('all')}
        style={{ background: 'linear-gradient(to right, red, blue, green, orange, black)' }}
      />
      <button 
        className={`w-6 h-6 rounded-full bg-red-600 ${colorFilter === 'red' ? 'ring-2 ring-gray-500 dark:ring-gray-300' : ''}`}
        onClick={() => setColorFilter('red')}
      />
      <button 
        className={`w-6 h-6 rounded-full bg-blue-600 ${colorFilter === 'blue' ? 'ring-2 ring-gray-500 dark:ring-gray-300' : ''}`}
        onClick={() => setColorFilter('blue')}
      />
      <button 
        className={`w-6 h-6 rounded-full bg-green-600 ${colorFilter === 'green' ? 'ring-2 ring-gray-500 dark:ring-gray-300' : ''}`}
        onClick={() => setColorFilter('green')}
      />
      <button 
        className={`w-6 h-6 rounded-full bg-orange-500 ${colorFilter === 'orange' ? 'ring-2 ring-gray-500 dark:ring-gray-300' : ''}`}
        onClick={() => setColorFilter('orange')}
      />
      <button 
        className={`w-6 h-6 rounded-full bg-black ${colorFilter === 'black' ? 'ring-2 ring-gray-500 dark:ring-gray-300' : ''}`}
        onClick={() => setColorFilter('black')}
      />
    </div>
  ), [colorFilter]);
  
  return (
    <div className="gallery-container">
      <div className="filter-controls flex flex-col md:flex-row justify-between items-center mb-4 p-2 gap-2 dark:bg-gray-800">
        <div className="color-filters mb-2 md:mb-0">
          {colorFilterButtons}
        </div>
        <div className="search-box">
          <input
            type="text"
            placeholder="Search images..."
            value={searchQuery}
            onChange={handleSearchChange}
            className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white dark:placeholder-gray-400"
          />
        </div>
      </div>
      
      {/* Determine grid columns based on number of filtered images */}
      {(() => {
        // Calculate the appropriate number of columns based on image count
        let gridColsClass = "grid-cols-10"; // Default for < 50 images
        
        if (filteredImages.length >= 405) {
          gridColsClass = "grid-cols-50";
        } else if (filteredImages.length >= 360) {
          gridColsClass = "grid-cols-45";
        } else if (filteredImages.length >= 315) {
          gridColsClass = "grid-cols-40";
        } else if (filteredImages.length >= 270) {
          gridColsClass = "grid-cols-35";
        } else if (filteredImages.length >= 225) {
          gridColsClass = "grid-cols-30";
        } else if (filteredImages.length >= 180) {
          gridColsClass = "grid-cols-25";
        } else if (filteredImages.length >= 135) {
          gridColsClass = "grid-cols-20";
        } else if (filteredImages.length >= 90) {
          gridColsClass = "grid-cols-15";
        }
        return (
          <TransformWrapper
            initialScale={4}
            minScale={1}
            maxScale={10}
            wheel={{ step: 0.1 }}
            limitToBounds={true}
            doubleClick={{ disabled: true }} // Disable double click to prevent conflicts with image click
          >
            <TransformComponent wrapperStyle={{ width: '100%', height: '100vh' }}>
              <div className="grid-gallery-container">
                <div className={`grid ${gridColsClass} gap-0 p-4`}>
                  {filteredImages.map((image, index) => (
                    <ThumbnailImage 
                      key={`${image.src}-${index}`}
                      image={image}
                      index={index}
                      onClick={handleClick}
                    />
                  ))}
                </div>
              </div>
            </TransformComponent>
          </TransformWrapper>
        );
      })()}
      
      {/* Only render modal when needed */}
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