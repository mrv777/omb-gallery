'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GalleryImage } from '@/lib/types';
import { getThumbnailUrl } from './VirtualRow';
import { computePreviewPlacement, isPreviewEnabled, type Placement } from './previewGeometry';

/**
 * A single floating preview card for the zoomed-out grid.
 *
 * Deliberately NOT built on `ui/HoverImagePreview` (Radix HoverCard): that
 * mounts one Root per trigger, and the grid holds 450–1000 cells that
 * mount/unmount continuously while scrolling. Instead this is one portalled
 * card driven by one set of delegated listeners on the scroll container, so
 * the cost is constant regardless of column count.
 *
 * It lives here, as a leaf, rather than in VirtualizedZoomGrid: hover state up
 * there would re-render FilterControls and re-run useGesture setup on every
 * pointer crossing. (Rows themselves are safe either way — their memo
 * comparator ignores everything but layout props.)
 */

/**
 * 256 is a clean downscale of the 336x336 full-size art (8,698 WebP + 303 JPEG
 * under public/images/) — never an upsample. There is no asset between the
 * 128px thumbnail and this, so 2x-upscaling the thumbnail is the alternative,
 * and it defeats the point of a preview you reach for because you can't read
 * the tile.
 */
const PREVIEW_SIZE_PX = 256;
const PREVIEW_GAP_PX = 10;
const PREVIEW_PAD_PX = 12;
/** Below this the card is too small to be worth the occlusion. */
const PREVIEW_MIN_SIZE_PX = 96;

const OPEN_DELAY_MS = 150; // matches HoverImagePreview's openDelay
const CLOSE_DELAY_MS = 60;
/** Same window VirtualRow uses to ignore touch-synthesised mouse events. */
const TOUCH_GUARD_MS = 500;
const ZOOM_SUPPRESS_MS = 200;

interface HoverState {
  index: number;
  placement: Placement;
  size: number;
  /** Source cell, viewport coords — drawn as a ring so the card has an owner. */
  anchor: { x: number; y: number; w: number; h: number };
}

interface Props {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** The same array `data-index` indexes into — i.e. filteredImages. */
  images: GalleryImage[];
  cellSize: number;
  columnCount: number;
  disabled: boolean;
}

