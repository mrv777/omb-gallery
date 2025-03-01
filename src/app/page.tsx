"use client";

import { GalleryImage } from '@/lib/types';
import ZoomableGallery from '@/components/ZoomableGallery';
import { useEffect, useState } from 'react';
import { loadImages } from '@/lib/imageLoader';

export default function Home() {
  const [images, setImages] = useState<GalleryImage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    try {
      // Load images directly instead of fetching from API
      const galleryImages = loadImages();
      setImages(galleryImages);
      setLoading(false);
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
    }
  }, []);
  
  return (
    <main className="flex min-h-screen flex-col items-center justify-between p-0">
      {loading ? (
        <div className="flex items-center justify-center h-screen">
          <div className="text-center">
            <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent align-[-0.125em] motion-reduce:animate-[spin_1.5s_linear_infinite] dark:border-white dark:border-r-transparent"></div>
            <p className="mt-2 dark:text-white">Loading gallery...</p>
          </div>
        </div>
      ) : (
        <ZoomableGallery images={images} />
      )}
    </main>
  );
} 