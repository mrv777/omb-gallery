import 'server-only';
import {
  getStmts,
  type EventRow,
  type HolderColorHighlightRow,
  type WalletLinkRow,
} from '@/lib/db';

/**
 * Resolve the full set of wallets a profile aggregates over. If `address` is
 * linked to a Matrica user, returns every sibling wallet we've indexed under
 * that user (including `address`). Otherwise returns just `[address]`.
 *
 * Mirrors the logic in `src/app/holder/[address]/page.tsx` so the API route
 * and the SSR page see the same wallet set for the same URL.
 */
export function resolveAggregatedWallets(address: string): {
  wallets: string[];
  link: WalletLinkRow | undefined;
} {
  const stmts = getStmts();
  const link = stmts.getWalletLink.get({ wallet_addr: address }) as WalletLinkRow | undefined;
  const userId = link?.matrica_user_id ?? null;
  let wallets: string[] = [address];
  if (userId) {
    const siblings = stmts.getWalletsForUser.all({ user_id: userId }) as Array<{
      wallet_addr: string;
    }>;
    wallets = Array.from(new Set<string>([address, ...siblings.map(s => s.wallet_addr)]));
  }
  return { wallets, link };
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
