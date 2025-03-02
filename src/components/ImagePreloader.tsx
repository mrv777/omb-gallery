"use client";

import { useState, useEffect } from 'react';
import { GalleryImage } from '@/lib/types';

interface ImagePreloaderProps {
  images: GalleryImage[];
  onComplete: () => void;
  batchSize?: number;
}

export default function ImagePreloader({ 
  images, 
  onComplete, 
  batchSize = 10 // Default batch size
}: ImagePreloaderProps) {
  const [progress, setProgress] = useState(0);
  const [loadedCount, setLoadedCount] = useState(0);
  const totalImages = images.length;

  useEffect(() => {
    if (images.length === 0) {
      onComplete();
      return;
    }

    let loadedImages = 0;
    let cancelled = false;

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
      // Process images in batches to avoid overwhelming the browser
      for (let i = 0; i < totalImages; i += batchSize) {
        if (cancelled) break;
        
        const batch = images.slice(i, i + batchSize);
        const batchPromises = batch.map(image => preloadImage(image.thumbnail));
        
        // Wait for the current batch to complete before moving to the next
        await Promise.all(batchPromises);
      }
      
      if (!cancelled) {
        // All images are preloaded, notify the parent component
        onComplete();
      }
    };

    preloadAllImages();

    // Cleanup function
    return () => {
      cancelled = true;
    };
  }, [images, onComplete, totalImages, batchSize]);

  return (
    <div className="flex flex-col items-center justify-center h-screen">
      <div className="text-center">
        <h2 className="text-xl font-semibold mb-4 dark:text-white">Loading Gallery</h2>
        <div className="w-64 h-4 bg-gray-200 rounded-full overflow-hidden dark:bg-gray-700">
          <div 
            className="h-full bg-[#FD8C0C] transition-all duration-300 ease-out"
            style={{ width: `${progress}%` }}
          ></div>
        </div>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
          {loadedCount} of {totalImages} images loaded ({progress}%)
        </p>
      </div>
    </div>
  );
} 