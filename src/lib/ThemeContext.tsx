"use client";

import { createContext, useContext, useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

type ThemeContextType = {
  theme: Theme;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Initialize with the current theme state from the document
  const initialTheme = typeof document !== 'undefined' && 
    document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    
    try {
      // Check if theme is stored in localStorage
      const storedTheme = localStorage.getItem('theme') as Theme | null;
      
      // Check if user prefers dark mode
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      
      // Set theme based on stored preference or system preference
      if (storedTheme) {
        setTheme(storedTheme);
      } else if (prefersDark) {
        setTheme('dark');
      }
    } catch (e) {
      // Fail silently if localStorage is not available
      console.error('Error reading theme from localStorage:', e);
    }
  }, []);

  useEffect(() => {
    // Only update the DOM after component is mounted to avoid hydration mismatch
    if (mounted) {
      try {
        // Update document with the current theme
        if (theme === 'dark') {
          document.documentElement.classList.add('dark');
        } else {
          document.documentElement.classList.remove('dark');
        }
        
        // Store theme preference
        localStorage.setItem('theme', theme);
      } catch (e) {
        // Fail silently if localStorage is not available
        console.error('Error storing theme in localStorage:', e);
      }
    }
  }, [theme, mounted]);

  const toggleTheme = () => {
    setTheme(prevTheme => prevTheme === 'light' ? 'dark' : 'light');
  };

  // Provide the value that will be available to consumers
  const contextValue = {
    theme,
    toggleTheme
  };

  return (
    <ThemeContext.Provider value={contextValue}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
} 