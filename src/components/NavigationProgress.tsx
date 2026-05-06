'use client';

import {
  Suspense,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

// Top-of-viewport indeterminate progress bar that surfaces pending navigations
// in the App Router. Without this, a click on a `<Link>` to a server-rendered
// route (e.g. /holder/[address], /inscription/[number], /explorer/[type])
// silently waits for the RSC payload — the previous page just sits there with
// zero feedback. The 150ms show-delay means fast routes never flash a loader;
// the 200ms tail lets the bar visibly finish instead of vanishing mid-stride.

type Ctx = { startNavigation: () => void };
const NavigationContext = createContext<Ctx | null>(null);

/** Trigger the progress bar from a `router.push` / `router.replace` call site
 * (the document-level click interceptor handles raw `<Link>` / `<a>` clicks). */
export function useNavigationStart(): () => void {
  return useContext(NavigationContext)?.startNavigation ?? noop;
}

function noop() {}

const SHOW_DELAY_MS = 150;
const HIDE_TAIL_MS = 200;

export default function NavigationProgress({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<>{children}</>}>
      <NavigationProgressInner>{children}</NavigationProgressInner>
    </Suspense>
  );
}

function NavigationProgressInner({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [navigating, setNavigating] = useState(false);
  const [visible, setVisible] = useState(false);

  const startNavigation = useCallback(() => {
    setNavigating(true);
  }, []);

  // Detect navigation completion: pathname or query string actually changed.
  // We compare against the last-seen pair so we don't clear on the initial
  // mount or on unrelated re-renders.
  const lastUrlRef = useRef<{ pathname: string; qs: string } | null>(null);
  useEffect(() => {
    const qs = searchParams.toString();
    const last = lastUrlRef.current;
    lastUrlRef.current = { pathname, qs };
    if (last && (last.pathname !== pathname || last.qs !== qs)) {
      setNavigating(false);
    }
  }, [pathname, searchParams]);

  // Document-level click interceptor for `<Link>` and `<a>` clicks. We deliberately
  // use a capture-phase listener so we still see the click even if a child component
  // calls e.preventDefault — but we only act on plain left-clicks to internal routes.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest('a');
      if (!anchor) return;
      if (anchor.target && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download')) return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('#')) return;
      let url: URL;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      // Same path + same query: no navigation will happen.
      if (
        url.pathname === window.location.pathname &&
        url.search === window.location.search
      ) {
        return;
      }
      startNavigation();
    }

    // Browser back/forward — App Router serves from cache when warm but can
    // round-trip the server when cold (TTL expired, or never visited).
    function onPopState() {
      startNavigation();
    }

    document.addEventListener('click', onClick, true);
    window.addEventListener('popstate', onPopState);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', onPopState);
    };
  }, [startNavigation]);

  // Show after the delay so fast navs never flash; on completion, keep the bar
  // visible for a short tail so it reads as "finishing" rather than disappearing.
  useEffect(() => {
    if (navigating) {
      const t = setTimeout(() => setVisible(true), SHOW_DELAY_MS);
      return () => clearTimeout(t);
    }
    if (!visible) return;
    const t = setTimeout(() => setVisible(false), HIDE_TAIL_MS);
    return () => clearTimeout(t);
  }, [navigating, visible]);

  return (
    <NavigationContext.Provider value={{ startNavigation }}>
      <div
        aria-hidden
        className={`pointer-events-none fixed inset-x-0 top-0 z-[1000] h-0.5 transition-opacity duration-200 ${
          visible ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <div className="relative h-full w-full overflow-hidden">
          <div className="omb-nav-progress-stripe absolute inset-y-0 bg-accent-orange" />
        </div>
      </div>
      {children}
    </NavigationContext.Provider>
  );
}
