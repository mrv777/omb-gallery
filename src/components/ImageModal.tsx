"use client";

import React, { memo } from 'react';
import Image from 'next/image';
import { GalleryImage } from '@/lib/types';

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
  if (!isOpen || images.length === 0 || currentImage < 0) {
    return null;
  }

  const image = images[currentImage];

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
        {/* Close button at the top */}
        <div className="w-full flex justify-end mb-2">
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
