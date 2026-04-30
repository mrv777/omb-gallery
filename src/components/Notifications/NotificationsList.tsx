'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

type ClientSub = {
  id: number;
  channel: 'telegram' | 'discord';
  kind: 'inscription' | 'color' | 'collection';
  targetKey: string;
  label: string;
  eventMask: number;
  status: 'active' | 'muted' | 'failed' | 'pending';
  unsubToken: string;
};

type Props = {
  hasSession: boolean;
  channels: ('telegram' | 'discord')[];
  subs: ClientSub[];
};

const MASK_TRANSFERRED = 1;
const MASK_SOLD = 2;
const MASK_LISTED = 4;

function eventMaskLabel(mask: number): string {
  const bits: string[] = [];
  if (mask & MASK_TRANSFERRED) bits.push('transfers');
  if (mask & MASK_SOLD) bits.push('sales');
  if (mask & MASK_LISTED) bits.push('listings');
  return bits.length ? bits.join(' + ') : 'none';
}

function inscriptionHref(targetKey: string): string {
  return `/inscription/${targetKey}`;
}

function colorHref(targetKey: string): string {
  return `/?color=${encodeURIComponent(targetKey)}`;
}

const CHANNEL_LABEL: Record<ClientSub['channel'], string> = {
  telegram: 'TELEGRAM',
  discord: 'DISCORD',
};

const CONFIRM_TIMEOUT_MS = 5000;

