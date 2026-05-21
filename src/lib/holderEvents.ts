import 'server-only';
import {
  getDb,
  getStmts,
  type EventRow,
  type HolderColorHighlightRow,
  type WalletLinkRow,
} from '@/lib/db';
import {
  getClusterAnchorForAddress,
  getClusterMembersForAddress,
  getClusterMembersForMatricaUser,
} from '@/lib/clusterStore';

/**
 * Resolve the full set of wallets a profile aggregates over.
 *
 * Two layers fold into the wallet set:
 *   1. Matrica siblings — authoritative, always included when present.
 *   2. cluster_anchors members — on-chain inferred peers from high-confidence
 *      clustering or repeated listing-staging evidence. Folded in alongside
 *      Matrica siblings so OMB count, tiles, events, color spread, and
 *      bag-size all reflect the merged identity. The fold is permissive
 *      (union both sets) — never substitutive — so a Matrica-linked
 *      wallet's identity is preserved even if it sits in a heuristic
 *      component.
 *
 * `inferredCount` is the number of wallets added by cluster_anchors that
 * weren't already covered by Matrica — surfaced in the UI as a small
 * "+N inferred" hint near the WALLETS list. Mirrors the same fan-out
 * used by /api/holder/[address]/events so SSR and pagination see the
 * same set.
 */
export function resolveAggregatedWallets(address: string): {
  wallets: string[];
  link: WalletLinkRow | undefined;
  /** Subset of `wallets` that came from cluster_anchors and aren't Matrica
   * siblings. Used to render the "+N inferred" hint and tag those rows
   * in the wallets list. */
  inferredWallets: string[];
} {
  const stmts = getStmts();
  const link = stmts.getWalletLink.get({ wallet_addr: address }) as WalletLinkRow | undefined;
  const userId = link?.matrica_user_id ?? null;
  const matricaSet = new Set<string>([address]);
  if (userId) {
    const siblings = stmts.getWalletsForUser.all({ user_id: userId }) as Array<{
      wallet_addr: string;
    }>;
    for (const s of siblings) matricaSet.add(s.wallet_addr);
  }
  // Cluster fold: union members reachable from the input address with the
  // full Matrica-keyed cluster set. The Matrica-keyed lookup is the load-
  // bearing one — cluster_anchors only stores wallets that actually have
  // edges, so a Matrica user's "main" wallet (no on-chain link) wouldn't
  // see its inferred-peer siblings via getClusterMembersForAddress alone.
  const clusterMembers = new Set<string>(getClusterMembersForAddress(address));
  if (userId) {
    for (const w of getClusterMembersForMatricaUser(userId)) clusterMembers.add(w);
  }
  const inferredWallets: string[] = [];
  clusterMembers.forEach(m => {
    if (!matricaSet.has(m)) inferredWallets.push(m);
  });
  const merged = new Set<string>([address]);
  matricaSet.forEach(w => merged.add(w));
  clusterMembers.forEach(w => merged.add(w));
  const wallets = Array.from(merged);
  return { wallets, link, inferredWallets };
}

/**
 * Resolve the canonical wallet to render the holder page for. Returns
 * null when `address` is the canonical address (or is in a singleton)
 * and the page should render in place.
 *
 * Rationale: visiting an inferred-only sibling (e.g. a wallet folded into
 * a Matrica identity by the on-chain heuristic) should land on the same
 * profile as visiting any of the user's confirmed wallets — otherwise
 * users see a different sub-profile per click and can't tell the
 * identity apart.
 *
 * Rules:
 *   - Matrica-linked address: render in place. Every Matrica sibling
 *     already aggregates the same identity; no need to canonicalize.
 *   - No Matrica directly, cluster_anchors with matrica_user_id set:
 *     redirect to the lex-min Matrica-linked wallet for that user.
 *   - No Matrica anywhere, unlinked cluster: redirect to the cluster's
 *     anchor wallet (lex-min member) when not already there.
 *   - Singleton or unknown: render in place.
 */
export function resolveCanonicalHolderAddress(address: string): string | null {
  const stmts = getStmts();
  const link = stmts.getWalletLink.get({ wallet_addr: address }) as WalletLinkRow | undefined;
  if (link?.matrica_user_id) return null;

  const anchor = getClusterAnchorForAddress(address);
  if (!anchor) return null;

  if (anchor.matrica_user_id) {
    const row = getDb()
      .prepare(
        `SELECT wallet_addr FROM wallet_links
          WHERE matrica_user_id = ?
          ORDER BY wallet_addr ASC LIMIT 1`
      )
      .get(anchor.matrica_user_id) as { wallet_addr: string } | undefined;
    if (row?.wallet_addr && row.wallet_addr !== address) return row.wallet_addr;
    return null;
  }

  return anchor.anchor_id !== address ? anchor.anchor_id : null;
}

