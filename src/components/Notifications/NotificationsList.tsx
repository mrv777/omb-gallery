'use client';

import { useState } from 'react';
import Link from 'next/link';

type ClientSub = {
  id: number;
  kind: 'inscription' | 'color' | 'collection';
  targetKey: string;
  label: string;
  eventMask: number;
  status: 'active' | 'muted' | 'failed' | 'pending';
  unsubToken: string;
};

type Props = {
  hasSession: boolean;
  channel: 'telegram' | 'discord' | null;
  subs: ClientSub[];
};

function eventMaskLabel(mask: number): string {
  const bits: string[] = [];
  if (mask & 1) bits.push('transfers');
  if (mask & 2) bits.push('sales');
  return bits.length ? bits.join(' + ') : 'none';
}

function inscriptionHref(targetKey: string): string {
  return `/inscription/${targetKey}`;
}

function colorHref(targetKey: string): string {
  return `/?color=${encodeURIComponent(targetKey)}`;
}

export default function NotificationsList({ hasSession, channel, subs: initial }: Props) {
  const [subs, setSubs] = useState<ClientSub[]>(initial);
  const [pending, setPending] = useState<Set<number>>(new Set());

  const flip = async (id: number, next: 'active' | 'muted') => {
    setPending(p => new Set(p).add(id));
    try {
      const res = await fetch(`/api/subscriptions/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (res.ok) {
        setSubs(prev => prev.map(s => (s.id === id ? { ...s, status: next } : s)));
      }
    } finally {
      setPending(p => {
        const n = new Set(p);
        n.delete(id);
        return n;
      });
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
        Your {channel === 'telegram' ? 'Telegram' : 'Discord'} target has no subscriptions yet.{' '}
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
        Sending to · {channel === 'telegram' ? 'Telegram' : 'Discord'}
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
          return (
            <li
              key={s.id}
              className={`flex items-center justify-between gap-3 border border-ink-2 px-3 py-2 ${
                isMuted ? 'opacity-60' : ''
              }`}
            >
              <div className="min-w-0">
                <Link
                  href={detailHref}
                  className="block text-sm uppercase tracking-[0.06em] text-bone hover:underline truncate"
                >
                  {s.label}
                </Link>
                <p className="text-[11px] text-bone-dim normal-case tracking-normal">
                  {eventMaskLabel(s.eventMask)} · {s.status}
                  {isFailed && ' (delivery stopped — check the channel)'}
                </p>
              </div>
              <div className="shrink-0 flex gap-2">
                {s.status === 'active' && (
                  <button
                    type="button"
                    disabled={pending.has(s.id)}
                    onClick={() => flip(s.id, 'muted')}
                    className="h-8 px-3 text-[11px] uppercase tracking-[0.08em] text-bone-dim border border-ink-2 hover:text-bone hover:border-bone disabled:opacity-50"
                  >
                    Mute
                  </button>
                )}
                {(s.status === 'muted' || s.status === 'failed') && (
                  <button
                    type="button"
                    disabled={pending.has(s.id)}
                    onClick={() => flip(s.id, 'active')}
                    className="h-8 px-3 text-[11px] uppercase tracking-[0.08em] text-bone-dim border border-ink-2 hover:text-bone hover:border-bone disabled:opacity-50"
                  >
                    Unmute
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
