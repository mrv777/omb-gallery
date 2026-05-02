import 'server-only';
import { getStmts } from './db';
import type {
  SearchEvent,
  SearchHolder,
  SearchInscription,
  SearchResults,
  SearchUser,
} from './searchTypes';

// Re-export so legacy imports from `@/lib/search` (server-side) keep working.
export type { SearchEvent, SearchHolder, SearchInscription, SearchResults, SearchUser };
export { eventLink } from './searchTypes';

export type RoutedQuery =
  | { kind: 'empty' }
  | { kind: 'number'; n: number }
  | { kind: 'inscription_id'; q: string }
  | { kind: 'txid'; q: string }
  | { kind: 'address'; q: string }
  | { kind: 'text'; q: string };

const HEX64 = /^[a-f0-9]{64}$/i;
const INSCRIPTION_ID = /^[a-f0-9]{64}i\d+$/i;
const BECH32 = /^(bc1|tb1)[a-z0-9]{20,}$/i;
const BASE58_ADDR = /^[13][a-zA-Z0-9]{20,40}$/;

/** Normalize a user-typed query: trim, strip leading `#` / `@` / `/`. */
export function normalizeQuery(raw: string): string {
  return raw.trim().replace(/^[#@/]+/, '').trim();
}

export function routeQuery(rawInput: string): RoutedQuery {
  const q = normalizeQuery(rawInput);
  if (!q) return { kind: 'empty' };

  if (/^\d+$/.test(q)) {
    const n = Number(q);
    if (Number.isFinite(n) && n >= 0 && n < Number.MAX_SAFE_INTEGER) {
      return { kind: 'number', n };
    }
  }
  if (INSCRIPTION_ID.test(q)) return { kind: 'inscription_id', q: q.toLowerCase() };
  if (HEX64.test(q)) return { kind: 'txid', q: q.toLowerCase() };
  // bech32 is canonically lowercase; legacy is case-sensitive base58.
  if (BECH32.test(q)) return { kind: 'address', q: q.toLowerCase() };
  if (BASE58_ADDR.test(q)) return { kind: 'address', q };

  return { kind: 'text', q };
}

type RunOpts = {
  /** Cap rows per category. Default 8; the dropdown passes 5. */
  limit?: number;
  /** When true (default), `/search` page redirect short-circuits are honored.
   * The autocomplete API passes false because the dropdown never redirects. */
  allowRedirect?: boolean;
};

const MAX_LIMIT = 25;
const MIN_TEXT_LENGTH = 2;

/** Run a search and return categorized results. Pure server function. */
export function runSearch(rawInput: string, opts: RunOpts = {}): SearchResults {
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), MAX_LIMIT);
  const allowRedirect = opts.allowRedirect ?? true;
  const routed = routeQuery(rawInput);
  const q = normalizeQuery(rawInput);

  const empty: SearchResults = {
    q,
    inscriptions: [],
    holders: [],
    users: [],
    events: [],
  };

  if (routed.kind === 'empty') return empty;

  const stmts = getStmts();
  const out: SearchResults = { ...empty };

  switch (routed.kind) {
    case 'number': {
      const row = stmts.searchInscriptionByNumber.get(routed.n) as
        | SearchInscription
        | undefined;
      if (row) {
        out.inscriptions = [row];
        if (allowRedirect && row.collection_slug === 'omb') {
          out.redirect = `/inscription/${row.inscription_number}`;
        }
      }
      // Also surface user/holder hits when a number happens to match no inscription
      // — rare, but keeps the page useful instead of empty.
      if (!row) {
        out.users = (stmts.searchUsersByName.all({ q }) as SearchUser[]).slice(0, limit);
      }
      break;
    }

    case 'inscription_id': {
      const row = stmts.searchInscriptionById.get(routed.q) as
        | SearchInscription
        | undefined;
      if (row) {
        out.inscriptions = [row];
        if (allowRedirect && row.collection_slug === 'omb') {
          out.redirect = `/inscription/${row.inscription_number}`;
        }
      }
      // Always surface tx events for the same hex (the txid prefix of an inscription_id).
      const baseTxid = routed.q.split('i')[0];
      out.events = (stmts.searchEventsByTxid.all(baseTxid) as SearchEvent[]).slice(0, limit);
      break;
    }

    case 'txid': {
      out.events = (stmts.searchEventsByTxid.all(routed.q) as SearchEvent[]).slice(0, limit);
      // A bare 64-hex string could also be a genesis txid for an inscription.
      const matches = stmts.searchInscriptionsByIdPrefix.all(routed.q) as SearchInscription[];
      out.inscriptions = matches.slice(0, limit);
      // No redirect: txid is genuinely ambiguous (1 tx → many events / inscriptions).
      break;
    }

    case 'address': {
      const exact = stmts.searchHolderByAddress.get(routed.q) as
        | SearchHolder
        | undefined;
      if (exact) {
        out.holders = [exact];
        if (allowRedirect) out.redirect = `/holder/${routed.q}`;
      } else {
        // Fall back to suffix matching when the input doesn't exactly match
        // anything we know about. Keeps "I pasted a partial address" useful.
        out.holders = stmts.searchHoldersBySuffix.all(routed.q) as SearchHolder[];
      }
      break;
    }

    case 'text': {
      if (q.length < MIN_TEXT_LENGTH) return out;
      out.users = (stmts.searchUsersByName.all({ q }) as SearchUser[]).slice(0, limit);
      // Also try as an address suffix (e.g. user remembers "ends in xyz123").
      // The 4-char floor avoids LIKE-everything noise.
      if (q.length >= 4) {
        out.holders = (stmts.searchHoldersBySuffix.all(q) as SearchHolder[]).slice(0, limit);
      }
      break;
    }
  }

  return out;
}