export default function GridHoverPreview({
  scrollRef,
  images,
  cellSize,
  columnCount,
  disabled,
}: Props) {
  const [hover, setHover] = useState<HoverState | null>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);

  const enabled = isPreviewEnabled(cellSize) && !disabled;

  // Handlers read these instead of closing over props, so the listener effect
  // can depend on `enabled` alone and never re-attach mid-hover.
  const imagesLength = useRef(images.length);
  const openIndex = useRef(-1);
  const pending = useRef<{ index: number; el: HTMLElement } | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const pointer = useRef<{ x: number; y: number; seen: boolean }>({ x: 0, y: 0, seen: false });
  const rowWatch = useRef<{ connect: () => void; disconnect: () => void } | null>(null);
  const recentTouch = useRef(0);
  const suppressUntil = useRef(0);

  useEffect(() => {
    imagesLength.current = images.length;
  }, [images.length]);

  const clearOpenTimer = useCallback(() => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  }, []);

  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const clearFrame = useCallback(() => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
  }, []);

  const close = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    clearFrame();
    // Stop watching rows the moment nothing is open. A registered observer
    // still costs MutationRecord allocation on every row transform rewrite —
    // i.e. constantly, while scrolling the zoomed-out grid — even though the
    // callback would early-return. Having a card open is the rare state.
    rowWatch.current?.disconnect();
    pending.current = null;
    openIndex.current = -1;
    setHover(null);
  }, [clearOpenTimer, clearCloseTimer, clearFrame]);

  const scheduleClose = useCallback(() => {
    // A pending open must never survive leaving the cell that requested it.
    clearOpenTimer();
    pending.current = null;
    if (openIndex.current < 0 || closeTimer.current !== null) return;
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      close();
    }, CLOSE_DELAY_MS);
  }, [clearOpenTimer, close]);

  /** Measure and show. The rect read happens before any style write this frame. */
  const commit = useCallback(
    (index: number, el: HTMLElement) => {
      const container = scrollRef.current;
      if (!container || !el.isConnected) {
        close();
        return;
      }
      const bounds = container.getBoundingClientRect();
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const size = Math.min(
        PREVIEW_SIZE_PX,
        Math.floor(Math.min(viewport.width, bounds.height) * 0.6)
      );
      if (size < PREVIEW_MIN_SIZE_PX) {
        close();
        return;
      }
      const rect = el.getBoundingClientRect();
      const placement = computePreviewPlacement(
        rect,
        bounds,
        viewport,
        size,
        PREVIEW_GAP_PX,
        PREVIEW_PAD_PX
      );
      const anchor = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      };
      openIndex.current = index;
      rowWatch.current?.connect();
      // Scroll re-resolves fire every frame while a card is open; most of them
      // land on identical geometry. Bail before setHover so those frames cost
      // nothing rather than re-rendering the portal.
      setHover(prev =>
        prev &&
        prev.index === index &&
        prev.size === size &&
        prev.placement.x === placement.x &&
        prev.placement.y === placement.y &&
        prev.anchor.x === anchor.x &&
        prev.anchor.y === anchor.y
          ? prev
          : { index, placement, size, anchor }
      );
    },
    [scrollRef, close]
  );

  /**
   * Single resolution path, shared by pointer events and by the scroll /
   * zoom re-resolve. Takes an Element rather than an event so a future
   * roving-tabindex pass can wire focusin/focusout to it unchanged.
   */
  const applyTarget = useCallback(
    (target: Element | null, immediate = false) => {
      if (!target || Date.now() < suppressUntil.current) {
        scheduleClose();
        return;
      }
      // The favourite button sits inside the cell; dismiss so it's clickable.
      if (target.closest('[data-fav-btn]')) {
        scheduleClose();
        return;
      }
      // Trailing filler cells carry no data-index, so they close correctly here.
      const cell = target.closest('[data-index]') as HTMLElement | null;
      if (!cell) {
        scheduleClose();
        return;
      }
      const index = Number.parseInt(cell.dataset.index ?? '-1', 10);
      if (!Number.isInteger(index) || index < 0 || index >= imagesLength.current) {
        scheduleClose();
        return;
      }

      clearCloseTimer();
      // Same cell as last time: nothing to do for a pointer move, but a scroll
      // may have shifted that same cell by a few pixels, and the ring is glued
      // to it — so let `immediate` through to re-measure. commit() drops the
      // re-render if the geometry turns out identical.
      if (index === openIndex.current && !immediate) return;

      pending.current = { index, el: cell };

      if (openIndex.current >= 0) {
        // Scroll and row-change callbacks are already at most one per frame, so
        // there is nothing to coalesce — and routing them through rAF would make
        // the card's correctness depend on frame timing.
        if (immediate) {
          commit(index, cell);
          return;
        }
        // Already open — swap straight away, coalesced to one frame. Re-imposing
        // the dwell delay per neighbour makes preview mode feel broken.
        if (frame.current !== null) return;
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          const next = pending.current;
          if (next) commit(next.index, next.el);
        });
        return;
      }

      // Closed — require a dwell. This one delay is what keeps a fast sweep
      // across 50 columns at zero renders and zero image fetches.
      clearOpenTimer();
      openTimer.current = window.setTimeout(() => {
        openTimer.current = null;
        const next = pending.current;
        if (next) commit(next.index, next.el);
      }, OPEN_DELAY_MS);
    },
    [scheduleClose, clearCloseTimer, clearOpenTimer, commit]
  );

  /**
   * react-virtual unmounts rows that scroll out of the overscan window, and
   * browsers do not fire mouseout for a removed element — so a scroll would
   * otherwise strand the card on a detached node. Re-resolving from the last
   * pointer position works precisely because the card is pointer-events: none,
   * so elementFromPoint sees straight through it to the cell underneath.
   */
  const resolveFromPoint = useCallback(() => {
    if (!pointer.current.seen) return;
    applyTarget(document.elementFromPoint(pointer.current.x, pointer.current.y), true);
  }, [applyTarget]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !enabled) return;
    // Positive form on purpose: on hybrids (Surface, iPad + trackpad) this is
    // not the complement of VirtualRow's `(hover: none) and (pointer: coarse)`.
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    const onMouseOver = (e: MouseEvent) => {
      if (Date.now() - recentTouch.current < TOUCH_GUARD_MS) return;
      applyTarget(e.target as Element | null);
    };
    // Ref writes only — no allocation, no render, no layout.
    const onMouseMove = (e: MouseEvent) => {
      pointer.current.x = e.clientX;
      pointer.current.y = e.clientY;
      pointer.current.seen = true;
    };
    const onMouseLeave = () => close();
    const onTouchStart = () => {
      recentTouch.current = Date.now();
      close();
    };
    // Chrome already coalesces scroll events to one per frame, and this only
    // runs while a card is open, so no extra throttling is needed. Resolving
    // synchronously (rather than in a rAF) matters: elementFromPoint reflects
    // what is *painted right now*, so the card always agrees with what the user
    // can see. The post-commit case is picked up by the observer below.
    const onScroll = () => {
      if (openIndex.current < 0 && openTimer.current === null) return;
      resolveFromPoint();
    };
    const onWheel = (e: WheelEvent) => {
      // Pinch and ctrl+wheel zoom re-lay out the grid under the cursor.
      if (!e.ctrlKey && !e.metaKey) return;
      suppressUntil.current = Date.now() + ZOOM_SUPPRESS_MS;
      close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    // Without these, alt-tabbing away strands the card — no mouseout fires.
    const onBlur = () => close();
    const onVisibility = () => {
      if (document.hidden) close();
    };
    const onResize = () => close();

    // The correctness backstop for scrolling. A scroll event fires before
    // react-virtual's React update commits, so resolving on scroll alone can
    // latch the row that was painted a frame ago and then never revisit it —
    // the pointer isn't moving, so no further event arrives. This fires exactly
    // when the rows actually change, which is the moment the answer changes.
    const rows = new MutationObserver(() => {
      if (openIndex.current < 0) return;
      resolveFromPoint();
    });
    let observing = false;
    // `style` as well as `childList`: react-virtual recycles row elements and
    // repositions them by rewriting their inline transform, so a scroll can
    // change which image sits under the pointer without adding or removing a
    // single node. Safe from feedback — the card is portalled to <body>, so
    // nothing this callback renders is inside `container`.
    rowWatch.current = {
      connect: () => {
        if (observing) return;
        observing = true;
        rows.observe(container, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['style'],
        });
      },
      disconnect: () => {
        observing = false;
        rows.disconnect();
      },
    };

    container.addEventListener('mouseover', onMouseOver);
    container.addEventListener('mousemove', onMouseMove, { passive: true });
    container.addEventListener('mouseleave', onMouseLeave);
    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('scroll', onScroll, { passive: true });
    container.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      rows.disconnect();
      rowWatch.current = null;
      container.removeEventListener('mouseover', onMouseOver);
      container.removeEventListener('mousemove', onMouseMove);
      container.removeEventListener('mouseleave', onMouseLeave);
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('scroll', onScroll);
      container.removeEventListener('wheel', onWheel);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('visibilitychange', onVisibility);
      close();
    };
  }, [enabled, scrollRef, applyTarget, resolveFromPoint, close]);

  // Zoom changed the grid under a parked cursor. rAF so the new row layout has
  // been applied before elementFromPoint runs; the row observer above catches
  // the second pass that rowVirtualizer.measure() triggers.
  useEffect(() => {
    if (!enabled) return;
    const id = requestAnimationFrame(() => resolveFromPoint());
    return () => cancelAnimationFrame(id);
  }, [cellSize, columnCount, enabled, resolveFromPoint]);

  // No SSR guard needed: `hover` can only become non-null from a pointer event,
  // so the portal is never reached during server render or hydration.
  if (!enabled || !hover) return null;
  // Derived from the index, never stored — so a filter change that shortens the
  // list self-corrects instead of stranding a stale image.
  const image = images[hover.index];
  if (!image) return null;

  const { x, y } = hover.placement;
  const fullLoaded = loadedSrc === image.src;

  return createPortal(
    <>
      {/* Which tile does this card belong to? At >20 columns the in-cell label
       * is off and cells are ~25px, so a card floating beside them has no
       * visible owner. Drawn from the overlay rather than by styling the cell:
       * touching the cell would mean re-rendering up to 50 of them per hover. */}
      <div
        aria-hidden="true"
        className="fixed left-0 top-0 z-[1200]"
        style={{
          width: hover.anchor.w,
          height: hover.anchor.h,
          transform: `translate3d(${hover.anchor.x}px, ${hover.anchor.y}px, 0)`,
          boxShadow: '0 0 0 2px var(--bone), 0 0 0 3px rgba(0,0,0,0.65)',
          pointerEvents: 'none',
        }}
      />
      <div
        aria-hidden="true"
        className="grid-hover-preview fixed left-0 top-0 z-[1200] border border-bone-dim/30 bg-ink-1 p-1 shadow-2xl"
        style={{
          width: hover.size,
          height: hover.size,
          transform: `translate3d(${x}px, ${y}px, 0)`,
          pointerEvents: 'none',
        }}
      >
        <div
          className="relative h-full w-full"
          style={{
            // The exact URL the cell is painting right now — a guaranteed cache
            // hit, so the card is never empty while the full-size art is in flight.
            backgroundColor: '#151515',
            backgroundImage: `url(${getThumbnailUrl(image.thumbnail, cellSize)})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={image.src}
            src={image.src}
            alt=""
            decoding="async"
            onLoad={() => setLoadedSrc(image.src)}
            className="absolute inset-0 h-full w-full object-cover"
            style={{
              opacity: fullLoaded ? 1 : 0,
              transition: 'opacity 120ms ease-out',
            }}
          />
          {Number.isFinite(image.number) && (
            <span className="grid-hover-preview__label">#{image.number}</span>
          )}
        </div>
      </div>
    </>,
    document.body
  );
}
