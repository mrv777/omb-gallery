import 'server-only';
import { getStmts, type EventRow } from './db';

/** Wallet → public display identity. Legacy Matrica names remain in the API
 * contract for compatibility. `user_id` is stable and namespaced for ORD.NET;
 * username/avatar may be null, while provider records link provenance.
 *
 * `inferred` marks a Matrica identity resolved through cluster_anchors.
 * Direct public links always win, and ORD.NET identities never import inferred
 * siblings. Notifications use only explicit links for internal transfers.
 */
export type MatricaOverlay = Record<
  string,
  {
    user_id: string;
    username: string | null;
    avatar_url: string | null;
    inferred?: boolean;
    provider?: 'matrica' | 'ordnet';
  }
>;

type Options = {
  /** When true, also resolve wallets without a direct public identity link
   * but sit in a cluster_anchors component anchored to a Matrica user.
   * Default false — preserves the original strict semantics. */
  includeInferred?: boolean;
};

/**
 * Look up public profiles for every wallet address that appears as
 * old_owner / new_owner in the given event list. Single SQL query via
 * json_each — the prepared statement is reused across requests.
 *
 * Returns an empty object when no addresses are linked, so callers can
 * always treat it as a Record (no null check needed at the JSX layer).
 */
export function matricaProfilesForEvents(
  events: EventRow[],
  options: Options = {}
): MatricaOverlay {
  if (events.length === 0) return {};
  const addrs = new Set<string>();
  for (const e of events) {
    if (e.old_owner) addrs.add(e.old_owner);
    if (e.new_owner) addrs.add(e.new_owner);
  }
  if (addrs.size === 0) return {};
  return matricaProfilesForAddrs(Array.from(addrs), options);
}

export function matricaProfilesForAddrs(addrs: string[], options: Options = {}): MatricaOverlay {
  if (addrs.length === 0) return {};
  const stmts = getStmts();
  const stmt = options.includeInferred
    ? stmts.getMatricaProfilesForAddrsWithInferred
    : stmts.getMatricaProfilesForAddrs;
  const rows = stmt.all({
    addrs_json: JSON.stringify(addrs),
  }) as Array<{
    wallet_addr: string;
    user_id: string;
    username: string | null;
    avatar_url: string | null;
    inferred?: number;
    provider: 'matrica' | 'ordnet';
  }>;
  const out: MatricaOverlay = {};
  for (const r of rows) {
    out[r.wallet_addr] = {
      user_id: r.user_id,
      username: r.username,
      avatar_url: r.avatar_url,
      provider: r.provider,
      ...(r.inferred ? { inferred: true } : {}),
    };
  }
  return out;
}