export default function NotificationsList({ hasSession, channels, subs: initial }: Props) {
  const [subs, setSubs] = useState<ClientSub[]>(initial);
  const [pending, setPending] = useState<Set<number>>(new Set());
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-cancel pending Remove confirmation after 5s of inactivity. Esc also
  // dismisses. Keeps the destructive button from staying primed indefinitely.
  useEffect(() => {
    if (confirmingId == null) return;
    confirmTimerRef.current = setTimeout(() => setConfirmingId(null), CONFIRM_TIMEOUT_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConfirmingId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      window.removeEventListener('keydown', onKey);
    };
  }, [confirmingId]);

  const markPending = (id: number, on: boolean) => {
    setPending(p => {
      const n = new Set(p);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  };

  const flipStatus = async (id: number, next: 'active' | 'muted') => {
    markPending(id, true);
    try {
      const res = await fetch(`/api/subscriptions/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (res.ok) setSubs(prev => prev.map(s => (s.id === id ? { ...s, status: next } : s)));
    } finally {
      markPending(id, false);
    }
  };

  const toggleMaskBit = async (id: number, bit: number) => {
    const sub = subs.find(s => s.id === id);
    if (!sub) return;
    const next = sub.eventMask ^ bit;
    if ((next & (MASK_TRANSFERRED | MASK_SOLD | MASK_LISTED)) === 0) {
      // Disallow turning off the last bit — the server would reject it anyway,
      // and a watch with no events is just a soft-deleted row. Tell the user
      // to use Remove instead.
      return;
    }
    markPending(id, true);
    // Optimistic update; revert on error.
    setSubs(prev => prev.map(s => (s.id === id ? { ...s, eventMask: next } : s)));
    try {
      const res = await fetch(`/api/subscriptions/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventMask: next }),
      });
      if (!res.ok) {
        setSubs(prev => prev.map(s => (s.id === id ? { ...s, eventMask: sub.eventMask } : s)));
      }
    } catch {
      setSubs(prev => prev.map(s => (s.id === id ? { ...s, eventMask: sub.eventMask } : s)));
    } finally {
      markPending(id, false);
    }
  };

  const remove = async (id: number) => {
    markPending(id, true);
    try {
      const res = await fetch(`/api/subscriptions/${id}`, { method: 'DELETE' });
      if (res.ok) setSubs(prev => prev.filter(s => s.id !== id));
    } finally {
      markPending(id, false);
      setConfirmingId(null);
    }
  };

  if (!hasSession) {
    return (
      <div className="font-mono text-xs uppercase tracking-[0.08em]">
        <p className="text-bone-dim normal-case tracking-normal mb-4">
          You don&rsquo;t have any active subscriptions on this browser.
        </p>
        <p className="text-bone-dim normal-case tracking-normal">
          Set up a watch from any{' '}
          <Link href="/" className="underline text-bone">
            inscription page
          </Link>
          , or pick a color and add &ldquo;Get alerts&rdquo;.
        </p>
      </div>
    );
  }

  if (subs.length === 0) {
    return (
      <p className="text-bone-dim normal-case tracking-normal font-mono">
        No subscriptions on this browser yet.{' '}
        <Link href="/" className="underline text-bone">
          Add one
        </Link>
        .
      </p>
    );
  }

  return (
    <div className="font-mono">
      <p className="text-[11px] text-bone-dim uppercase tracking-[0.08em] mb-4">
        Sending to ·{' '}
        {channels.length === 0
          ? '—'
          : channels.map(c => CHANNEL_LABEL[c]).join(' + ')}
      </p>
      <ul className="space-y-2">
        {subs.map(s => {
          const detailHref =
            s.kind === 'inscription'
              ? inscriptionHref(s.targetKey)
              : s.kind === 'color'
                ? colorHref(s.targetKey)
                : '/activity';
          const isMuted = s.status !== 'active';
          const isFailed = s.status === 'failed';
          const isPending = pending.has(s.id);
          const isConfirming = confirmingId === s.id;
          return (
            <li
              key={s.id}
              className={`border px-3 py-2 ${
                isConfirming
                  ? 'border-accent-red opacity-80'
                  : isMuted
                    ? 'border-ink-2 opacity-60'
                    : 'border-ink-2'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] tracking-[0.1em] text-bone-dim border border-ink-2 px-1.5 py-0.5">
                      {CHANNEL_LABEL[s.channel]}
                    </span>
                    <Link
                      href={detailHref}
                      className="text-sm uppercase tracking-[0.06em] text-bone hover:underline truncate"
                    >
                      {s.label}
                    </Link>
                  </div>
                  <p className="text-[11px] text-bone-dim normal-case tracking-normal mt-1">
                    {eventMaskLabel(s.eventMask)} · {s.status}
                    {isFailed && ' (delivery stopped — check the channel)'}
                  </p>
                </div>
                <div className="shrink-0 flex gap-2">
                  {!isConfirming && s.status === 'active' && (
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => flipStatus(s.id, 'muted')}
                      className="h-8 px-3 text-[11px] uppercase tracking-[0.08em] text-bone-dim border border-ink-2 hover:text-bone hover:border-bone disabled:opacity-50"
                    >
                      Mute
                    </button>
                  )}
                  {!isConfirming && (s.status === 'muted' || s.status === 'failed') && (
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => flipStatus(s.id, 'active')}
                      className="h-8 px-3 text-[11px] uppercase tracking-[0.08em] text-bone-dim border border-ink-2 hover:text-bone hover:border-bone disabled:opacity-50"
                    >
                      Unmute
                    </button>
                  )}
                  {!isConfirming && (
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => setConfirmingId(s.id)}
                      className="h-8 px-3 text-[11px] uppercase tracking-[0.08em] text-bone-dim border border-ink-2 hover:text-accent-red hover:border-accent-red disabled:opacity-50"
                    >
                      Remove
                    </button>
                  )}
                  {isConfirming && (
                    <>
                      <span className="self-center text-[11px] uppercase tracking-[0.08em] text-accent-red mr-1">
                        Stop watching?
                      </span>
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => remove(s.id)}
                        className="h-8 px-3 text-[11px] uppercase tracking-[0.08em] text-accent-red border border-accent-red hover:bg-accent-red hover:text-ink-0 disabled:opacity-50"
                      >
                        Yes
                      </button>
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => setConfirmingId(null)}
                        className="h-8 px-3 text-[11px] uppercase tracking-[0.08em] text-bone-dim border border-ink-2 hover:text-bone hover:border-bone disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 pt-2 border-t border-ink-2">
                <MaskCheckbox
                  label="Transfers"
                  bit={MASK_TRANSFERRED}
                  mask={s.eventMask}
                  disabled={isPending || isMuted}
                  onToggle={() => toggleMaskBit(s.id, MASK_TRANSFERRED)}
                />
                <MaskCheckbox
                  label="Sales"
                  bit={MASK_SOLD}
                  mask={s.eventMask}
                  disabled={isPending || isMuted}
                  onToggle={() => toggleMaskBit(s.id, MASK_SOLD)}
                />
                <MaskCheckbox
                  label="Listings"
                  bit={MASK_LISTED}
                  mask={s.eventMask}
                  disabled={isPending || isMuted}
                  onToggle={() => toggleMaskBit(s.id, MASK_LISTED)}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function MaskCheckbox({
  label,
  bit,
  mask,
  disabled,
  onToggle,
}: {
  label: string;
  bit: number;
  mask: number;
  disabled: boolean;
  onToggle: () => void;
}) {
  const checked = (mask & bit) !== 0;
  return (
    <label
      className={`inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.08em] select-none ${
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
      } ${checked ? 'text-bone' : 'text-bone-dim'}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
        className="h-3 w-3 accent-bone"
      />
      {label}
    </label>
  );
}
