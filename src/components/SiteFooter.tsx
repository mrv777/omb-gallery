'use client';

import FirehoseSubscribe from './FirehoseSubscribe';
import DonationTrigger from './Donation/DonationTrigger';

export default function SiteFooter({ className = '' }: { className?: string }) {
  return (
    <footer
      className={`border-t border-ink-2 px-4 py-8 font-mono text-[10px] uppercase tracking-[0.08em] text-bone-dim sm:px-6 ${className}`}
    >
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <span className="normal-case tracking-normal">
          Help keep the archive indexed, hosted, and evolving.
        </span>
        <DonationTrigger variant="footer" />
      </div>
      <div className="mb-4">
        <FirehoseSubscribe />
      </div>
      on-chain data via ord · marketplace data via{' '}
      <a
        href="https://www.satflow.com"
        target="_blank"
        rel="noopener noreferrer"
        className="transition-colors hover:text-bone"
      >
        satflow
      </a>{' '}
      +{' '}
      <a
        href="https://ord.net"
        target="_blank"
        rel="noopener noreferrer"
        className="transition-colors hover:text-bone"
      >
        ord.net
      </a>{' '}
      · wallet identity via{' '}
      <a
        href="https://matrica.io"
        target="_blank"
        rel="noopener noreferrer"
        className="transition-colors hover:text-bone"
      >
        matrica
      </a>
    </footer>
  );
}
