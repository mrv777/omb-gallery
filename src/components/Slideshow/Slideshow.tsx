"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import type { SlideshowImage } from '@/lib/slideshowImages';
import SlideshowControls from './SlideshowControls';
import ShareDialog from './ShareDialog';
import SaveToFavoritesButton from './SaveToFavoritesButton';

export type Order = 'seq' | 'random';
export type Speed = number;
export const MIN_SPEED = 1;
export const MAX_SPEED = 10;
export const DEFAULT_SPEED: Speed = 4;

export function clampSpeed(n: number): Speed {
  if (!Number.isFinite(n)) return DEFAULT_SPEED;
  const rounded = Math.round(n);
  if (rounded < MIN_SPEED) return MIN_SPEED;
  if (rounded > MAX_SPEED) return MAX_SPEED;
  return rounded;
}

type Props = {
  images: SlideshowImage[];
  missing: number;
  title: string | null;
  shareSlug: string | null;
  initialSpeed: Speed;
  initialOrder: Order;
  initialLoop: boolean;
};

function shuffleIndices(len: number): number[] {
  const a = Array.from({ length: len }, (_, i) => i);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export default function Slideshow({
  images,
  missing,
  title,
  shareSlug,
  initialSpeed,
  initialOrder,
  initialLoop,
}: Props) {
  const router = useRouter();

  const [speed, setSpeed] = useState<Speed>(initialSpeed);
  const [order, setOrder] = useState<Order>(initialOrder);
  const [loop, setLoop] = useState(initialLoop);
  const [playing, setPlaying] = useState(true);
  const [pos, setPos] = useState(0);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [shareOpen, setShareOpen] = useState(false);
  const [isFs, setIsFs] = useState(false);

  // The order in which to iterate images. Reshuffles each time `order` flips
  // to 'random' (plan: "Reshuffle only on Play, no seed"). A change in images
  // also re-derives this.
  const [seqSalt, setSeqSalt] = useState(0);
  const playOrder = useMemo<number[]>(() => {
    if (order === 'seq' || images.length <= 1) {
      return Array.from({ length: images.length }, (_, i) => i);
    }
    return shuffleIndices(images.length);
    // seqSalt is intentionally referenced to re-run on shuffle-refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images.length, order, seqSalt]);

  const safePos = pos < playOrder.length ? pos : 0;
  const current = images[playOrder[safePos] ?? 0];

  // Auto-advance timer. Restarts on any change that should reset the clock.
  useEffect(() => {
    if (!playing || playOrder.length <= 1) return;
    const ms = speed * 1000;
    const t = window.setTimeout(() => {
      setPos((p) => {
        const cur = p < playOrder.length ? p : 0;
        const next = cur + 1;
        if (next < playOrder.length) return next;
        if (loop) return 0;
        setPlaying(false);
        return cur;
      });
    }, ms);
    return () => window.clearTimeout(t);
  }, [safePos, playing, speed, loop, playOrder]);

  // Pause when the tab goes hidden; don't auto-resume (user intent preserved).
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') setPlaying(false);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Preload the next 2 images so auto-advance never hitches.
  useEffect(() => {
    if (images.length < 2 || playOrder.length === 0) return;
    const urls: string[] = [];
    for (let i = 1; i <= 2; i++) {
      const idx = playOrder[(safePos + i) % playOrder.length];
      const src = images[idx]?.src;
      if (src && src !== current?.src) urls.push(src);
    }
    const loaders: HTMLImageElement[] = [];
    for (const src of urls) {
      const img = new window.Image();
      img.decoding = 'async';
      img.src = src;
      loaders.push(img);
    }
    return () => {
      for (const img of loaders) {
        img.onload = null;
        img.onerror = null;
      }
    };
  }, [safePos, playOrder, images, current?.src]);

  // Auto-hide controls after 2s of inactivity.
  const hideTimer = useRef<number | null>(null);
  const nudgeControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setControlsVisible(false), 2000);
  }, []);
  // Initial fade-out so users see the controls once on mount, then they hide.
  useEffect(() => {
    const t = window.setTimeout(() => setControlsVisible(false), 2000);
    return () => {
      window.clearTimeout(t);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, []);

  const goPrev = useCallback(() => {
    setPos((p) => {
      const len = playOrder.length;
      if (len === 0) return 0;
      const cur = p < len ? p : 0;
      return (cur - 1 + len) % len;
    });
    nudgeControls();
  }, [playOrder.length, nudgeControls]);

  const goNext = useCallback(() => {
    setPos((p) => {
      const len = playOrder.length;
      if (len === 0) return 0;
      const cur = p < len ? p : 0;
      return (cur + 1) % len;
    });
    nudgeControls();
  }, [playOrder.length, nudgeControls]);

  const togglePlaying = useCallback(() => {
    setPlaying((p) => !p);
    nudgeControls();
  }, [nudgeControls]);

  const toggleOrder = useCallback(() => {
    setOrder((o) => {
      const next = o === 'seq' ? 'random' : 'seq';
      if (next === 'random') setSeqSalt((s) => s + 1);
      return next;
    });
    setPos(0);
    nudgeControls();
  }, [nudgeControls]);

  const stepSpeed = useCallback((dir: 1 | -1) => {
    setSpeed((s) => clampSpeed(s + dir));
    nudgeControls();
  }, [nudgeControls]);

  // Fullscreen
  useEffect(() => {
    const onChange = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = document.documentElement;
    if (!document.fullscreenElement) {
      el.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
    nudgeControls();
  }, [nudgeControls]);

  const exit = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
      return;
    }
    // Prefer history back (keeps gallery scroll), fall back to push.
    if (window.history.length > 1) {
      router.back();
    } else {
      router.push('/');
    }
  }, [router]);

  // Keyboard
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (shareOpen) return;
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);
      if (typing) return;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          togglePlaying();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          goPrev();
          break;
        case 'ArrowRight':
          e.preventDefault();
          goNext();
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 's':
        case 'S':
          e.preventDefault();
          toggleOrder();
          break;
        case 'l':
        case 'L':
          e.preventDefault();
          setLoop((v) => !v);
          nudgeControls();
          break;
        case '[':
          e.preventDefault();
          stepSpeed(-1);
          break;
        case ']':
          e.preventDefault();
          stepSpeed(1);
          break;
        case 'Escape':
          e.preventDefault();
          exit();
          break;
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [shareOpen, togglePlaying, goPrev, goNext, toggleFullscreen, toggleOrder, stepSpeed, nudgeControls, exit]);

  // Touch swipe
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (!touchStart.current) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.current.x;
    const dy = t.clientY - touchStart.current.y;
    touchStart.current = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) goNext();
      else goPrev();
    } else if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      togglePlaying();
    }
  };

  // Sync URL params (speed / order / loop) without a navigation so a copy
  // of the address bar reflects the current state. Only touches the
  // querystring; path stays on /slideshow[/<slug>].
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const u = new URL(window.location.href);
    u.searchParams.set('speed', String(speed));
    u.searchParams.set('order', order);
    u.searchParams.set('loop', loop ? '1' : '0');
    window.history.replaceState(null, '', u.toString());
  }, [speed, order, loop]);

  if (images.length === 0) {
    return (
      <div className="min-h-screen bg-ink-0 text-bone flex flex-col items-center justify-center px-6 text-center font-mono text-sm tracking-[0.08em] uppercase">
        <p className="text-bone-dim mb-4">No images selected.</p>
        <Link
          href="/"
          className="text-bone border border-bone px-3 py-1.5 hover:bg-bone hover:text-ink-0 transition-colors"
        >
          Back to gallery
        </Link>
      </div>
    );
  }

  const idNum = current?.id ?? '';
  const colorLabel = current?.color?.toUpperCase() ?? '';

  return (
    <div
      className="fixed inset-0 bg-ink-0 text-bone overflow-hidden select-none"
      onMouseMove={nudgeControls}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* Image */}
      {current && (
        <Image
          key={current.src}
          src={current.src}
          alt={current.caption || `Inscription ${current.id}`}
          fill
          priority
          sizes="100vw"
          className="object-contain"
          unoptimized
        />
      )}

      {/* Screen-reader live region for advance announcements */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {current ? `Inscription ${current.id}, ${colorLabel}` : ''}
      </div>

      {/* Top chrome — title + position */}
      <div
        className={`absolute top-0 left-0 right-0 px-4 sm:px-6 py-3 font-mono text-[11px] tracking-[0.12em] uppercase flex items-center gap-3 bg-gradient-to-b from-ink-0/80 to-transparent transition-opacity duration-300 ${
          controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        <span className="text-bone truncate">
          {title ? `"${title}"` : 'OMB Slideshow'}
        </span>
        <span className="text-bone-dim">·</span>
        <a
          href={`https://ordinals.com/inscription/${idNum}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-bone hover:underline underline-offset-4 decoration-bone-dim"
          onClick={(e) => e.stopPropagation()}
        >
          #{idNum}
        </a>
        <span className="text-bone-dim">·</span>
        <span className="text-bone-dim">{colorLabel}</span>
        <span className="ml-auto text-bone-dim tabular-nums">
          {safePos + 1}/{playOrder.length}
          {missing > 0 && (
            <span className="ml-3 text-bone-dim">· {missing} unavailable</span>
          )}
        </span>
      </div>

      {/* Progress bar */}
      <div
        className={`absolute top-0 left-0 right-0 h-[2px] bg-ink-2 transition-opacity duration-300 ${
          controlsVisible ? 'opacity-60' : 'opacity-0'
        }`}
      >
        {playing && (
          <div
            key={`${safePos}-${speed}`}
            className="h-full bg-bone"
            style={{
              animation: `omb-progress ${speed}s linear forwards`,
            }}
          />
        )}
      </div>

      <SlideshowControls
        visible={controlsVisible}
        playing={playing}
        speed={speed}
        order={order}
        loop={loop}
        isFs={isFs}
        canShare={!shareSlug}
        onPlayPause={togglePlaying}
        onPrev={goPrev}
        onNext={goNext}
        onSpeedChange={(s) => {
          setSpeed(s);
          nudgeControls();
        }}
        onToggleOrder={toggleOrder}
        onToggleLoop={() => {
          setLoop((v) => !v);
          nudgeControls();
        }}
        onToggleFullscreen={toggleFullscreen}
        onShare={() => setShareOpen(true)}
        onExit={exit}
      />

      {shareSlug && (
        <SaveToFavoritesButton
          srcs={images.map((i) => i.src)}
          visible={controlsVisible}
        />
      )}

      {shareOpen && (
        <ShareDialog
          ids={images.map((i) => i.id)}
          defaultTitle={title ?? ''}
          onClose={() => setShareOpen(false)}
        />
      )}

      <style jsx>{`
        @keyframes omb-progress {
          from { width: 0%; }
          to { width: 100%; }
        }
        @media (prefers-reduced-motion: reduce) {
          div :global(.object-contain) { transition: none !important; }
        }
      `}</style>
    </div>
  );
}
