'use client';

import React, { useRef, useEffect, ReactNode } from 'react';
import { useGesture } from '@use-gesture/react';

interface ZoomGestureHandlerProps {
  children: ReactNode;
  onZoom: (delta: number, isDiscrete: boolean) => void;
  disabled?: boolean;
}

export default function ZoomGestureHandler({
  children,
  onZoom,
  disabled,
}: ZoomGestureHandlerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const lastScale = useRef(1);

  // Prevent default browser zoom behavior
  useEffect(() => {
    const preventDefaultZoom = (e: TouchEvent) => {
      if (e.touches.length > 1) {
        e.preventDefault();
      }
    };

    const preventGesture = (e: Event) => {
      e.preventDefault();
    };

    document.addEventListener('touchmove', preventDefaultZoom, { passive: false });
    document.addEventListener('gesturestart', preventGesture);
    document.addEventListener('gesturechange', preventGesture);

    return () => {
      document.removeEventListener('touchmove', preventDefaultZoom);
      document.removeEventListener('gesturestart', preventGesture);
      document.removeEventListener('gesturechange', preventGesture);
    };
  }, []);

  useGesture(
    {
      // Pinch gesture for mobile
      onPinch: ({ offset: [scale], memo = lastScale.current }) => {
        if (disabled) return memo;

        // Calculate delta from previous scale
        const delta = scale - memo;
        if (Math.abs(delta) > 0.05) {
          // Negative delta = zooming out (pinch in), want more columns
          // Positive delta = zooming in (pinch out), want fewer columns
          onZoom(-delta * 100, false);
          lastScale.current = scale;
        }
        return scale;
      },
      onPinchEnd: () => {
        lastScale.current = 1;
      },

      // Wheel gesture for desktop
      onWheel: ({ delta: [, dy], ctrlKey, metaKey, event }) => {
        if (disabled) return;

        // Only zoom with modifier key (Ctrl on Windows/Linux, Cmd on Mac)
        // OR if it's a trackpad pinch (ctrlKey is auto-set by browser)
        if (ctrlKey || metaKey) {
          event.preventDefault();
          // Positive dy = scroll down = zoom out = more columns
          // Negative dy = scroll up = zoom in = fewer columns
          onZoom(dy, false);
        }
        // Without modifier, allow normal scrolling (handled by browser)
      },
    },
    {
      target: containerRef,
      eventOptions: { passive: false },
      pinch: {
        scaleBounds: { min: 0.1, max: 10 },
        rubberband: true,
      },
    }
  );

  return (
    <div
      ref={containerRef}
      style={{
        touchAction: 'pan-y', // Allow vertical scrolling, capture pinch
        width: '100%',
        height: '100%',
      }}
    >
      {children}
    </div>
  );
}
