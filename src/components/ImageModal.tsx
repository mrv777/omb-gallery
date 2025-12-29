"use client";

import React, { memo } from 'react';
import Image from 'next/image';
import { GalleryImage } from '@/lib/types';
import { useFavorites } from '@/lib/FavoritesContext';

interface ImageModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentImage: number;
  images: GalleryImage[];
  onPrev: () => void;
  onNext: () => void;
}

const ImageModal = memo(function ImageModal({
  isOpen,
  onClose,
  currentImage,
  images,
  onPrev,
  onNext,
}: ImageModalProps) {
  const { isFavorite, toggleFavorite } = useFavorites();

  if (!isOpen || images.length === 0 || currentImage < 0) {
    return null;
  }

  const image = images[currentImage];
  const favorited = isFavorite(image.src);

  // Extract filename without extension
  const fullFilename = image.src.split('/').pop() || '';
  const filenameWithoutExt = fullFilename.split('.')[0];

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-75 dark:bg-black dark:bg-opacity-90 flex items-center justify-center z-[1500]"
      onClick={onClose}
    >
      <div
        className="relative max-w-[90vw] max-h-[90vh] flex flex-col items-center overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header buttons */}
        <div className="w-full flex justify-end gap-2 mb-2">
          <button
            className="bg-black bg-opacity-50 text-white px-3 py-1.5 rounded-full hover:bg-opacity-70 dark:bg-gray-800 dark:bg-opacity-70 flex items-center justify-center"
            onClick={(e) => {
              e.stopPropagation();
              toggleFavorite(image.src);
            }}
          >
            <svg
              className={`w-5 h-5 ${favorited ? 'text-red-500' : 'text-white'}`}
              fill={favorited ? 'currentColor' : 'none'}
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
              />
            </svg>
          </button>
          <button
            className="bg-black bg-opacity-50 text-white px-3 py-1.5 rounded-full hover:bg-opacity-70 dark:bg-gray-800 dark:bg-opacity-70"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
          >
            ✕
          </button>
        </div>

        {/* Image and navigation row */}
        <div className="flex items-center justify-center w-full">
          <button
            className="mr-4 bg-black bg-opacity-50 text-white px-2 py-1 rounded-full hover:bg-opacity-70 dark:bg-gray-800 dark:bg-opacity-70"
            onClick={(e) => {
              e.stopPropagation();
              onPrev();
            }}
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
                minHeight: '336px',
              }}
              priority
              unoptimized={false}
            />
          </div>

          <button
            className="ml-4 bg-black bg-opacity-50 text-white px-2 py-1 rounded-full hover:bg-opacity-70 dark:bg-gray-800 dark:bg-opacity-70"
            onClick={(e) => {
              e.stopPropagation();
              onNext();
            }}
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

export default ImageModal;
