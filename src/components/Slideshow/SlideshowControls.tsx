"use client";

import { memo, useEffect, useState } from 'react';
import { MAX_SPEED, MIN_SPEED, clampSpeed, type Order, type Speed } from './Slideshow';

type Props = {
  visible: boolean;
  playing: boolean;
  speed: Speed;
  order: Order;
  loop: boolean;
  isFs: boolean;
  canShare: boolean;
  onPlayPause: () => void;
  onPrev: () => void;
  onNext: () => void;
  onSpeedChange: (s: Speed) => void;
  onToggleOrder: () => void;
  onToggleLoop: () => void;
  onToggleFullscreen: () => void;
  onShare: () => void;
  onExit: () => void;
};

const SlideshowControls = memo(function SlideshowControls({
  visible,
  playing,
  speed,
  order,
  loop,
  isFs,
  canShare,
  onPlayPause,
  onPrev,
  onNext,
  onSpeedChange,
  onToggleOrder,
  onToggleLoop,
  onToggleFullscreen,
  onShare,
  onExit,
}: Props) {
  // Hide the "full" button on platforms without the Fullscreen API (notably
  // iPhone Safari) — the button would otherwise silently do nothing.
  const [fullscreenSupported, setFullscreenSupported] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    setFullscreenSupported(
      typeof document !== 'undefined' &&
        'fullscreenEnabled' in document &&
        !!document.fullscreenEnabled
    );
    const mq = window.matchMedia('(max-width: 767px)');
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  return (
    <div
      className={`absolute bottom-0 left-0 right-0 transition-opacity duration-300 px-3 pb-4 pt-10 bg-gradient-to-t from-ink-0 via-ink-0/70 to-transparent ${
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mx-auto max-w-5xl flex flex-wrap items-center justify-center gap-2 sm:gap-4 px-3 sm:px-4 py-3 font-mono text-[11px] tracking-[0.12em] uppercase bg-ink-0/90 backdrop-blur-md border border-ink-2 shadow-[0_4px_20px_rgba(0,0,0,0.6)]">
        {/* Transport */}
        <div className="flex items-center">
          <button
            type="button"
            onClick={onPrev}
            className="h-10 w-10 flex items-center justify-center text-bone-dim hover:text-bone transition-colors"
            aria-label="Previous"
          >
            ←
          </button>
          <button
            type="button"
            onClick={onPlayPause}
            className="h-10 w-12 flex items-center justify-center text-bone border border-bone hover:bg-bone hover:text-ink-0 transition-colors"
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? '❚❚' : '▶'}
          </button>
          <button
            type="button"
            onClick={onNext}
            className="h-10 w-10 flex items-center justify-center text-bone-dim hover:text-bone transition-colors"
            aria-label="Next"
          >
            →
          </button>
        </div>

        {/* Speed slider */}
        <label className="flex items-center gap-2 h-10 px-1">
          {!isMobile && <span className="text-bone-dim">speed</span>}
          <input
            type="range"
            min={MIN_SPEED}
            max={MAX_SPEED}
            step={1}
            value={speed}
            onChange={(e) => onSpeedChange(clampSpeed(Number(e.target.value)))}
            aria-label={`Speed ${speed} seconds`}
            className="omb-speed-slider w-20 sm:w-32 accent-bone"
          />
          <span className="text-bone tabular-nums w-[2.5ch] text-right">{speed}s</span>
        </label>

        {/* Toggles */}
        <div className="flex items-center">
          <button
            type="button"
            onClick={onToggleOrder}
            className={`h-10 px-2 flex items-center transition-colors ${
              order === 'random' ? 'text-bone' : 'text-bone-dim hover:text-bone'
            }`}
            aria-label="Toggle shuffle"
            aria-pressed={order === 'random'}
          >
            <span className={`border px-1.5 py-0.5 ${order === 'random' ? 'border-bone' : 'border-transparent'}`}>
              shuffle
            </span>
          </button>
          <button
            type="button"
            onClick={onToggleLoop}
            className={`h-10 px-2 flex items-center transition-colors ${
              loop ? 'text-bone' : 'text-bone-dim hover:text-bone'
            }`}
            aria-label="Toggle loop"
            aria-pressed={loop}
          >
            <span className={`border px-1.5 py-0.5 ${loop ? 'border-bone' : 'border-transparent'}`}>
              loop
            </span>
          </button>
        </div>

        {/* Right cluster */}
        <div className="flex items-center">
          {fullscreenSupported && (
            <button
              type="button"
              onClick={onToggleFullscreen}
              className="h-10 px-2 flex items-center text-bone-dim hover:text-bone transition-colors"
              aria-label={isFs ? 'Exit fullscreen' : 'Enter fullscreen'}
              aria-pressed={isFs}
            >
              <span className={`border px-1.5 py-0.5 ${isFs ? 'border-bone' : 'border-transparent'}`}>
                full
              </span>
            </button>
          )}
          {canShare && (
            <button
              type="button"
              onClick={onShare}
              className="h-10 px-2 flex items-center text-bone-dim hover:text-bone transition-colors"
              aria-label="Share slideshow"
            >
              <span className="border border-transparent px-1.5 py-0.5">share</span>
            </button>
          )}
          <button
            type="button"
            onClick={onExit}
            className="h-10 px-2 flex items-center text-bone-dim hover:text-bone transition-colors"
            aria-label="Exit slideshow"
          >
            <span className="border border-transparent px-1.5 py-0.5">exit</span>
          </button>
        </div>
      </div>
    </div>
  );
});

export default SlideshowControls;
