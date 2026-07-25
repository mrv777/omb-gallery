import Link from 'next/link';
import type { ColorFilter } from '@/lib/types';
import { appendColorParam } from '@/lib/colorFilter';
import { PRIMARY_NAV_ITEMS, SECONDARY_NAV_ITEMS, type NavItem, type NavKey } from '@/lib/nav';
import AvocadoIcon from './AvocadoIcon';
import { Tooltip } from './ui/Tooltip';

/**
 * The desktop nav row, shared by the subpage header and the gallery toolbar so
 * the two tiers can't drift apart. No hooks and no server-only imports, so it
 * compiles into both the server tree (SubpageShell) and the client bundle
 * (FilterControls).
 *
 * The active item renders as a boxed non-link — a link to the page you're
 * already on is a no-op that still costs a navigation.
 */
export default function DesktopNav({
  active,
  color = 'all',
  className = '',
}: {
  active?: NavKey;
  color?: ColorFilter;
  className?: string;
}) {
  const item = (nav: NavItem, secondary: boolean) => {
    const isActive = nav.key === active;
    const box = `border px-1.5 py-0.5 ${isActive ? 'border-bone' : 'border-transparent'}`;
    const size = secondary ? 'text-[10px] tracking-[0.1em]' : '';
    // Icon items carry no visible text, so the label has to reach assistive
    // tech some other way — aria-label on the link, plus a tooltip so sighted
    // users get the same word on hover.
    const body = nav.icon ? (
      <span className={`${box} inline-flex items-center`}>
        <AvocadoIcon />
      </span>
    ) : (
      <span className={box}>{nav.label}</span>
    );

    if (isActive) {
      return (
        <span key={nav.key} className={`text-bone ${size}`} aria-current="page">
          {nav.icon ? <span className="sr-only">{nav.label}</span> : null}
          {body}
        </span>
      );
    }

    const link = (
      <Link
        href={appendColorParam(nav.href, color)}
        aria-label={nav.icon ? nav.label : undefined}
        className={`transition-colors ${size} ${
          secondary ? 'text-bone-dim/70 hover:text-bone' : 'text-bone-dim hover:text-bone'
        }`}
      >
        {body}
      </Link>
    );

    return nav.icon ? (
      <Tooltip key={nav.key} content={nav.label}>
        {link}
      </Tooltip>
    ) : (
      <span key={nav.key}>{link}</span>
    );
  };

  // Below `nav-full` the secondary tier moves into the menu sheet. With
  // marketplace enabled the full row doesn't co-exist with the search field
  // and colour swatches at the narrow end of desktop — it overflowed the
  // subpage header by up to 102px. Shedding the *adjacent* surfaces first
  // keeps every primary destination on screen, which is what the NN/g
  // discoverability finding is actually about.
  return (
    // The gap only widens at `2xl`, deliberately NOT at `nav-full`: bumping it
    // at the same breakpoint that reveals the secondary tier adds ~12px across
    // six gaps exactly when the row is tightest, which overflowed by 4px just
    // above the threshold.
    <nav className={`hidden lg:flex items-center gap-3 2xl:gap-5 shrink-0 ${className}`}>
      {PRIMARY_NAV_ITEMS.map(nav => item(nav, false))}
      <span aria-hidden="true" className="hidden nav-full:block h-4 w-px bg-ink-2 shrink-0" />
      <span className="hidden nav-full:flex items-center gap-3 2xl:gap-5">
        {SECONDARY_NAV_ITEMS.map(nav => item(nav, true))}
      </span>
    </nav>
  );
}
