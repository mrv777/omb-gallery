import 'server-only';
import { getStmts, type EventRow } from './db';

/** Wallet → Matrica display data. Only addresses with a non-null username
 * are returned (default-square / no-profile wallets are dropped client-side
 * by exclusion from this map). */
export type MatricaOverlay = Record<
  string,
  { username: string | null; avatar_url: string | null }
>;

/**
 * Look up Matrica profiles for every wallet address that appears as
 * old_owner / new_owner in the given event list. Single SQL query via
 * json_each — the prepared statement is reused across requests.
 *
 * Returns an empty object when no addresses are linked, so callers can
 * always treat it as a Record (no null check needed at the JSX layer).
 */
export function matricaProfilesForEvents(events: EventRow[]): MatricaOverlay {
  if (events.length === 0) return {};
  const addrs = new Set<string>();
  for (const e of events) {
    if (e.old_owner) addrs.add(e.old_owner);
    if (e.new_owner) addrs.add(e.new_owner);
  }
  if (addrs.size === 0) return {};
  return matricaProfilesForAddrs(Array.from(addrs));
}

export function matricaProfilesForAddrs(addrs: string[]): MatricaOverlay {
  if (addrs.length === 0) return {};
  const stmts = getStmts();
  const rows = stmts.getMatricaProfilesForAddrs.all({
    addrs_json: JSON.stringify(addrs),
  }) as Array<{ wallet_addr: string; username: string | null; avatar_url: string | null }>;
  const out: MatricaOverlay = {};
  for (const r of rows) {
    out[r.wallet_addr] = { username: r.username, avatar_url: r.avatar_url };
  }
  return out;
}
