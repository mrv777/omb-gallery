'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

type Channel = 'telegram' | 'discord';
type Kind = 'inscription' | 'color' | 'collection';

type Props = {
  kind: Kind;
  targetKey: string;
  /** Optional override for the trigger button content. Defaults to a bell
   *  icon followed by "Watch <target>" in the verbose case (when callers
   *  supply no className override). When pinning into icon-row chrome,
   *  pass `<BellIcon />` directly. */
  label?: ReactNode;
  className?: string;
};

/** Outline bell icon. Matches the 16/1.25 stroke style used by the other
 *  icon-row buttons (info circle, close X). */
export function BellIcon({ className }: { className?: string }) {
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
      className={className}
    >
      <path d="M3.25 11.5h9.5l-1-1.75v-3a3.75 3.75 0 0 0-7.5 0v3z" />
      <path d="M6.5 11.75a1.5 1.5 0 0 0 3 0" />
    </svg>
  );
}

type SessionInfo = { hasSession: boolean; channels: Channel[] };

function withChannel(s: SessionInfo, c: Channel): SessionInfo {
  if (s.channels.includes(c)) return { hasSession: true, channels: s.channels };
  return { hasSession: true, channels: [...s.channels, c] };
}

type DialogState =
  | { kind: 'choose' }
  | { kind: 'tg-pending'; deepLink: string; claimToken: string }
  | { kind: 'discord-form' }
  | { kind: 'submitting' }
  | { kind: 'success'; channel: Channel }
  | { kind: 'error'; message: string };

const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let turnstileScriptPromise: Promise<void> | null = null;

// Turnstile API shape mirrors the global declared in ShareDialog. Don't
// re-declare globally here — declarations would conflict.
type TurnstileOptions = {
  sitekey: string;
  callback?: (token: string) => void;
  'error-callback'?: () => void;
  'expired-callback'?: () => void;
  theme?: 'light' | 'dark' | 'auto';
  size?: 'normal' | 'compact' | 'flexible' | 'invisible';
};

function loadTurnstile(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('ssr'));
  if (window.turnstile) return Promise.resolve();
  if (turnstileScriptPromise) return turnstileScriptPromise;
  turnstileScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SCRIPT}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('script')));
      return;
    }
    const s = document.createElement('script');
    s.src = TURNSTILE_SCRIPT;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => {
      turnstileScriptPromise = null;
      reject(new Error('script'));
    };
    document.head.appendChild(s);
  });
  return turnstileScriptPromise;
}

function describeTarget(kind: Kind, targetKey: string): string {
  if (kind === 'inscription') return `OMB #${targetKey}`;
  if (kind === 'color') return `${targetKey} OMBs`;
  return 'all OMB activity';
}

