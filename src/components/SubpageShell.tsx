import type { ReactNode } from 'react';
import HelpButton from './HelpButton';
import MobileMenu from './MobileMenu';
import DesktopNav from './DesktopNav';
import DonationTrigger from './Donation/DonationTrigger';
import SiteFooter from './SiteFooter';
import SearchBar from './Search/SearchBar';
import type { ColorFilter } from '@/lib/types';
import { type NavKey } from '@/lib/nav';

type Props = {
  active?: NavKey;
  /** Pass through so cross-page nav links preserve the user's filter. */
  color?: ColorFilter;
  /** Optional content rendered in the header between nav and the help button.
   * Used to surface the color swatches on /activity and /explorer. */
  headerControls?: ReactNode;
  children: ReactNode;
};

export default function SubpageShell({ active, color = 'all', headerControls, children }: Props) {
  // The scroll container is sized to the viewport so it (not body) scrolls.
  // h-screen (100vh) is the fallback for browsers without dvh (pre-iOS 15.4);
  // the arbitrary [height:100dvh] is emitted later in the stylesheet so it wins
  // on modern browsers. dvh tracks the *visible* viewport, which keeps body from
  // overflowing under iOS Safari's expanded address bar — without it,
  // body{overflow:hidden} + 100vh leaves the page resting scrolled-down with the
  // top inaccessible (WebKit bug 153852).
  return (
    <div className="h-screen [height:100dvh] w-full overflow-y-auto bg-ink-0 text-bone">
      <header className="sticky top-0 z-50 bg-ink-1/95 backdrop-blur border-b border-ink-2">
        <div className="flex h-12 items-center gap-2 sm:gap-6 px-3 sm:px-6 font-mono text-xs tracking-[0.08em] uppercase">
          <MobileMenu active={active} />
          <DesktopNav active={active} color={color} />
          <SearchBar />
          <div className="ml-auto flex shrink-0 items-center gap-3">
            {headerControls}
            {/* Matches MobileMenu's breakpoint — below `nav-full` the sheet carries
                own help item, and showing both would duplicate it. */}
            <div className="hidden nav-full:flex">
              <DonationTrigger variant="header" />
              <HelpButton />
            </div>
          </div>
        </div>
      </header>
      <main className="pt-6">{children}</main>
      <SiteFooter className="mt-8" />
    </div>
  );
}
