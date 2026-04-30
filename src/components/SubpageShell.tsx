import Link from 'next/link';
import type { ReactNode } from 'react';
import HelpButton from './HelpButton';
import MobileMenu from './MobileMenu';
import FirehoseSubscribe from './FirehoseSubscribe';
import type { ColorFilter } from '@/lib/types';
import { appendColorParam } from '@/lib/colorFilter';

type Props = {
  active?: 'activity' | 'explorer';
  /** Pass through so cross-page nav links preserve the user's filter. */
  color?: ColorFilter;
  /** Optional content rendered in the header between nav and the help button.
   * Used to surface the color swatches on /activity and /explorer. */
  headerControls?: ReactNode;
  children: ReactNode;
};

const NAV: { key: 'gallery' | 'activity' | 'explorer'; label: string; href: string }[] = [
  { key: 'gallery', label: 'gallery', href: '/' },
  { key: 'activity', label: 'activity', href: '/activity' },
  { key: 'explorer', label: 'explorer', href: '/explorer' },
];

export default function SubpageShell({
  active,
  color = 'all',
  headerControls,
  children,
}: Props) {
  return (
    <div className="h-screen w-full overflow-y-auto bg-ink-0 text-bone">
      <header className="sticky top-0 z-10 bg-ink-1/95 backdrop-blur border-b border-ink-2">
        <div className="flex h-12 items-center gap-3 sm:gap-6 px-3 sm:px-6 font-mono text-xs tracking-[0.08em] uppercase">
          <MobileMenu active={active} />
          <div className="hidden md:block text-bone shrink-0">OMB</div>
          <nav className="hidden md:flex items-center gap-3 sm:gap-5">
            {NAV.map(item => {
              const isActive = item.key === active;
              return (
                <Link
                  key={item.key}
                  href={appendColorParam(item.href, color)}
                  className={`transition-colors ${
                    isActive ? 'text-bone' : 'text-bone-dim hover:text-bone'
                  }`}
                >
                  <span
                    className={`border px-1.5 py-0.5 ${isActive ? 'border-bone' : 'border-transparent'}`}
                  >
                    {item.label}
                  </span>
                </Link>
              );
            })}
          </nav>
          {headerControls}
          <div className="ml-auto hidden md:block">
            <HelpButton />
          </div>
        </div>
      </header>
      <main className="pt-6">{children}</main>
      <footer className="px-4 sm:px-6 py-8 font-mono text-[10px] tracking-[0.08em] uppercase text-bone-dim border-t border-ink-2 mt-8">
        <div className="mb-4">
          <FirehoseSubscribe />
        </div>
        on-chain data via ord · sale data via{' '}
        <a
          href="https://www.satflow.com"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-bone transition-colors"
        >
          satflow
        </a>{' '}
        · wallet identity via{' '}
        <a
          href="https://matrica.io"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-bone transition-colors"
        >
          matrica
        </a>
      </footer>
    </div>
  );
}