export default function NotificationButton({ kind, targetKey, label, className }: Props) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [state, setState] = useState<DialogState>({ kind: 'choose' });
  const [webhookUrl, setWebhookUrl] = useState('');
  const [tsToken, setTsToken] = useState('');
  const tsHost = useRef<HTMLDivElement | null>(null);
  const tsId = useRef<string | null>(null);
  const pollTimer = useRef<number | null>(null);

  // Fetch session state once on mount.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/me')
      .then(r => r.json())
      .then((j: { hasSession?: boolean; channels?: Channel[] }) => {
        if (cancelled) return;
        setSession({
          hasSession: !!j.hasSession,
          channels: Array.isArray(j.channels) ? j.channels : [],
        });
      })
      .catch(() => {
        if (!cancelled) setSession({ hasSession: false, channels: [] });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const cleanupPoll = useCallback(() => {
    if (pollTimer.current) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const cleanupTurnstile = useCallback(() => {
    if (tsId.current && window.turnstile) {
      try {
        window.turnstile.remove(tsId.current);
      } catch {
        /* ignore */
      }
      tsId.current = null;
    }
  }, []);

  const closeDialog = useCallback(() => {
    setOpen(false);
    setState({ kind: 'choose' });
    setWebhookUrl('');
    setTsToken('');
    cleanupPoll();
    cleanupTurnstile();
  }, [cleanupPoll, cleanupTurnstile]);

  const startTelegram = useCallback(async () => {
    setState({ kind: 'submitting' });
    try {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'telegram', kind, targetKey }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 429) {
        setState({ kind: 'error', message: 'Too many requests — wait a minute and try again.' });
        return;
      }
      if (!res.ok) {
        const msg =
          j?.error === 'not-configured'
            ? 'Telegram alerts aren’t available right now. Try Discord instead.'
            : j?.error === 'cap-exceeded'
              ? 'You already have the maximum number of watches (50). Mute one in /notifications first.'
              : (j?.error ?? `Failed (${res.status}).`);
        setState({ kind: 'error', message: msg });
        return;
      }
      if (j.status === 'active') {
        setState({ kind: 'success', channel: 'telegram' });
        return;
      }
      if (j.status === 'pending' && typeof j.deepLink === 'string') {
        window.open(j.deepLink, '_blank', 'noopener,noreferrer');
        setState({ kind: 'tg-pending', deepLink: j.deepLink, claimToken: j.claimToken });
        // Long-poll for the claim. 3s interval, 5min ceiling.
        let elapsed = 0;
        pollTimer.current = window.setInterval(async () => {
          elapsed += 3;
          if (elapsed > 300) {
            cleanupPoll();
            return;
          }
          try {
            const r = await fetch(`/api/subscribe/status?claim=${encodeURIComponent(j.claimToken)}`);
            if (r.status === 200) {
              const sj = (await r.json()) as { status?: string };
              if (sj.status === 'claimed') {
                cleanupPoll();
                setState({ kind: 'success', channel: 'telegram' });
                setSession(prev => withChannel(prev ?? { hasSession: false, channels: [] }, 'telegram'));
              }
            }
          } catch {
            /* ignore — next tick */
          }
        }, 3000);
        return;
      }
      setState({ kind: 'error', message: 'Unexpected response from server.' });
    } catch {
      setState({ kind: 'error', message: 'Network error. Try again.' });
    }
  }, [kind, targetKey, cleanupPoll]);

  const startDiscordForm = useCallback(() => {
    setState({ kind: 'discord-form' });
  }, []);

  const submitDiscord = useCallback(async () => {
    if (!webhookUrl.trim()) {
      setState({ kind: 'error', message: 'Paste a Discord webhook URL.' });
      return;
    }
    const hasDiscordSession = !!session?.channels.includes('discord');
    if (hasDiscordSession) {
      // Session reuse — no Turnstile needed.
    } else if (!tsToken) {
      setState({ kind: 'error', message: 'Complete the verification first.' });
      return;
    }
    setState({ kind: 'submitting' });
    try {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          channel: 'discord',
          kind,
          targetKey,
          webhookUrl: webhookUrl.trim(),
          turnstileToken: tsToken,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          j?.error === 'webhook-invalid' ? 'That Discord webhook URL looks wrong.' :
          j?.error === 'webhook-unreachable' ? 'Could not reach that webhook — is it deleted?' :
          j?.error === 'turnstile-failed' ? 'Verification failed — try again.' :
          j?.error === 'rate-limited' ? 'Too many requests — wait a minute.' :
          j?.error === 'cap-exceeded' ? 'This webhook already has the maximum number of watches (50).' :
          j?.error ?? `Failed (${res.status}).`;
        setState({ kind: 'error', message: msg });
        if (window.turnstile && tsId.current) window.turnstile.reset(tsId.current);
        setTsToken('');
        return;
      }
      setState({ kind: 'success', channel: 'discord' });
      setSession(prev => withChannel(prev ?? { hasSession: false, channels: [] }, 'discord'));
    } catch {
      setState({ kind: 'error', message: 'Network error. Try again.' });
    }
  }, [kind, targetKey, webhookUrl, tsToken, session]);

  // One-click for users with a matching session. `which` picks among the
  // channels in the cookie — when both are present the dialog renders two
  // distinct buttons and passes the chosen channel here.
  const oneClickSubscribe = useCallback(
    async (which: Channel) => {
      if (!session?.channels.includes(which)) return;
      setState({ kind: 'submitting' });
      try {
        const res = await fetch('/api/subscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ channel: which, kind, targetKey }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg =
            j?.error === 'cap-exceeded'
              ? 'You already have the maximum number of watches (50). Mute one in /notifications first.'
              : j?.error === 'rate-limited'
                ? 'Too many requests — wait a minute.'
                : (j?.error ?? `Failed (${res.status}).`);
          setState({ kind: 'error', message: msg });
          return;
        }
        setState({ kind: 'success', channel: which });
      } catch {
        setState({ kind: 'error', message: 'Network error. Try again.' });
      }
    },
    [session, kind, targetKey],
  );

  // Mount Turnstile widget when entering the discord-form state without a session.
  useEffect(() => {
    if (state.kind !== 'discord-form') return;
    if (session?.channels.includes('discord')) return; // session reuse — skip widget
    const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '';
    if (!siteKey) return;
    let cancelled = false;
    loadTurnstile()
      .then(() => {
        if (cancelled || !tsHost.current || !window.turnstile) return;
        const opts: TurnstileOptions = {
          sitekey: siteKey,
          size: 'flexible',
          theme: 'dark',
          callback: t => setTsToken(t),
          'error-callback': () => setTsToken(''),
          'expired-callback': () => setTsToken(''),
        };
        tsId.current = window.turnstile.render(tsHost.current, opts);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      cleanupTurnstile();
    };
  }, [state.kind, session, cleanupTurnstile]);

  // Esc closes the dialog.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDialog();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeDialog]);

  useEffect(() => () => cleanupPoll(), [cleanupPoll]);

  const desc = describeTarget(kind, targetKey);
  const buttonLabel: ReactNode = label ?? (
    <span className="inline-flex items-center gap-1.5">
      <BellIcon />
      <span>Watch {desc}</span>
    </span>
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Watch ${desc}`}
        title={`Watch ${desc}`}
        className={
          className ??
          'inline-flex items-center gap-1 px-3 h-9 text-xs uppercase tracking-[0.08em] text-bone border border-ink-2 hover:border-bone transition-colors'
        }
      >
        {buttonLabel}
      </button>
      {open && (
        <div
          className="fixed inset-0 z-[2000] bg-ink-0/80 backdrop-blur-sm flex items-center justify-center px-4"
          onClick={closeDialog}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Set up alerts"
            className="w-full max-w-md bg-ink-1 border border-ink-2 p-6 font-mono text-xs tracking-[0.08em] uppercase"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-bone">Watch · {desc}</h2>
              <button
                type="button"
                onClick={closeDialog}
                className="h-8 w-8 flex items-center justify-center text-bone-dim hover:text-bone"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {state.kind === 'choose' && (
              <>
                <p className="text-bone-dim normal-case tracking-normal mb-4">
                  {kind === 'collection'
                    ? 'Get a notification on every OMB sale. (Volume-conscious: transfers are off by default for collection-wide watches.)'
                    : `Get a notification whenever this ${kind} has a sale or transfer.`}
                </p>
                {session?.channels.includes('telegram') && (
                  <button
                    type="button"
                    onClick={() => oneClickSubscribe('telegram')}
                    className="w-full h-10 px-4 mb-2 text-bone border border-bone hover:bg-bone hover:text-ink-0 transition-colors"
                  >
                    Subscribe via Telegram (one click)
                  </button>
                )}
                {session?.channels.includes('discord') && (
                  <button
                    type="button"
                    onClick={() => oneClickSubscribe('discord')}
                    className="w-full h-10 px-4 mb-3 text-bone border border-bone hover:bg-bone hover:text-ink-0 transition-colors"
                  >
                    Subscribe via Discord (one click)
                  </button>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={startTelegram}
                    className="h-10 px-3 text-bone border border-ink-2 hover:border-bone transition-colors"
                  >
                    Telegram
                  </button>
                  <button
                    type="button"
                    onClick={startDiscordForm}
                    className="h-10 px-3 text-bone border border-ink-2 hover:border-bone transition-colors"
                  >
                    Discord
                  </button>
                </div>
                <p className="text-bone-dim normal-case tracking-normal mt-4 text-[11px]">
                  <a href="/notifications" className="underline hover:text-bone">
                    Manage your subscriptions
                  </a>
                </p>
              </>
            )}

            {state.kind === 'submitting' && (
              <p className="text-bone-dim normal-case tracking-normal">Working…</p>
            )}

            {state.kind === 'tg-pending' && (
              <>
                <p className="text-bone-dim normal-case tracking-normal mb-3">
                  Telegram should have opened. Tap <b>Start</b> in the chat with the bot.
                </p>
                <p className="text-bone-dim normal-case tracking-normal mb-4">
                  Didn&rsquo;t open?{' '}
                  <a
                    href={state.deepLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline text-bone"
                  >
                    Open the bot
                  </a>
                  .
                </p>
                <p className="text-bone-dim normal-case tracking-normal text-[11px]">
                  Waiting for confirmation…
                </p>
              </>
            )}

            {state.kind === 'discord-form' && (
              <>
                <p className="text-bone-dim normal-case tracking-normal mb-3">
                  Paste a Discord webhook URL. Create one in your server: Channel settings → Integrations → Webhooks.
                </p>
                <input
                  type="url"
                  value={webhookUrl}
                  onChange={e => setWebhookUrl(e.target.value)}
                  placeholder="https://discord.com/api/webhooks/…"
                  className="w-full bg-transparent border-0 border-b border-ink-2 focus:border-bone outline-none h-10 px-0 text-sm font-mono tracking-normal text-bone placeholder:text-bone-dim placeholder:normal-case mb-4"
                  spellCheck={false}
                />
                {!session?.channels.includes('discord') && (
                  <div ref={tsHost} className="mb-4 min-h-[65px]" />
                )}
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setState({ kind: 'choose' })}
                    className="h-10 px-3 text-bone-dim hover:text-bone"
                  >
                    back
                  </button>
                  <button
                    type="button"
                    onClick={submitDiscord}
                    className="h-10 px-4 text-bone border border-bone hover:bg-bone hover:text-ink-0 transition-colors"
                  >
                    subscribe
                  </button>
                </div>
              </>
            )}

            {state.kind === 'success' && (
              <>
                <p className="text-bone normal-case tracking-normal mb-4">
                  ✅ Subscribed. You&rsquo;ll get alerts via {state.channel === 'telegram' ? 'Telegram' : 'Discord'} for {desc}.
                </p>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={closeDialog}
                    className="h-10 px-3 text-bone-dim hover:text-bone"
                  >
                    done
                  </button>
                </div>
              </>
            )}

            {state.kind === 'error' && (
              <>
                <p className="text-accent-red normal-case tracking-normal mb-4">{state.message}</p>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setState({ kind: 'choose' })}
                    className="h-10 px-3 text-bone-dim hover:text-bone"
                  >
                    back
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
