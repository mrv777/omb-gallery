import Link from 'next/link';
import type { ReactNode } from 'react';
import HelpButton from './HelpButton';

type Props = {
  active?: 'activity' | 'explorer';
  children: ReactNode;
};

const NAV: { key: 'gallery' | 'activity' | 'explorer'; label: string; href: string }[] = [
  { key: 'gallery', label: 'gallery', href: '/' },
  { key: 'activity', label: 'activity', href: '/activity' },
  { key: 'explorer', label: 'explorer', href: '/explorer' },
];

export default function SubpageShell({ active, children }: Props) {
  return (
    <div className="h-screen w-full overflow-y-auto bg-ink-0 text-bone">
      <header className="sticky top-0 z-10 bg-ink-1/95 backdrop-blur border-b border-ink-2">
        <div className="flex h-12 items-center gap-4 sm:gap-6 px-4 sm:px-6 font-mono text-xs tracking-[0.08em] uppercase">
          <div className="text-bone shrink-0">OMB</div>
          <nav className="flex items-center gap-3 sm:gap-5">
            {NAV.map(item => {
              const isActive = item.key === active;
              return (
                <Link
                  key={item.key}
                  href={item.href}
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
          <div className="ml-auto">
            <HelpButton />
          </div>
        </div>
      </header>
      <main className="pt-6">{children}</main>
      <footer className="px-4 sm:px-6 py-8 font-mono text-[10px] tracking-[0.08em] uppercase text-bone-dim border-t border-ink-2 mt-8">
        on-chain data via self-hosted ord · sale data via{' '}
        <a
          href="https://www.satflow.com"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-bone transition-colors"
        >
          satflow
        </a>
      </footer>
    </div>
  );
}
