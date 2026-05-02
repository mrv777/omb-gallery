// Client-safe shapes + pure helpers shared between the server-only search
// pipeline (`src/lib/search.ts`) and the client components in
// `src/components/Search`. Keep this file free of server-only imports
// (better-sqlite3, node:fs, etc.) so it can cross the SSR/CSR boundary.

export type SearchInscription = {
  inscription_number: number;
  inscription_id: string | null;
  color: string | null;
  current_owner: string | null;
  collection_slug: string | null;
};

export type SearchHolder = {
  address: string;
  inscription_count: number;
};

export type SearchUser = {
  user_id: string;
  username: string;
  avatar_url: string | null;
  wallet_count: number;
  first_wallet: string | null;
};

export type SearchEvent = {
  id: number;
  inscription_number: number;
  inscription_id: string;
  event_type: 'inscribed' | 'transferred' | 'sold' | 'listed';
  old_owner: string | null;
  new_owner: string | null;
  marketplace: string | null;
  sale_price_sats: number | null;
  block_height: number | null;
  block_timestamp: number;
  txid: string;
  /** From a JOIN to inscriptions; null if the event references an inscription
   * row that no longer exists. Drives whether the row links to /inscription/N
   * (OMB) or out to ordinals.com (other collections). */
  collection_slug: string | null;
};

export type SearchResults = {
  q: string;
  inscriptions: SearchInscription[];
  holders: SearchHolder[];
  users: SearchUser[];
  events: SearchEvent[];
  /** When set, the /search page redirects here instead of rendering results. */
  redirect?: string;
};

/** Resolve an event row to a link target. OMB events go to the in-app
 * detail page; non-OMB events fall through to ordinals.com (which handles
 * any collection). Returns `external: true` for callers that need to pick
 * between `<Link>` and `<a target="_blank">`. */
export function eventLink(e: {
  collection_slug: string | null;
  inscription_number: number;
  inscription_id: string | null;
}): { href: string; external: boolean } {
  if (e.collection_slug === 'omb') {
    return { href: `/inscription/${e.inscription_number}`, external: false };
  }
  if (e.inscription_id) {
    return { href: `https://ordinals.com/inscription/${e.inscription_id}`, external: true };
  }
  // Fallback: best-effort internal link. May 404 for non-OMB rows missing an
  // inscription_id, but that combination shouldn't exist in steady state.
  return { href: `/inscription/${e.inscription_number}`, external: false };
}
