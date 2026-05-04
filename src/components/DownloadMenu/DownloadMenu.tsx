'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { triggerDownload } from '@/lib/upscale';
import { Tooltip } from '../ui/Tooltip';

interface DownloadMenuProps {
  src: string;
  inscriptionId: string;
  className?: string;
}

const TARGET_W = 1344;

const METHODS = [
  {
    key: 'mitchell',
    label: 'Standard',
    hint: `Bicubic resample · instant`,
  },
  {
    key: 'waifu2x',
    label: 'AI enhanced',
    hint: `Neural upscale · ~10s first time`,
  },
] as const;

type MethodKey = (typeof METHODS)[number]['key'];

export default function DownloadMenu({ src, inscriptionId, className }: DownloadMenuProps) {
  const [open, setOpen] = useState(false);
  const [busyKey, setBusyKey] = useState<MethodKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey, { capture: true });
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey, { capture: true });
    };
  }, [open]);

  useEffect(() => {
    setOpen(false);
    setBusyKey(null);
    setError(null);
  }, [src]);

  // Auto-clear errors after a few seconds.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error]);

  const onPick = useCallback(
    async (m: (typeof METHODS)[number]) => {
      if (busyKey) return;
      setBusyKey(m.key);
      setError(null);
      try {
        const params = new URLSearchParams({ id: inscriptionId, method: m.key });
        const res = await fetch(`/api/upscale?${params.toString()}`);
        if (res.status === 429) {
          const retry = res.headers.get('retry-after');
          const secs = retry ? Number(retry) : NaN;
          const msg =
            Number.isFinite(secs) && secs > 0
              ? `Rate limited — try again in ${formatRetry(secs)}.`
              : 'Rate limited — please slow down.';
          throw new Error(msg);
        }
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`Server ${res.status}: ${body.slice(0, 120)}`);
        }
        const blob = await res.blob();
        triggerDownload(blob, `omb-${inscriptionId}-${m.key}-${TARGET_W}.png`);
        setOpen(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Download failed');
      } finally {
        setBusyKey(null);
      }
    },
    [busyKey, inscriptionId],
  );

  return (
    <div ref={rootRef} className={`relative ${className ?? ''}`}>
      <Tooltip content="Download print version">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="h-11 w-11 flex items-center justify-center text-bone-dim hover:text-bone transition-colors"
          aria-label="Download print version"
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <DownloadIcon />
        </button>
      </Tooltip>

      {open && (
        <div
          role="menu"
          aria-label="Download options"
          className="absolute right-0 top-full mt-1 z-20 w-64 bg-ink-1 border border-ink-2 font-mono text-xs tracking-[0.08em] uppercase text-bone-dim shadow-lg"
        >
          <ul>
            {METHODS.map(m => {
              const isBusy = busyKey === m.key;
              const disabled = busyKey !== null;
              return (
                <li key={m.key}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => onPick(m)}
                    disabled={disabled}
                    className="w-full text-left px-3 py-3 flex items-center justify-between gap-2 hover:bg-ink-2 hover:text-bone disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-bone-dim transition-colors"
                  >
                    <span className="flex flex-col">
                      <span className="text-bone normal-case tracking-wider">{m.label}</span>
                      <span className="text-[10px] text-bone-dim normal-case mt-0.5">
                        {m.hint}
                      </span>
                    </span>
                    <span className="text-bone-dim text-[10px]">{isBusy ? '…' : 'PNG'}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {error && (
            <div className="px-3 py-2 text-[10px] text-accent-red border-t border-ink-2 normal-case tracking-wider">
              {error}
            </div>
          )}
          <div className="px-3 py-2 text-[10px] text-bone-dim normal-case tracking-wider border-t border-ink-2 leading-relaxed">
            On-chain source is 336px JPEG. AI works great on some pieces,
            looks off on others — try both.
          </div>
        </div>
      )}
    </div>
  );
}

function formatRetry(sec: number): string {
  if (sec < 60) return `${Math.ceil(sec)}s`;
  return `${Math.ceil(sec / 60)}m`;
}

function DownloadIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2.5v8" />
      <path d="M4.5 7.5L8 11l3.5-3.5" />
      <path d="M3 13.5h10" />
    </svg>
  );
}
