"use client";

import { useCallback, useEffect, useRef, useState } from 'react';

type TurnstileOptions = {
  sitekey: string;
  callback?: (token: string) => void;
  'error-callback'?: () => void;
  'expired-callback'?: () => void;
  theme?: 'light' | 'dark' | 'auto';
  size?: 'normal' | 'compact' | 'flexible' | 'invisible';
  appearance?: 'always' | 'execute' | 'interaction-only';
  execution?: 'render' | 'execute';
  action?: string;
};

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement | string, options: TurnstileOptions) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId: string) => void;
      getResponse: (widgetId?: string) => string | undefined;
      execute: (widgetId?: string | HTMLElement) => void;
    };
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let scriptPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('ssr'));
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('turnstile-script')));
      return;
    }
    const s = document.createElement('script');
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => {
      scriptPromise = null;
      reject(new Error('turnstile-script'));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

type State =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; slug: string }
  | { kind: 'error'; message: string };

type Props = {
  ids: string[];
  defaultTitle: string;
  onClose: () => void;
};

export default function ShareDialog({ ids, defaultTitle, onClose }: Props) {
  const [title, setTitle] = useState(defaultTitle);
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [token, setToken] = useState<string>('');
  const [copyFlash, setCopyFlash] = useState(false);
  const widgetHost = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | null>(null);

  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '';

  useEffect(() => {
    if (!siteKey) return;
    let cancelled = false;
    loadTurnstileScript()
      .then(() => {
        if (cancelled || !widgetHost.current || !window.turnstile) return;
        widgetId.current = window.turnstile.render(widgetHost.current, {
          sitekey: siteKey,
          size: 'flexible',
          theme: 'dark',
          callback: (t) => setToken(t),
          'error-callback': () => setToken(''),
          'expired-callback': () => setToken(''),
        });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error', message: 'Could not load verification.' });
      });
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) {
        window.turnstile.remove(widgetId.current);
        widgetId.current = null;
      }
    };
  }, [siteKey]);

  const shareUrl = state.kind === 'success' ? `${window.location.origin}/slideshow/${state.slug}` : '';

  const submit = useCallback(async () => {
    if (state.kind === 'submitting') return;
    if (!token) {
      setState({ kind: 'error', message: 'Please complete the verification above.' });
      return;
    }
    setState({ kind: 'submitting' });
    try {
      const res = await fetch('/api/slideshow', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids, title: title.trim() || null, turnstileToken: token }),
      });
      if (res.status === 429) {
        const retryAfter = res.headers.get('retry-after');
        const parsed = retryAfter ? Number(retryAfter) : NaN;
        const secs = Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
        setState({
          kind: 'error',
          message: `Too many shares. Try again in ${Math.max(1, Math.ceil(secs))}s.`,
        });
        return;
      }
      if (res.status === 403) {
        setState({ kind: 'error', message: 'Verification failed — please try again.' });
        if (widgetId.current) window.turnstile?.reset(widgetId.current);
        setToken('');
        return;
      }
      if (!res.ok) {
        setState({ kind: 'error', message: `Couldn't create link (${res.status}).` });
        return;
      }
      const data = (await res.json()) as { slug?: string };
      if (!data.slug) {
        setState({ kind: 'error', message: 'Server returned no slug.' });
        return;
      }
      setState({ kind: 'success', slug: data.slug });
    } catch {
      setState({ kind: 'error', message: 'Network error. Please try again.' });
    }
  }, [ids, title, token, state.kind]);

  const copyLink = useCallback(async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopyFlash(true);
      window.setTimeout(() => setCopyFlash(false), 1500);
    } catch {
      // no-op
    }
  }, [shareUrl]);

  // Close on Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[2000] bg-ink-0/80 backdrop-blur-sm flex items-center justify-center px-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Share slideshow"
        className="w-full max-w-md bg-ink-1 border border-ink-2 p-6 font-mono text-xs tracking-[0.08em] uppercase"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-bone">Share slideshow</h2>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 flex items-center justify-center text-bone-dim hover:text-bone transition-colors"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {state.kind !== 'success' ? (
          <>
            <label className="block text-bone-dim mb-2" htmlFor="slideshow-title">
              Title <span className="normal-case tracking-normal">(optional)</span>
            </label>
            <input
              id="slideshow-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={60}
              placeholder="my favorite reds"
              className="w-full bg-transparent border-0 border-b border-ink-2 focus:border-bone outline-none h-10 px-0 text-sm font-mono tracking-[0.06em] text-bone placeholder:text-bone-dim placeholder:normal-case placeholder:tracking-[0.04em] mb-4"
              spellCheck={false}
            />

            <p className="text-bone-dim mb-3 normal-case tracking-normal">
              {ids.length} image{ids.length === 1 ? '' : 's'} will be frozen into the shared link.
            </p>

            <div ref={widgetHost} className="mb-4 min-h-[65px]" />
            {!siteKey && (
              <p className="text-accent-red mb-3 normal-case tracking-normal">
                Verification is not configured (NEXT_PUBLIC_TURNSTILE_SITE_KEY missing).
              </p>
            )}

            {state.kind === 'error' && (
              <p className="text-accent-red mb-3 normal-case tracking-normal">{state.message}</p>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="h-10 px-3 text-bone-dim hover:text-bone transition-colors"
              >
                cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={!siteKey || !token || state.kind === 'submitting'}
                className="h-10 px-4 text-bone border border-bone hover:bg-bone hover:text-ink-0 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-bone"
              >
                {state.kind === 'submitting' ? 'creating…' : 'generate link'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-bone-dim mb-2 normal-case tracking-normal">Share this link:</p>
            <div className="flex items-center gap-2 mb-4">
              <input
                readOnly
                value={shareUrl}
                onClick={(e) => e.currentTarget.select()}
                className="flex-1 bg-ink-0 border border-ink-2 h-10 px-2 text-sm font-mono tracking-normal text-bone"
              />
              <button
                type="button"
                onClick={copyLink}
                className="h-10 px-3 text-bone border border-bone hover:bg-bone hover:text-ink-0 transition-colors"
              >
                {copyFlash ? 'copied' : 'copy'}
              </button>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="h-10 px-3 text-bone-dim hover:text-bone transition-colors"
              >
                done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
