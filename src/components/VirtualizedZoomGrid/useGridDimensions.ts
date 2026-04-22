import { useState, useEffect, RefObject } from 'react';

interface GridDimensions {
  width: number;
  height: number;
}

export function useGridDimensions(containerRef: RefObject<HTMLDivElement | null>): GridDimensions {
  const [dimensions, setDimensions] = useState<GridDimensions>({ width: 0, height: 0 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateDimensions = () => {
      const { width, height } = container.getBoundingClientRect();
      setDimensions({ width, height });
    };

    // Initial measurement
    updateDimensions();

    // Use ResizeObserver for responsive updates
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        const { width, height } = entry.contentRect;
        setDimensions({ width, height });
      }
    });

    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, [containerRef]);

  return dimensions;
}
