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
// zero feedback. The 500ms show-delay means routes that complete quickly
// never flash a loader; the 200ms tail lets the bar visibly finish instead
// of vanishing mid-stride.

type Ctx = { startNavigation: () => void };
const NavigationContext = createContext<Ctx | null>(null);

/** Trigger the progress bar from a `router.push` / `router.replace` call site
 * (the document-level click interceptor handles raw `<Link>` / `<a>` clicks). */
export function useNavigationStart(): () => void {
  return useContext(NavigationContext)?.startNavigation ?? noop;
}

function noop() {}

const SHOW_DELAY_MS = 500;
const HIDE_TAIL_MS = 200;
// Hard ceiling on how long the bar can stay up. Defends against any edge
// case where `navigating` gets stuck (e.g. a click handler fires after the
// route has already updated, leaving no future pathname change to clear it).
const SAFETY_TIMEOUT_MS = 20_000;

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

  // Clear `navigating` whenever the route actually changes. We deliberately
  // do NOT compare to a previous-pathname ref — under cache-hit back/forward
  // navs, Next.js's internal handlers can update pathname state in a tick
  // where the comparison loses to a racing setNavigating(true), pinning the
  // bar on. Always clearing on any post-mount route change is race-free; the
  // initial-mount guard prevents a spurious clear on first load.
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    setNavigating(false);
  }, [pathname, searchParams]);

  // Safety timeout: hard-clear `navigating` after SAFETY_TIMEOUT_MS so the
  // bar can never get stuck indefinitely.
  useEffect(() => {
    if (!navigating) return;
    const t = setTimeout(() => setNavigating(false), SAFETY_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [navigating]);

  // Document-level click interceptor for `<Link>` and `<a>` clicks. We deliberately
  // use a capture-phase listener so we still see the click even if a child component
  // calls e.preventDefault — but we only act on plain left-clicks to internal routes.
  // We do NOT listen to popstate: Next's internal popstate handling can update
  // pathname synchronously on cache hits, racing setNavigating(true) and
  // leaving the bar stuck. Cache-hit back/forward is fast enough that the
  // 500ms show-delay would suppress feedback there anyway.
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

    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('click', onClick, true);
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
