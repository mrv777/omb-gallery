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

type DiscordWebhookSummary = { id: string; tokenSuffix: string };

type SessionInfo = {
  hasSession: boolean;
  channels: Channel[];
  discordWebhooks: DiscordWebhookSummary[];
};

function withChannel(s: SessionInfo, c: Channel): SessionInfo {
  if (s.channels.includes(c)) return { ...s, hasSession: true };
  return { ...s, hasSession: true, channels: [...s.channels, c] };
}

function withDiscordWebhook(s: SessionInfo, w: DiscordWebhookSummary): SessionInfo {
  if (s.discordWebhooks.some(x => x.id === w.id)) return s;
  return { ...s, discordWebhooks: [...s.discordWebhooks, w] };
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
      .then((j: {
        hasSession?: boolean;
        channels?: Channel[];
        discordWebhooks?: DiscordWebhookSummary[];
      }) => {
        if (cancelled) return;
        setSession({
          hasSession: !!j.hasSession,
          channels: Array.isArray(j.channels) ? j.channels : [],
          discordWebhooks: Array.isArray(j.discordWebhooks) ? j.discordWebhooks : [],
        });
      })
      .catch(() => {
        if (!cancelled) setSession({ hasSession: false, channels: [], discordWebhooks: [] });
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
                setSession(prev =>
                  withChannel(
                    prev ?? { hasSession: false, channels: [], discordWebhooks: [] },
                    'telegram',
                  ),
                );
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
    const trimmed = webhookUrl.trim();
    if (!trimmed) {
      setState({ kind: 'error', message: 'Paste a Discord webhook URL.' });
      return;
    }
    // Detect URL re-paste of a webhook whose id is already bound. When that
    // happens we want to reuse the existing binding (same fast path as the
    // picker buttons): send `discordWebhookId` so the server resolves to the
    // STORED URL — not the just-typed one. Critical for token-rotation /
    // trailing-slash cases where the typed URL no longer matches the cookie's
    // exactly: server-side findBinding() does an exact match and would fall
    // through to the onboarding flow demanding a Turnstile token we
    // deliberately didn't collect.
    const webhookIdMatch = /\/api\/webhooks\/(\d{10,25})\//.exec(trimmed);
    const isAlreadyBound = !!(
      webhookIdMatch && session?.discordWebhooks.some(w => w.id === webhookIdMatch[1])
    );
    if (!isAlreadyBound && !tsToken) {
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
          ...(isAlreadyBound && webhookIdMatch
            ? { discordWebhookId: webhookIdMatch[1] }
            : { webhookUrl: trimmed, turnstileToken: tsToken }),
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
      setSession(prev => {
        const base = prev ?? { hasSession: false, channels: [], discordWebhooks: [] };
        let next = withChannel(base, 'discord');
        if (webhookIdMatch) {
          // Append the new webhook id to local state so subsequent dialogs
          // pick it up without a /api/me round-trip. tokenSuffix matches the
          // server's mask (last 4 of token).
          const tokenSuffix = trimmed.split('/').pop()?.slice(-4) ?? '';
          next = withDiscordWebhook(next, { id: webhookIdMatch[1], tokenSuffix });
        }
        return next;
      });
    } catch {
      setState({ kind: 'error', message: 'Network error. Try again.' });
    }
  }, [kind, targetKey, webhookUrl, tsToken, session]);

  // One-click for users with a matching session. `which` picks among the
  // channels in the cookie. For Discord, when multiple webhooks are bound,
  // `discordWebhookId` selects which one — without it the server falls back
  // to legacy first-binding behaviour (fine for legacy/single-webhook users).
  const oneClickSubscribe = useCallback(
    async (which: Channel, discordWebhookId?: string) => {
      if (!session?.channels.includes(which)) return;
      setState({ kind: 'submitting' });
      try {
        const res = await fetch('/api/subscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            channel: which,
            kind,
            targetKey,
            ...(discordWebhookId ? { discordWebhookId } : {}),
          }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg =
            j?.error === 'cap-exceeded'
              ? 'You already have the maximum number of watches (50). Mute one in /notifications first.'
              : j?.error === 'rate-limited'
                ? 'Too many requests — wait a minute.'
                : j?.error === 'webhook-not-bound'
                  ? 'That webhook is no longer in this browser. Reload the page.'
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

  // Decide whether the URL the user's currently typing is one we already
  // hold a binding for. When true, the server fast-paths and Turnstile is
  // unnecessary; when false (a brand-new webhook), we need the widget.
  const typedWebhookId = (() => {
    const m = /\/api\/webhooks\/(\d{10,25})\//.exec(webhookUrl.trim());
    return m ? m[1] : null;
  })();
  const typedIsAlreadyBound = !!(
    typedWebhookId && session?.discordWebhooks.some(w => w.id === typedWebhookId)
  );

  // Mount Turnstile when the user appears to be entering a NEW webhook URL.
  // For an already-bound URL (re-paste or "use existing" path), the server
  // skips Turnstile so we skip the widget too. We also re-evaluate as the
  // user types — paste-of-existing should immediately hide the widget.
  useEffect(() => {
    if (state.kind !== 'discord-form') return;
    if (typedIsAlreadyBound) return;
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
  }, [state.kind, typedIsAlreadyBound, cleanupTurnstile]);

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
                {/* One button per bound Discord webhook. With multiple webhooks
                 *  we send discordWebhookId so the server picks the right one;
                 *  with zero/one we let the server fall back to its default. */}
                {(session?.discordWebhooks ?? []).map(w => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => oneClickSubscribe('discord', w.id)}
                    className="w-full h-10 px-4 mb-2 text-bone border border-bone hover:bg-bone hover:text-ink-0 transition-colors normal-case tracking-normal"
                  >
                    <span className="uppercase tracking-[0.08em]">Subscribe via Discord</span>
                    <span className="text-bone-dim ml-2">webhook …{w.tokenSuffix}</span>
                  </button>
                ))}
                {/* Legacy session (v1 cookie) — channels has 'discord' but the
                 *  webhook URL didn't parse, so no per-webhook button rendered.
                 *  Surface a generic one-click for back-compat. */}
                {session?.channels.includes('discord') &&
                  (session?.discordWebhooks.length ?? 0) === 0 && (
                    <button
                      type="button"
                      onClick={() => oneClickSubscribe('discord')}
                      className="w-full h-10 px-4 mb-2 text-bone border border-bone hover:bg-bone hover:text-ink-0 transition-colors"
                    >
                      Subscribe via Discord (one click)
                    </button>
                  )}
                <div className="grid grid-cols-2 gap-2 mt-1">
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
                    {session?.channels.includes('discord')
                      ? 'Add Discord webhook'
                      : 'Discord'}
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
                {typedIsAlreadyBound ? (
                  <p className="text-bone-dim normal-case tracking-normal text-[11px] mb-4">
                    Already linked in this browser — no verification needed.
                  </p>
                ) : (
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
