'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

type Section = { title: string; items: { label: string; body: string }[] };

const SECTIONS: Section[] = [
  {
    title: 'Gallery',
    items: [
      {
        label: 'Color swatches',
        body: 'Filter by color. ALL clears it.',
      },
      { label: 'Search', body: 'Inscription number or caption keyword.' },
      {
        label: 'Heart (♡ / ♥)',
        body: 'Favorite a tile (long-press on mobile). Header heart filters to favorites.',
      },
      {
        label: '▶ PLAY',
        body: 'Plays the current filter as a slideshow.',
      },
      {
        label: '− / + / zoom',
        body: 'Adjusts columns. Pinch or scroll-zoom too.',
      },
      {
        label: 'Click a piece',
        body: 'Opens full-size. ← / → navigate, Esc closes.',
      },
    ],
  },
  {
    title: 'Slideshow',
    items: [
      {
        label: 'Controls bar',
        body: 'Auto-hides after ~2s. Move or tap to restore.',
      },
      { label: 'Speed slider', body: '1–10s per image. Default 4s.' },
      {
        label: 'Shuffle / loop',
        body: 'Shuffle reshuffles now. Loop restarts at the end.',
      },
      {
        label: 'Full',
        body: 'Browser fullscreen. Esc exits, second Esc closes.',
      },
      {
        label: 'Share',
        body: 'Short link freezing the exact image set. Turnstile-gated.',
      },
      {
        label: 'Keyboard',
        body: 'Space play/pause · ← → prev/next · F fullscreen · S shuffle · L loop · [ / ] speed · Esc exit.',
      },
      { label: 'Touch', body: 'Swipe ← / → to navigate. Tap to play/pause.' },
    ],
  },
  {
    title: 'Notifications',
    items: [
      {
        label: 'Watch button',
        body: 'Bell icon subscribes to transfer / sale / listing alerts for a tile, color, or inscription.',
      },
      {
        label: 'Channels',
        body: 'Telegram bot or Discord webhook. Both can run from one browser.',
      },
      {
        label: 'Manage',
        body: '/notifications lists watches — mute, edit events, or remove. Or /list in the Telegram bot.',
      },
    ],
  },
  {
    title: 'Activity & Explorer',
    items: [
      {
        label: 'Activity',
        body: 'Live on-chain feed. Refreshes every 60s when visible.',
      },
      {
        label: 'Explorer',
        body: 'Leaderboards: most-transferred, longest-unmoved, top volume, highest sale, top holders.',
      },
    ],
  },
];

export function HelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [open, onClose]);

  if (!open || !mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[2000] bg-ink-0/80 backdrop-blur-sm flex items-start sm:items-center justify-center px-4 py-8 overflow-y-auto"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Help"
        className="w-full max-w-3xl bg-ink-1 border border-ink-2 p-6 sm:p-8 font-mono text-xs tracking-[0.08em] uppercase"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-5">
          <h2 className="text-bone text-sm">How this works</h2>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 flex items-center justify-center text-bone-dim hover:text-bone transition-colors -mr-2 -mt-1"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="space-y-6">
          {SECTIONS.map(section => (
            <section key={section.title}>
              <h3 className="text-bone mb-3 tracking-[0.15em]">{section.title}</h3>
              <dl className="space-y-2">
                {section.items.map(item => (
                  <div
                    key={item.label}
                    className="grid grid-cols-[8rem_1fr] sm:grid-cols-[9rem_1fr] gap-3 items-start"
                  >
                    <dt className="text-bone-dim pt-0.5">{item.label}</dt>
                    <dd className="text-bone normal-case tracking-normal leading-relaxed">
                      {item.body}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>

        <p className="mt-8 text-bone-dim normal-case tracking-normal">
          Source:{' '}
          <a
            href="https://github.com/mrv777/omb-gallery"
            target="_blank"
            rel="noopener noreferrer"
            className="text-bone hover:underline underline-offset-4"
          >
            github.com/mrv777/omb-gallery
          </a>
        </p>
      </div>
    </div>,
    document.body
  );
}

export default function HelpButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Help"
        className="h-10 w-10 flex items-center justify-center text-bone-dim hover:text-bone transition-colors font-mono text-base leading-none"
      >
        ?
      </button>

      <HelpDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
