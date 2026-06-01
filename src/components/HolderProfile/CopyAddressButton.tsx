'use client';

import { useEffect, useRef, useState } from 'react';
import { Tooltip } from '../ui/Tooltip';

type CopyState = 'idle' | 'copying' | 'copied' | 'error';

type Props = {
  address: string;
  className?: string;
  compact?: boolean;
};

export default function CopyAddressButton({ address, className = '', compact = false }: Props) {
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const resetTimerRef = useRef<number | null>(null);
  const copyAttemptRef = useRef(0);
  const mountedRef = useRef(true);
  const sizeClass = compact ? 'h-5 w-5' : 'h-6 w-6';
  const stateClass =
    copyState === 'copied'
      ? 'border-accent-green/70 bg-accent-green/10 text-accent-green'
      : copyState === 'error'
        ? 'border-accent-red/70 bg-accent-red/10 text-accent-red'
        : copyState === 'copying'
          ? 'border-bone-dim text-bone'
          : 'border-ink-2 text-bone-dim hover:border-bone-dim hover:text-bone';

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resetTimerRef.current != null) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  async function copyAddress() {
    const attempt = copyAttemptRef.current + 1;
    copyAttemptRef.current = attempt;
    if (resetTimerRef.current != null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    setCopyState('copying');

    try {
      await copyText(address);
      if (!mountedRef.current || copyAttemptRef.current !== attempt) return;
      setCopyState('copied');
      resetTimerRef.current = window.setTimeout(() => setCopyState('idle'), 1600);
    } catch {
      if (!mountedRef.current || copyAttemptRef.current !== attempt) return;
      setCopyState('error');
      resetTimerRef.current = window.setTimeout(() => setCopyState('idle'), 2200);
    }
  }

  return (
    <Tooltip
      content={
        copyState === 'copied'
          ? 'Copied address'
          : copyState === 'error'
            ? 'Copy failed'
            : copyState === 'copying'
              ? 'Copying address'
              : 'Copy address'
      }
    >
      <button
        type="button"
        onClick={copyAddress}
        aria-label="Copy full address"
        className={`inline-flex ${sizeClass} shrink-0 items-center justify-center border transition-colors ${stateClass} ${className}`}
      >
        {copyState === 'copied' ? (
          <CheckIcon />
        ) : copyState === 'error' ? (
          <XIcon />
        ) : (
          <ClipboardIcon />
        )}
        <span aria-live="polite" className="sr-only">
          {copyState === 'copied'
            ? 'Address copied'
            : copyState === 'error'
              ? 'Address copy failed'
              : ''}
        </span>
      </button>
    </Tooltip>
  );
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the legacy copy path when browser permissions block
      // async clipboard writes.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();

  try {
    if (!document.execCommand('copy')) {
      throw new Error('copy command failed');
    }
  } finally {
    document.body.removeChild(textarea);
  }
}

function ClipboardIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="11" height="11" rx="1.5" />
      <path d="M5 15H4a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 4 3h9a1.5 1.5 0 0 1 1.5 1.5v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}
