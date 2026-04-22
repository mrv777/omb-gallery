"use client";

import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';

type FavoritesContextType = {
  favorites: Set<string>;
  toggleFavorite: (src: string) => void;
  isFavorite: (src: string) => boolean;
};

const FavoritesContext = createContext<FavoritesContextType | undefined>(undefined);

const STORAGE_KEY = 'favorites_v1';

export function FavoritesProvider({ children }: { children: React.ReactNode }) {
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [mounted, setMounted] = useState(false);

  // Load favorites from localStorage on mount
  useEffect(() => {
    setMounted(true);

    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          setFavorites(new Set(parsed));
        }
      }
    } catch (e) {
      console.error('Error reading favorites from localStorage:', e);
    }
  }, []);

  // Save favorites to localStorage when they change
  useEffect(() => {
    if (mounted) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(favorites)));
      } catch (e) {
        console.error('Error storing favorites in localStorage:', e);
      }
    }
  }, [favorites, mounted]);

  const toggleFavorite = useCallback((src: string) => {
    setFavorites(prev => {
      const next = new Set(prev);
      if (next.has(src)) {
        next.delete(src);
      } else {
        next.add(src);
      }
      return next;
    });
  }, []);

  const isFavorite = useCallback((src: string) => {
    return favorites.has(src);
  }, [favorites]);

  const contextValue = useMemo(() => ({
    favorites,
    toggleFavorite,
    isFavorite,
  }), [favorites, toggleFavorite, isFavorite]);

  return (
    <FavoritesContext.Provider value={contextValue}>
      {children}
    </FavoritesContext.Provider>
  );
}

export function useFavorites() {
  const context = useContext(FavoritesContext);
  if (context === undefined) {
    throw new Error('useFavorites must be used within a FavoritesProvider');
  }
  return context;
}
