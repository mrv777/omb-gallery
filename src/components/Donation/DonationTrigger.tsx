'use client';

import { useRef } from 'react';
import { Tooltip } from '@/components/ui/Tooltip';
import { useDonation } from './DonationProvider';

export default function DonationTrigger({
  variant,
  className = '',
}: {
  variant: 'header' | 'footer';
  className?: string;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { openDonation } = useDonation();
  const button =
    variant === 'header' ? (
      <button
        ref={buttonRef}
        type="button"
        onClick={() => openDonation(buttonRef.current)}
        className={`flex h-10 w-10 items-center justify-center font-mono text-base leading-none text-bone-dim transition-colors hover:text-bone ${className}`}
        aria-label="Support the site"
      >
        ₿
      </button>
    ) : (
      <button
        ref={buttonRef}
        type="button"
        onClick={() => openDonation(buttonRef.current)}
        className={`inline-flex h-8 items-center border border-bone-dim/60 px-3 text-[11px] text-bone transition-colors hover:border-bone hover:bg-bone hover:text-ink-0 ${className}`}
      >
        support the site
      </button>
    );

  if (variant === 'footer') return button;
  return <Tooltip content="Support the site">{button}</Tooltip>;
}
