"use client";

import { useState, useEffect, useMemo } from 'react';
import { GalleryImage } from '@/lib/types';

interface ImagePreloaderProps {
  images: GalleryImage[];
  onComplete: () => void;
  batchSize?: number;
  initialVisibleCount?: number;
}

export default function ImagePreloader({ 
  images, 
  onComplete, 
  batchSize = 10, // Default batch size
  initialVisibleCount = 100 // Default number of initially visible images
}: ImagePreloaderProps) {
  const [progress, setProgress] = useState(0);
  const [loadedCount, setLoadedCount] = useState(0);
  const totalImages = images.length;
  const [timeElapsed, setTimeElapsed] = useState(0);
  const [loadingSpeed, setLoadingSpeed] = useState(0); // images per second
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);

  // Calculate estimated time remaining
  const estimatedTimeRemaining = useMemo(() => {
    if (loadingSpeed <= 0 || loadedCount >= totalImages) return 0;
    return Math.ceil((totalImages - loadedCount) / loadingSpeed);
  }, [loadingSpeed, loadedCount, totalImages]);

  useEffect(() => {
    if (images.length === 0) {
      onComplete();
      return;
    }

    let loadedImages = 0;
    let cancelled = false;
    let lastLoadedCount = 0;
    let lastUpdateTime = Date.now();
    
    // Track elapsed time
    const startTime = Date.now();
    const timer = setInterval(() => {
      if (!cancelled) {
        const currentTime = Date.now();
        const elapsedSec = Math.floor((currentTime - startTime) / 1000);
        setTimeElapsed(elapsedSec);
        
        // Calculate loading speed every 2 seconds
        if (elapsedSec % 2 === 0 && elapsedSec > 0) {
          const imagesLoadedSinceLastUpdate = loadedImages - lastLoadedCount;
          const timeSinceLastUpdate = (currentTime - lastUpdateTime) / 1000;
          
          if (timeSinceLastUpdate > 0) {
            const currentSpeed = imagesLoadedSinceLastUpdate / timeSinceLastUpdate;
            setLoadingSpeed(prev => prev === 0 ? currentSpeed : (prev * 0.7 + currentSpeed * 0.3));
          }
          
          lastLoadedCount = loadedImages;
          lastUpdateTime = currentTime;
        }
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
      // Prioritize loading initially visible images first
      const initialVisibleImages = images.slice(0, Math.min(initialVisibleCount, images.length));
      const remainingImages = images.slice(Math.min(initialVisibleCount, images.length));
      
      // First load the initially visible images
      const initialBatchPromises = initialVisibleImages.map(image => preloadImage(image.thumbnail));
      await Promise.all(initialBatchPromises);
      
      // Mark initial load as complete
      if (!cancelled) {
        setInitialLoadComplete(true);
      }
      
      // If user has already skipped or all images are loaded, don't continue
      if (cancelled) return;
      
      // Then load the remaining images in batches
      for (let i = 0; i < remainingImages.length; i += batchSize) {
        if (cancelled) break;
        
        const batch = remainingImages.slice(i, i + batchSize);
        const batchPromises = batch.map(image => preloadImage(image.thumbnail));
        
        // Wait for the current batch to complete before moving to the next
        await Promise.all(batchPromises);
      }
      
      if (!cancelled) {
        // All images are preloaded, notify the parent component
        clearInterval(timer);
        onComplete();
      }
    };

    preloadAllImages();

    // Cleanup function
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [images, onComplete, totalImages, batchSize, initialVisibleCount]);

  const handleSkip = () => {
    onComplete();
  };

  // Determine progress bar color based on progress
  const progressBarColor = useMemo(() => {
    if (progress < 30) return 'bg-red-500';
    if (progress < 70) return 'bg-yellow-500';
    return 'bg-green-500';
  }, [progress]);

  return (
    <div className="flex flex-col items-center justify-center h-screen">
      <div className="text-center max-w-md w-full px-4">
        <h2 className="text-xl font-semibold mb-4 dark:text-white">
          {initialLoadComplete 
            ? "Optimizing Gallery Experience..." 
            : "Loading Essential Images..."}
        </h2>
        
        {/* Progress bar */}
        <div className="w-full h-6 bg-gray-200 rounded-full overflow-hidden dark:bg-gray-700 shadow-inner">
          <div 
            className={`h-full ${progressBarColor} transition-all duration-300 ease-out relative`}
            style={{ width: `${progress}%` }}
          >
            {progress > 10 && (
              <span className="absolute inset-0 flex items-center justify-center text-xs font-medium text-white drop-shadow-md">
                {progress}%
              </span>
            )}
          </div>
        </div>
        
        {/* Stats */}
        <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
          <div className="bg-white dark:bg-gray-800 p-2 rounded-md shadow">
            <p className="text-gray-600 dark:text-gray-300 text-xs">
              {loadedCount} of {totalImages} images
            </p>
          </div>
          <div className="bg-white dark:bg-gray-800 p-2 rounded-md shadow">
            <p className="text-gray-600 dark:text-gray-300 text-xs">
              {timeElapsed}s elapsed
            </p>
          </div>
        </div>
        
        {/* Estimated time */}
        {loadingSpeed > 0 && !initialLoadComplete && (
          <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
            Estimated time remaining: ~{estimatedTimeRemaining} seconds
          </p>
        )}
        
        {/* Skip button - only show after a few seconds have passed */}
        {(timeElapsed > 3 || initialLoadComplete) && (
          <button 
            onClick={handleSkip}
            className="mt-6 px-4 py-2 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 rounded-md text-sm transition-colors duration-200 dark:text-white"
          >
            {initialLoadComplete ? "Continue to Gallery" : "Skip Preloading"}
          </button>
        )}
      </div>
    </div>
  );
} 