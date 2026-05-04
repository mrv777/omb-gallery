'use client';

import { useCallback, useEffect, useState } from 'react';
import { triggerDownload } from '@/lib/upscale';
import { Tooltip } from '../ui/Tooltip';

interface DownloadButtonProps {
  src: string;
  inscriptionId: string;
  className?: string;
}

const TARGET_W = 1344;

export default function DownloadButton({ src, inscriptionId, className }: DownloadButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset transient state when the modal navigates to a different inscription.
  useEffect(() => {
    setBusy(false);
    setError(null);
  }, [src]);

  // Auto-clear the error toast after a few seconds — easier than adding a close button.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error]);

  const onClick = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({ id: inscriptionId });
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
      triggerDownload(blob, `omb-${inscriptionId}-${TARGET_W}.png`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setBusy(false);
    }
  }, [busy, inscriptionId]);

  const tooltip = busy ? 'Generating print version…' : 'Download print version (1344px)';

  return (
    <div className={`relative ${className ?? ''}`}>
      <Tooltip content={tooltip}>
        <button
          type="button"
          onClick={onClick}
          disabled={busy}
          className="h-11 w-11 flex items-center justify-center text-bone-dim hover:text-bone disabled:cursor-default disabled:hover:text-bone-dim transition-colors"
          aria-label={tooltip}
          aria-busy={busy}
        >
          {busy ? <Spinner /> : <DownloadIcon />}
        </button>
      </Tooltip>
      {error && (
        <div
          role="alert"
          className="absolute right-0 top-full mt-1 z-20 w-64 bg-ink-1 border border-accent-red px-3 py-2 font-mono text-[10px] tracking-wider normal-case text-accent-red shadow-lg"
        >
          {error}
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

function Spinner() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
      className="animate-spin"
    >
      <path d="M8 2.5v3" />
      <path d="M8 10.5v3" opacity="0.4" />
      <path d="M2.5 8h3" opacity="0.7" />
      <path d="M10.5 8h3" opacity="0.55" />
      <path d="M4.1 4.1l2.1 2.1" opacity="0.85" />
      <path d="M9.8 9.8l2.1 2.1" opacity="0.45" />
      <path d="M11.9 4.1l-2.1 2.1" opacity="0.6" />
      <path d="M6.2 9.8l-2.1 2.1" opacity="0.5" />
    </svg>
  );
}
