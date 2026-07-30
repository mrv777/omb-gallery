'use client';

import FirehoseSubscribe from './FirehoseSubscribe';
import DonationTrigger from './Donation/DonationTrigger';

export default function SiteFooter({ className = '' }: { className?: string }) {
  return (
    <footer
      className={`border-t border-ink-2 px-4 py-8 font-mono text-[10px] uppercase tracking-[0.08em] text-bone-dim sm:px-6 ${className}`}
    >
      <div className="flex flex-col gap-7 lg:flex-row lg:items-start lg:justify-between lg:gap-12">
        <div className="min-w-0">
          <div className="mb-4">
            <FirehoseSubscribe />
          </div>
          <p>
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
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-3 text-right">
          <p className="max-w-xs normal-case tracking-normal">
            Help keep the site indexed, hosted, and evolving.
          </p>
          <DonationTrigger variant="footer" />
        </div>
      </div>
    </footer>
  );
}
