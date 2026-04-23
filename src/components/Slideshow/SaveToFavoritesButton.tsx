"use client";

import { useCallback, useState } from 'react';
import { useFavorites } from '@/lib/FavoritesContext';

type Props = {
  srcs: string[];
  visible: boolean;
};

export default function SaveToFavoritesButton({ srcs, visible }: Props) {
  const { addManyFavorites, favorites } = useFavorites();
  const [flash, setFlash] = useState<'idle' | 'saved'>('idle');

  const allSaved = srcs.every((s) => favorites.has(s));

  const onClick = useCallback(() => {
    addManyFavorites(srcs);
    setFlash('saved');
    window.setTimeout(() => setFlash('idle'), 2000);
  }, [addManyFavorites, srcs]);

  return (
    <div
      className={`absolute top-14 right-4 sm:top-16 sm:right-6 transition-opacity duration-300 ${
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={onClick}
        disabled={allSaved}
        className={`h-10 px-3 font-mono text-[11px] tracking-[0.12em] uppercase transition-colors ${
          allSaved
            ? 'text-bone-dim border border-ink-2 cursor-default'
            : 'text-bone border border-bone hover:bg-bone hover:text-ink-0'
        }`}
        aria-label="Save all images to favorites"
      >
        {allSaved ? '♥ saved' : flash === 'saved' ? '♥ added' : '♡ save to favorites'}
      </button>
    </div>
  );
}