export type HolderEventsCursor = { ts: number; id: number };

/**
 * Fan-out fetch of events across multiple wallets, deduped by event id and
 * sorted globally by (block_timestamp DESC, id DESC). Used by both the SSR
 * holder page (cursor=null, initial page) and the paginated API route.
 *
 * Per-wallet over-fetch is `limit * Math.max(2, wallets.length)` — for the
 * common single-wallet case that's `limit*2`; for multi-wallet aggregations
 * it scales so dedupe overlap can't truncate below `limit`.
 */
export function fetchHolderEventsPage(
  wallets: string[],
  cursor: HolderEventsCursor | null,
  limit: number
): { events: EventRow[]; nextCursor: HolderEventsCursor | null } {
  const stmts = getStmts();
  const perWallet = limit * Math.max(2, wallets.length);
  const merged = new Map<number, EventRow>();
  for (const w of wallets) {
    const rows =
      cursor == null
        ? (stmts.getEventsByAddress.all({ owner: w, limit: perWallet }) as EventRow[])
        : (stmts.getEventsByAddressBefore.all({
            owner: w,
            cursor_ts: cursor.ts,
            cursor_id: cursor.id,
            limit: perWallet,
          }) as EventRow[]);
    for (const r of rows) merged.set(r.id, r);
  }
  const sorted = Array.from(merged.values()).sort(
    (a, b) => b.block_timestamp - a.block_timestamp || b.id - a.id
  );
  const events = sorted.slice(0, limit);
  // Return a cursor only when we filled the page AND we know more exists in
  // at least one wallet. Conservative rule: if any wallet's per-wallet result
  // was capped at `perWallet`, more might exist — emit a cursor. Cheaper
  // shortcut: emit the cursor whenever we filled the page; if the next call
  // returns empty, the client treats that as "reached end".
  const nextCursor =
    events.length === limit
      ? { ts: events[events.length - 1].block_timestamp, id: events[events.length - 1].id }
      : null;
  return { events, nextCursor };
}

export function encodeCursor(c: HolderEventsCursor): string {
  return `${c.ts}:${c.id}`;
}

export function decodeCursor(s: string | null): HolderEventsCursor | null {
  if (!s) return null;
  const m = /^(\d+):(\d+)$/.exec(s);
  if (!m) return null;
  return { ts: parseInt(m[1], 10), id: parseInt(m[2], 10) };
}

/** Highlight payload for the bag-size-over-time chart. One per non-internal
 * red/blue OMB event. `direction='in'` is "received into the user's wallet
 * set", `'out'` is "sent out". `event_id` lets the chart correlate the marker
 * Y-position to the running bag size at that exact event. */
export type HolderColorHighlight = {
  event_id: number;
  block_timestamp: number;
  inscription_number: number;
  color: 'red' | 'blue';
  direction: 'in' | 'out';
};

/**
 * Fan-out fetch of red/blue OMB ownership changes across the wallet set.
 * Groups by event_id and sums deltas — internal transfers between two of the
 * user's own wallets net to 0 and are dropped (the bag size doesn't actually
 * change for the identity). Net +1 = received, -1 = sent. Anything else
 * (shouldn't happen given +1/-1 inputs from a single event) is dropped
 * defensively.
 *
 * Bounded: only red+blue OMBs (~few hundred inscriptions in the dataset),
 * filtered to events involving these wallets. Even a whale of all reds
 * stays in the low hundreds of rows.
 */
export function fetchHolderColorHighlights(wallets: string[]): HolderColorHighlight[] {
  const stmts = getStmts();
  // event_id → accumulated rows. We collect all rows first so a multi-wallet
  // identity can sum cross-wallet deltas (one wallet contributes -1, another
  // contributes +1 → internal, net 0 → drop).
  const byEvent = new Map<number, { rows: HolderColorHighlightRow[]; net: number }>();
  for (const w of wallets) {
    const rows = stmts.holderColorHighlights.all({ owner: w }) as HolderColorHighlightRow[];
    for (const r of rows) {
      const slot = byEvent.get(r.event_id) ?? { rows: [], net: 0 };
      slot.rows.push(r);
      slot.net += r.delta;
      byEvent.set(r.event_id, slot);
    }
  }
  const out: HolderColorHighlight[] = [];
  byEvent.forEach(({ rows, net }, event_id) => {
    if (net !== 1 && net !== -1) return; // 0 = internal; other values shouldn't occur
    const r = rows[0];
    out.push({
      event_id,
      block_timestamp: r.block_timestamp,
      inscription_number: r.inscription_number,
      color: r.color,
      direction: net === 1 ? 'in' : 'out',
    });
  });
  // Stable order for rendering (older first → newer markers paint on top).
  out.sort((a, b) => a.block_timestamp - b.block_timestamp || a.event_id - b.event_id);
  return out;
}
