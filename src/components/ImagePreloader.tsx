"use client";

import { useState, useEffect, useMemo } from 'react';
import { GalleryImage } from '@/lib/types';

interface ImagePreloaderProps {
  images: GalleryImage[];
  onComplete: () => void;
  batchSize?: number;
  initialVisibleCount?: number;
}

const TOTAL_SEGMENTS = 20;

export default function ImagePreloader({
  images,
  onComplete,
  batchSize = 10,
  initialVisibleCount = 100
}: ImagePreloaderProps) {
  const [progress, setProgress] = useState(0);
  const [loadedCount, setLoadedCount] = useState(0);
  const totalImages = images.length;
  const [timeElapsed, setTimeElapsed] = useState(0);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);

  const filledSegments = useMemo(() => {
    return Math.floor((progress / 100) * TOTAL_SEGMENTS);
  }, [progress]);

  useEffect(() => {
    if (images.length === 0) {
      onComplete();
      return;
    }

    let loadedImages = 0;
    let cancelled = false;

    const startTime = Date.now();
    const timer = setInterval(() => {
      if (!cancelled) {
        const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
        setTimeElapsed(elapsedSec);
      }
    }, 1000);

    const preloadImage = (src: string) => {
      return new Promise<void>((resolve) => {
        const img = new Image();
        img.src = src;
        img.onload = () => {
          if (!cancelled) {
            loadedImages++;
            setLoadedCount(loadedImages);
            setProgress(Math.floor((loadedImages / totalImages) * 100));
            resolve();
          }
        };
        img.onerror = () => {
          if (!cancelled) {
            loadedImages++;
            setLoadedCount(loadedImages);
            setProgress(Math.floor((loadedImages / totalImages) * 100));
            resolve();
          }
        };
      });
    };

    const preloadAllImages = async () => {
      const initialVisibleImages = images.slice(0, Math.min(initialVisibleCount, images.length));
      const remainingImages = images.slice(Math.min(initialVisibleCount, images.length));

      const initialBatchPromises = initialVisibleImages.map(image => preloadImage(image.thumbnail));
      await Promise.all(initialBatchPromises);

      if (!cancelled) {
        setInitialLoadComplete(true);
      }

      if (cancelled) return;

      for (let i = 0; i < remainingImages.length; i += batchSize) {
        if (cancelled) break;

        const batch = remainingImages.slice(i, i + batchSize);
        const batchPromises = batch.map(image => preloadImage(image.thumbnail));
        await Promise.all(batchPromises);
      }

      if (!cancelled) {
        clearInterval(timer);
        onComplete();
      }
    };

    preloadAllImages();

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [images, onComplete, totalImages, batchSize, initialVisibleCount]);

  const handleSkip = () => {
    onComplete();
  };

  const showButton = timeElapsed > 3 || initialLoadComplete;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-[rgb(20,20,30)]">
      <div className="text-center max-w-md w-full px-4">
        <h2 className="text-xl font-medium mb-8 text-white">
          Loading Gallery
        </h2>

        {/* Segmented progress bar */}
        <div className="flex gap-1 justify-center mb-4">
          {Array.from({ length: TOTAL_SEGMENTS }).map((_, i) => (
            <div
              key={i}
              className={`w-3 h-3 transition-colors duration-150 ${
                i < filledSegments
                  ? 'bg-white'
                  : 'bg-gray-800 border border-gray-700'
              }`}
            />
          ))}
        </div>

        {/* Count */}
        <p className="text-gray-400 text-sm font-mono">
          {loadedCount} / {totalImages}
        </p>

        {/* Ghost button */}
        {showButton && (
          <button
            onClick={handleSkip}
            className="mt-8 px-6 py-2 border border-white text-white text-sm
                       hover:bg-white hover:text-black transition-colors duration-200"
          >
            {initialLoadComplete ? "Continue" : "Skip"}
          </button>
        )}
      </div>
    </div>
  );
} 