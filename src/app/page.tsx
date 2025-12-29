"use client";

import { GalleryImage } from '@/lib/types';
import VirtualizedZoomGrid from '@/components/VirtualizedZoomGrid';
import ImagePreloader from '@/components/ImagePreloader';
import { useEffect, useState } from 'react';
import { loadImages } from '@/lib/imageLoader';

// Cache version - increment this when the image set changes significantly
const CACHE_VERSION = 1;
const PRELOAD_CACHE_KEY = 'gallery_preloaded_v' + CACHE_VERSION;

export default function Home() {
  const [images, setImages] = useState<GalleryImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [preloading, setPreloading] = useState(false);
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
    if ('connection' in navigator && (navigator as any).connection) {
      const connection = (navigator as any).connection;
      
      // Adjust batch size based on connection type - optimized for HTTP/2
      if (connection.effectiveType === '4g') {
        setBatchSize(isMobile ? 50 : 100); // Increased from 20/40
      } else if (connection.effectiveType === '3g') {
        setBatchSize(isMobile ? 25 : 50);  // Increased from 10/20
      } else if (connection.effectiveType === '2g' || connection.effectiveType === 'slow-2g') {
        setBatchSize(isMobile ? 10 : 20);  // Increased from 5/10
      } else {
        // Default fallback
        setBatchSize(isMobile ? 30 : 60);  // Increased from 15/30
      }
      
      // Adjust initial visible count based on connection type
      if (connection.effectiveType === '4g') {
        setInitialVisibleCount(isMobile ? 80 : 150);
      } else if (connection.effectiveType === '3g') {
        setInitialVisibleCount(isMobile ? 40 : 80);
      } else if (connection.effectiveType === '2g' || connection.effectiveType === 'slow-2g') {
        setInitialVisibleCount(isMobile ? 20 : 40);
      } else {
        // Default fallback
        setInitialVisibleCount(isMobile ? 50 : 100);
      }
    } else {
      // Fallback if the Connection API is not available
      setBatchSize(isMobile ? 30 : 60);  // Increased from 15/30
      setInitialVisibleCount(isMobile ? 50 : 100);
    }
    
    try {
      // Load images directly instead of fetching from API
      const galleryImages = loadImages();
      setImages(galleryImages);
      setLoading(false);
      
      // Check if we need to preload or if we've done it before
      const alreadyPreloaded = checkPreloadCache();
      setPreloading(!alreadyPreloaded);
    } catch (error) {
      console.error('Error loading images:', error);
      setLoading(false);
      
      // Fallback to placeholder images if loading fails
      const placeholderImages: GalleryImage[] = [];
      const colors = ['red', 'blue', 'green', 'orange', 'black'];
      
      colors.forEach(color => {
        for (let i = 1; i <= 5; i++) {
          placeholderImages.push({
            src: `https://via.placeholder.com/800x600/${color.replace('black', '000')}`,
            thumbnail: `https://via.placeholder.com/250x250/${color.replace('black', '000')}`,
            thumbnailWidth: 250,
            thumbnailHeight: 250,
            color: color,
          });
        }
      });
      
      setImages(placeholderImages);
      setPreloading(true); // Always preload placeholder images
    }
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
  
  return (
    <main className="flex min-h-screen flex-col items-center justify-between p-0">
      {loading ? (
        <div className="flex items-center justify-center h-screen">
          <div className="text-center">
            <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent align-[-0.125em] motion-reduce:animate-[spin_1.5s_linear_infinite] dark:border-white dark:border-r-transparent"></div>
            <p className="mt-2 dark:text-white">Loading gallery metadata...</p>
          </div>
        </div>
      ) : preloading ? (
        <ImagePreloader 
          images={images} 
          onComplete={handlePreloadComplete} 
          batchSize={batchSize}
          initialVisibleCount={initialVisibleCount}
        />
      ) : (
        <VirtualizedZoomGrid images={images} />
      )}
    </main>
  );
} 