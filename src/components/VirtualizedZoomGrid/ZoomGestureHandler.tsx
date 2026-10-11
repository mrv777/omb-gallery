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
  const lastScale = useRef<number | null>(null);

  // Prevent the browser's own pinch-zoom so a pinch changes column count
  // instead of scaling the page.
  //
  // Deliberately NOT via a non-passive `touchmove` listener on document: that
  // forces the browser to wait on JS before every single-finger scroll of the
  // grid, which on a phone reads as "scrolling does nothing". `touch-action:
  // pan-y` on the container below already blocks touch-action zoom (Chrome,
  // Android, iOS 13+), and `gesturestart`/`gesturechange` cover WebKit's
  // separate legacy zoom path. Neither costs the scroll fast path.
  useEffect(() => {
    const preventGesture = (e: Event) => {
      e.preventDefault();
    };

    document.addEventListener('gesturestart', preventGesture, { passive: false });
    document.addEventListener('gesturechange', preventGesture, { passive: false });

    return () => {
      document.removeEventListener('gesturestart', preventGesture);
      document.removeEventListener('gesturechange', preventGesture);
    };
  }, []);

  useGesture(
    {
      // Pinch gesture for mobile
      onPinch: ({ offset: [scale], first }) => {
        const previous = first ? null : lastScale.current;
        lastScale.current = scale;
        if (disabled || previous === null) return;

        // useZoomLevel owns the threshold and accumulates these small frames.
        // Rebasing each gesture avoids jumps from use-gesture's persistent offset.
        const delta = scale - previous;
        if (delta !== 0) onZoom(-delta * 100, false);
      },
      onPinchEnd: () => {
        lastScale.current = null;
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
      pinch: {
        scaleBounds: { min: 0.1, max: 10 },
        rubberband: true,
        // Touch events rather than pointer events. With the pointer engine,
        // use-gesture calls setPointerCapture on *every* first finger-down —
        // including the one that starts a scroll — even though a pinch needs
        // two. The touch engine bails before doing anything until a second
        // finger lands, so a one-finger drag is untouched by us.
        pointer: { touch: true },
      },
      // Non-passive only where a handler actually calls preventDefault
      // (ctrl/cmd + wheel). Applying it to every gesture made the pinch
      // engine's touch listeners non-passive too, which blocks the browser's
      // scroll fast path for no benefit.
      wheel: { eventOptions: { passive: false } },
    }
  );

  return (
    <div
      ref={containerRef}
      style={{
        touchAction: 'pan-y', // Allow vertical scrolling, capture pinch
        width: '100%',
        height: '100%',
        // Column so the scroll container inside can be `flex-1` and resolve to
        // (viewport − header margin) instead of carrying a hardcoded 100vh.
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {children}
    </div>
  );
}
