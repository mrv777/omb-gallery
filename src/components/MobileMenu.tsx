'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { createPortal } from 'react-dom';
import { HelpDialog } from './HelpButton';
import { useColorFilter } from '@/lib/useColorFilter';
import { appendColorParam } from '@/lib/colorFilter';
import { NAV_ITEMS, type NavKey } from '@/lib/nav';
import { useDonation } from './Donation/DonationProvider';

export default function MobileMenu({ active }: { active?: NavKey } = {}) {
  const [open, setOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { color } = useColorFilter();
  const { openDonation } = useDonation();

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const close = () => setOpen(false);

  const sheet = open ? (
    <div className="fixed inset-0 z-[1400] nav-full:hidden" onClick={close} role="presentation">
      <div className="absolute inset-0 bg-ink-0/70 backdrop-blur-sm" />
      <div
        role="menu"
        aria-label="Site navigation"
        className="absolute top-0 left-0 right-0 bg-ink-1 border-b border-ink-2 pt-12 pb-2 font-mono text-xs tracking-[0.12em] uppercase"
        onClick={e => e.stopPropagation()}
      >
        {NAV_ITEMS.map((item, i) => {
          const isActive = item.key === active;
          // Mirror the desktop tier divider so the sheet tells the same story:
          // the OMB app proper, then adjacent surfaces.
          const startsSecondary = item.tier === 'secondary' && NAV_ITEMS[i - 1]?.tier === 'primary';
          return (
            <Link
              key={item.key}
              href={appendColorParam(item.href, color)}
              role="menuitem"
              onClick={close}
              className={`flex items-center h-12 px-5 transition-colors ${
                startsSecondary ? 'border-t border-ink-2 mt-1 pt-1' : ''
              } ${isActive ? 'text-bone' : 'text-bone-dim hover:text-bone'}`}
            >
              <span
                className={`border px-1.5 py-0.5 ${
                  isActive ? 'border-bone' : 'border-transparent'
                }`}
              >
                {item.label}
              </span>
            </Link>
          );
        })}
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setOpen(false);
            openDonation(triggerRef.current);
          }}
          className="flex h-12 w-full items-center px-5 text-bone-dim transition-colors hover:text-bone"
        >
          <span className="border border-transparent px-1.5 py-0.5">support</span>
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setOpen(false);
            setHelpOpen(true);
          }}
          className="flex items-center w-full h-12 px-5 text-bone-dim hover:text-bone transition-colors"
        >
          <span className="border border-transparent px-1.5 py-0.5">help</span>
        </button>
      </div>
    </div>
  ) : null;

  // The trigger is visible below `nav-full`, not below `lg`: between those two
  // desktop nav shows only its primary tier, so this sheet is where history /
  // bravocados / info still live. It repeats the primary items too — harmless,
  // and cheaper than maintaining a second overflow-only menu.
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(v => !v)}
        className="nav-full:hidden h-10 w-10 flex items-center justify-center text-bone-dim hover:text-bone transition-colors shrink-0"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span aria-hidden="true" className="text-lg leading-none">
          {open ? '✕' : '☰'}
        </span>
      </button>

      {mounted && sheet ? createPortal(sheet, document.body) : null}

      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </>
  );
}
