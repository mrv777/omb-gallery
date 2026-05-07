import 'server-only';
import { getStmts, type EventRow } from './db';

/** Wallet → Matrica display data. Only addresses with a non-null username
 * are returned (default-square / no-profile wallets are dropped client-side
 * by exclusion from this map). `user_id` is the stable Matrica identity —
 * always non-null in returned rows because the SQL INNER JOINs matrica_users.
 *
 * `inferred` is set when the resolution went through cluster_anchors rather
 * than a direct wallet_links → matrica_user_id link. UI layers should mark
 * inferred profiles visually so users can tell heuristic folds from
 * authoritative ones. Notifications intentionally never receive inferred
 * profiles — internal-transfer detection has to be Matrica-strict.
 */
export type MatricaOverlay = Record<
  string,
  {
    user_id: string;
    username: string | null;
    avatar_url: string | null;
    inferred?: boolean;
  }
>;

type Options = {
  /** When true, also resolve wallets that aren't directly Matrica-linked
   * but sit in a cluster_anchors component anchored to a Matrica user.
   * Default false — preserves the original strict semantics. */
  includeInferred?: boolean;
};

/**
 * Look up Matrica profiles for every wallet address that appears as
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

export function matricaProfilesForAddrs(
  addrs: string[],
  options: Options = {}
): MatricaOverlay {
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
  }>;
  const out: MatricaOverlay = {};
  for (const r of rows) {
    out[r.wallet_addr] = {
      user_id: r.user_id,
      username: r.username,
      avatar_url: r.avatar_url,
      ...(r.inferred ? { inferred: true } : {}),
    };
  }
  return out;
}
