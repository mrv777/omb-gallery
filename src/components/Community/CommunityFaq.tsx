'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const FAQ_ITEMS = [
  {
    question: 'What am I getting?',
    answer:
      'You first reserve some of 100 fixed units. If the purchase completes, each unit represents 1% of the agreed proceeds when the OMB is sold.',
  },
  {
    question: 'Is everything on Bitcoin?',
    answer:
      'The OMB and the rules for moving it are on Bitcoin. Reservations, progress, the public owner list, and private invitation links are coordinated by the gallery.',
  },
  {
    question: 'What does 69 of 100 mean?',
    answer:
      'Bitcoin requires valid signatures for at least 69 ownership units before the OMB can move. One person signs once in Drey for all of their units, so this does not mean 69 different people.',
  },
  {
    question: 'Does reserving move or lock my BTC?',
    answer:
      'No. Reserving only saves your place and maximum. BTC moves only after the group fills and you approve the exact purchase in Drey.',
  },
  {
    question: 'How much can one person have?',
    answer:
      'Most owners can have up to 20 units. An anchored creator has exactly 33 units and must approve every move.',
  },
  {
    question: 'Can I transfer my position?',
    answer:
      'Most owners can privately transfer their entire position to one new owner. Units cannot be split, traded one by one, or merged; an anchored creator position stays fixed.',
  },
  {
    question: 'Who has the keys, and how does recovery work?',
    answer:
      'Each owner has an independent key in Drey. The gallery and Drey have no master vault key. Drey requires a verified backup; keep it safe with separate estate instructions.',
  },
  {
    question: 'What is the main risk?',
    answer:
      'A malicious group controlling 69 units could move the OMB without guaranteeing payment to the other owners. Bitcoin enforces the signatures, not a fair payout to the minority.',
  },
] as const;

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])';

export default function CommunityFaq() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown, { capture: true });
    };
  }, [close, open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="mt-4 font-mono text-[10px] uppercase tracking-[0.1em] text-bone underline decoration-ink-2 underline-offset-4 hover:decoration-bone"
      >
        How group buys work
      </button>
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[2100] flex items-start justify-center overflow-y-auto bg-ink-0/85 px-4 py-5 backdrop-blur-sm sm:items-center sm:px-6 sm:py-8"
            onMouseDown={event => {
              if (event.target === event.currentTarget) close();
            }}
          >
            <div
              ref={dialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="community-faq-title"
              aria-describedby="community-faq-description"
              tabIndex={-1}
              className="w-full max-w-2xl border border-ink-2 bg-ink-1 p-5 shadow-[0_20px_60px_rgba(0,0,0,0.85)] outline-none sm:p-7"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-accent-green">
                    Plain-language guide
                  </div>
                  <h2
                    id="community-faq-title"
                    className="mt-2 font-mono text-lg uppercase tracking-[0.08em] text-bone sm:text-xl"
                  >
                    How group buys work
                  </h2>
                  <p
                    id="community-faq-description"
                    className="mt-2 max-w-xl text-xs leading-relaxed text-bone-dim"
                  >
                    The short answers to the questions most people ask first.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={close}
                  aria-label="Close group buy guide"
                  className="flex h-8 w-8 shrink-0 items-center justify-center text-bone-dim transition-colors hover:text-bone"
                >
                  ✕
                </button>
              </div>

              <div className="mt-6 divide-y divide-ink-2 border-y border-ink-2">
                {FAQ_ITEMS.map((item, index) => (
                  <details key={item.question} className="group" open={index === 0}>
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 font-mono text-[10px] uppercase tracking-[0.08em] text-bone marker:content-none">
                      {item.question}
                      <span
                        aria-hidden="true"
                        className="text-base font-normal text-bone-dim transition-transform group-open:rotate-45"
                      >
                        +
                      </span>
                    </summary>
                    <p className="max-w-xl pb-4 pr-8 text-xs leading-relaxed text-bone-dim">
                      {item.answer}
                    </p>
                  </details>
                ))}
              </div>

              <p className="mt-5 text-[10px] leading-relaxed text-bone-dim">
                Each active group-buy page shows its exact owners, rules, and current status before
                anyone signs.
              </p>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
