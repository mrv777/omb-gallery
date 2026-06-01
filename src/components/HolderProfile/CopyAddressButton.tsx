'use client';

import { useState } from 'react';
import { Tooltip } from '../ui/Tooltip';

type CopyState = 'idle' | 'copied' | 'error';

type Props = {
  address: string;
  className?: string;
  compact?: boolean;
};

export default function CopyAddressButton({ address, className = '', compact = false }: Props) {
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const sizeClass = compact ? 'h-5 w-5' : 'h-6 w-6';

  async function copyAddress() {
    try {
      await copyText(address);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 1400);
    } catch {
      setCopyState('error');
      window.setTimeout(() => setCopyState('idle'), 1800);
    }
  }

  return (
    <Tooltip
      content={
        copyState === 'copied'
          ? 'Copied address'
          : copyState === 'error'
            ? 'Copy failed'
            : 'Copy address'
      }
    >
      <button
        type="button"
        onClick={copyAddress}
        aria-label="Copy full address"
        className={`inline-flex ${sizeClass} shrink-0 items-center justify-center border border-ink-2 text-bone-dim hover:border-bone-dim hover:text-bone ${className}`}
      >
        <ClipboardIcon />
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
