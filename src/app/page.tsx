'use client';

import { GalleryImage } from '@/lib/types';
import VirtualizedZoomGrid from '@/components/VirtualizedZoomGrid';
import ImagePreloader from '@/components/ImagePreloader';
import { Suspense, useEffect, useState } from 'react';
import { loadImages } from '@/lib/imageLoader';

// Cache version - increment this when the image set changes significantly
const CACHE_VERSION = 1;
const PRELOAD_CACHE_KEY = 'gallery_preloaded_v' + CACHE_VERSION;

interface NetworkInformation {
  effectiveType?: '2g' | 'slow-2g' | '3g' | '4g' | string;
}
type NavigatorWithConnection = Navigator & { connection?: NetworkInformation };

// Load images synchronously at module level
const galleryImages = loadImages();

export default function Home() {
  const [images] = useState<GalleryImage[]>(galleryImages);
  const [preloading, setPreloading] = useState<boolean | null>(null); // null = checking
  const [batchSize, setBatchSize] = useState(20);
  const [initialVisibleCount, setInitialVisibleCount] = useState(100);

  useEffect(() => {
    // Check if images have been preloaded before
    const checkPreloadCache = () => {
      try {
        const cachedPreloadStatus = localStorage.getItem(PRELOAD_CACHE_KEY);
        if (cachedPreloadStatus === 'completed') {
          return true;
        }
      } catch (error) {
        console.warn('Could not access localStorage:', error);
      }
      return false;
    };

    // Determine if user is on a mobile device
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

    // Check connection speed if the API is available
    const nav = navigator as NavigatorWithConnection;
    if (nav.connection) {
      const connection = nav.connection;

      // Adjust batch size based on connection type - optimized for HTTP/2
      if (connection.effectiveType === '4g') {
        setBatchSize(isMobile ? 50 : 100);
      } else if (connection.effectiveType === '3g') {
        setBatchSize(isMobile ? 25 : 50);
      } else if (connection.effectiveType === '2g' || connection.effectiveType === 'slow-2g') {
        setBatchSize(isMobile ? 10 : 20);
      } else {
        setBatchSize(isMobile ? 30 : 60);
      }

      // Adjust initial visible count based on connection type
      if (connection.effectiveType === '4g') {
        setInitialVisibleCount(isMobile ? 80 : 150);
      } else if (connection.effectiveType === '3g') {
        setInitialVisibleCount(isMobile ? 40 : 80);
      } else if (connection.effectiveType === '2g' || connection.effectiveType === 'slow-2g') {
        setInitialVisibleCount(isMobile ? 20 : 40);
      } else {
        setInitialVisibleCount(isMobile ? 50 : 100);
      }
    } else {
      setBatchSize(isMobile ? 30 : 60);
      setInitialVisibleCount(isMobile ? 50 : 100);
    }

    // Check if we need to preload or if we've done it before
    const alreadyPreloaded = checkPreloadCache();
    setPreloading(!alreadyPreloaded);
  }, []);

  const handlePreloadComplete = () => {
    setPreloading(false);

    // Save preload status to localStorage
    try {
      localStorage.setItem(PRELOAD_CACHE_KEY, 'completed');
    } catch (error) {
      console.warn('Could not save to localStorage:', error);
    }
  };

  // Show nothing while checking cache (prevents flash)
  if (preloading === null) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-between p-0">
        <div className="fixed inset-0 z-[100] bg-[rgb(20,20,30)]" />
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-between p-0">
      {preloading ? (
        <ImagePreloader
          images={images}
          onComplete={handlePreloadComplete}
          batchSize={batchSize}
          initialVisibleCount={initialVisibleCount}
        />
      ) : (
        // Suspense satisfies Next's requirement for components that read
        // search params (useColorFilter → useSearchParams in the grid).
        <Suspense fallback={null}>
          <VirtualizedZoomGrid images={images} />
        </Suspense>
      )}
    </main>
  );
}
