'use client';

import { useState, useEffect, useMemo } from 'react';
import { GalleryImage } from '@/lib/types';

interface ImagePreloaderProps {
  images: GalleryImage[];
  onComplete: () => void;
  batchSize?: number;
  initialVisibleCount?: number;
}

const BAR_SEGMENTS = 24;

export default function ImagePreloader({
  images,
  onComplete,
  batchSize = 10,
  initialVisibleCount = 100,
}: ImagePreloaderProps) {
  const [progress, setProgress] = useState(0);
  const [loadedCount, setLoadedCount] = useState(0);
  const preloadCount = Math.min(initialVisibleCount, images.length);
  const [timeElapsed, setTimeElapsed] = useState(0);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);

  const bar = useMemo(() => {
    const filled = Math.floor((progress / 100) * BAR_SEGMENTS);
    return '█'.repeat(filled) + '░'.repeat(BAR_SEGMENTS - filled);
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
      return new Promise<void>(resolve => {
        const img = new Image();
        const finish = () => {
          img.onload = null;
          img.onerror = null;
          if (!cancelled) {
            loadedImages++;
            setLoadedCount(loadedImages);
            setProgress(Math.floor((loadedImages / preloadCount) * 100));
          }
          resolve();
        };
        img.onload = async () => {
          // Decode so the first-viewport cells paint without a decode stall
          try {
            await img.decode();
          } catch {
            // Decode failed, but the image bits are still cached
          }
          finish();
        };
        img.onerror = finish;
        img.src = src;
      });
    };

    const preloadInitialBatch = async () => {
      const initial = images.slice(0, preloadCount);
      // Connection-aware chunking: caller picks batchSize based on
      // navigator.connection.effectiveType. Without this, 100+ requests fire
      // concurrently on slow links and the actual viewport thumbnails wait
      // behind off-screen ones.
      const size = Math.max(1, batchSize);
      for (let i = 0; i < initial.length && !cancelled; i += size) {
        const slice = initial.slice(i, i + size);
        await Promise.all(slice.map(image => preloadImage(image.thumbnail)));
      }

      if (!cancelled) {
        setInitialLoadComplete(true);
        clearInterval(timer);
        onComplete();
      }
    };

    preloadInitialBatch();

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [images, onComplete, preloadCount, batchSize]);

  const showSkip = timeElapsed > 3 && !initialLoadComplete;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-ink-0 text-bone font-mono">
      <div className="text-center px-4">
        <div className="text-[11px] tracking-[0.24em] text-bone-dim uppercase mb-6">
          omb archive / loading
        </div>

        <div className="text-base tracking-[0.12em] text-bone">
          <span className="text-bone-dim">[</span>
          {bar}
          <span className="text-bone-dim">]</span>
          <span className="ml-3 tabular-nums text-bone-dim">
            {String(progress).padStart(3, ' ')}%
          </span>
        </div>

        <div className="mt-4 text-[11px] tracking-[0.16em] text-bone-dim uppercase tabular-nums">
          loaded {loadedCount}/{preloadCount}
        </div>

        {showSkip && (
          <button
            type="button"
            onClick={onComplete}
            className="mt-10 text-[11px] tracking-[0.2em] uppercase text-bone-dim hover:text-bone underline underline-offset-4"
          >
            [ skip ]
          </button>
        )}
      </div>
    </div>
  );
}
