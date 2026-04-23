'use client';

import { useEffect, useState } from 'react';
import type { ApiHolder, ApiInscription } from '@/components/Activity/types';
import type { LeaderboardKey } from './types';

export type LeaderboardData =
  | { kind: 'inscriptions'; items: ApiInscription[] }
  | { kind: 'holders'; items: ApiHolder[] };

export function useLeaderboard(key: LeaderboardKey, limit: number) {
  const [data, setData] = useState<LeaderboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const url =
          key === 'top-holders'
            ? `/api/holders?limit=${limit}`
            : `/api/explorer/${key}?limit=${limit}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (cancelled) return;
        if (key === 'top-holders') {
          setData({ kind: 'holders', items: body.items ?? [] });
        } else {
          setData({ kind: 'inscriptions', items: body.items ?? [] });
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, limit]);

  return { data, loading, error };
}
