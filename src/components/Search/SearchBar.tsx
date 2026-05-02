'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import SearchDropdown, { type FlatRow } from './SearchDropdown';
import { eventLink, type SearchResults } from '@/lib/searchTypes';

const MIN_CHARS = 2;
const DEBOUNCE_MS = 250;

type Status = 'idle' | 'loading' | 'ready' | 'error';

export default function SearchBar() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Pre-fill from ?q= when we're on /search so the bar reflects current state.
  const initialQ = searchParams.get('q') ?? '';
  const [q, setQ] = useState(initialQ);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flatRows = useMemo<FlatRow[]>(() => {
    if (!results) return q ? seeAllRow(q) : [];
    const rows: FlatRow[] = [];
    for (const insc of results.inscriptions) {
      const isOmb = insc.collection_slug === 'omb';
      rows.push({
        key: `insc:${insc.collection_slug}:${insc.inscription_number}`,
        href: isOmb
          ? `/inscription/${insc.inscription_number}`
          : insc.inscription_id
            ? `https://ordinals.com/inscription/${insc.inscription_id}`
            : `/inscription/${insc.inscription_number}`,
        external: !isOmb,
        render: () => null,
      });
    }
    for (const h of results.holders) {
      rows.push({
        key: `holder:${h.address}`,
        href: `/holder/${h.address}`,
        render: () => null,
      });
    }
    for (const u of results.users) {
      if (!u.first_wallet) continue;
      rows.push({
        key: `user:${u.user_id}`,
        href: `/holder/${u.first_wallet}`,
        render: () => null,
      });
    }
    for (const e of results.events) {
      const link = eventLink(e);
      rows.push({
        key: `event:${e.id}`,
        href: link.href,
        external: link.external,
        render: () => null,
      });
    }
    if (q) rows.push(...seeAllRow(q));
    return rows;
  }, [results, q]);

  const runFetch = useCallback(async (query: string) => {
    if (query.trim().length < MIN_CHARS) {
      setStatus('idle');
      setResults(null);
      return;
    }
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setStatus('loading');
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=5`, {
        signal: ac.signal,
      });
      if (!res.ok) {
        setStatus('error');
        return;
      }
      const data = (await res.json()) as SearchResults;
      setResults(data);
      setStatus('ready');
      setFocusedIndex(-1);
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      setStatus('error');
    }
  }, []);

  // Cleanup pending timer + in-flight request on unmount.
  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      abortRef.current?.abort();
    },
    []
  );

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  // ⌘K / ctrl+K focus shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onChange = (val: string) => {
    setQ(val);
    setOpen(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      void runFetch(val);
    }, DEBOUNCE_MS);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false);
      setFocusedIndex(-1);
      inputRef.current?.blur();
      return;
    }
    if (!open || flatRows.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusedIndex(i => (i + 1) % flatRows.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusedIndex(i => (i <= 0 ? flatRows.length - 1 : i - 1));
    } else if (e.key === 'Enter') {
      if (focusedIndex >= 0 && focusedIndex < flatRows.length) {
        const row = flatRows[focusedIndex];
        e.preventDefault();
        setOpen(false);
        if (row.external) {
          window.open(row.href, '_blank', 'noopener,noreferrer');
        } else {
          router.push(row.href);
        }
      }
      // else: fall through to native form submit → /search?q=...
    }
  };

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    if (!q.trim()) {
      e.preventDefault();
      return;
    }
    // Native submit handles the navigation — close dropdown so it doesn't
    // flicker behind the new page.
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative shrink min-w-0 flex-1 sm:flex-none sm:w-56 md:w-72">
      <form ref={formRef} action="/search" method="get" onSubmit={onSubmit} role="search">
        <input
          ref={inputRef}
          type="search"
          name="q"
          value={q}
          autoComplete="off"
          placeholder="search…"
          aria-label="Search inscriptions, wallets, users, txids"
          onChange={e => onChange(e.target.value)}
          onFocus={() => {
            if (q.trim().length >= MIN_CHARS && results) setOpen(true);
          }}
          onKeyDown={onKeyDown}
          className="w-full bg-ink-0 border border-ink-2 focus:border-bone-dim focus:outline-none px-2.5 py-1 font-mono text-xs text-bone placeholder:text-bone-dim tracking-[0.04em] normal-case"
        />
      </form>
      {open && (q.trim().length >= MIN_CHARS || results) && (
        <SearchDropdown
          q={q.trim()}
          results={results}
          status={status}
          rows={flatRows}
          focusedIndex={focusedIndex}
          onHover={i => setFocusedIndex(i)}
          onClose={() => {
            setOpen(false);
            setFocusedIndex(-1);
          }}
        />
      )}
    </div>
  );
}

function seeAllRow(q: string): FlatRow[] {
  return [
    {
      key: `seeall:${q}`,
      href: `/search?q=${encodeURIComponent(q)}`,
      render: () => null,
    },
  ];
}
