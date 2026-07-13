import 'server-only';
import type { Statement } from 'better-sqlite3';
import { getDb } from './db';

// Transfer-burst coalescing for the notification fan-out.
//
// A "peel chain" is a bot sweeping one inscription through many one-in/one-out
// hops to freshly-derived addresses. Every hop is a real, distinct on-chain tx
// with a genuinely different old_owner/new_owner, so the self-transfer guard
// (old_owner == new_owner) can't catch it and the `cih` cluster signal can't
// either (each address is used exactly once, never co-spent). The hops belong
// in `events` — they happened. What they don't warrant is one push notification
// each: OMB #60582555 produced 24 in 9 hours.
//
// The fan-out runs every 5 min and hops land every 10-20 min, so at most one
// hop is in flight per tick. Coalescing therefore has to be stateful ACROSS
// ticks, which is what this table is for.
//
// Hysteresis is deliberate: entry is count-based (BURST_MIN_HOPS in a rolling
// window), exit is quiet-based (BURST_QUIET_SEC of silence). Once the row
// exists, every subsequent hop is suppressed without re-running the count, so
// a chain can't flap in and out of burst state mid-sweep.
//
// Prepared statements live here rather than in db.ts's global Stmts so the
// module can be hot-reloaded in dev (same rationale as subscriptionStore.ts).

/** Hops 1-3 still alert individually. The median OMB moves a few times per
 *  *year*; four transfers of one inscription inside the window is not organic. */
export const BURST_MIN_HOPS = 4;

/** Entry window, in CHAIN time — this is a statement about on-chain velocity.
 *  Peel hops land every 10-20 min, so four fit comfortably. */
export const BURST_WINDOW_SEC = 6 * 3600;

/** No hop seen for this long (WALLCLOCK) → the burst is over → final digest. */
export const BURST_QUIET_SEC = 3600;

/** Heartbeat cadence (WALLCLOCK) for a burst that is still running. Six hours,
 *  not one: #60582555 swept for 9h, and an hourly "it moved 4 more times" is
 *  just the original spam at a coarser grain. At 6h that chain would have sent
 *  3 individual alerts + 1 heartbeat + 1 closing digest — five messages, each
 *  of which tells the subscriber something they didn't already know. */
export const BURST_DIGEST_MIN_INTERVAL_SEC = 6 * 3600;

/** Bounds fan-out wallclock. Bursts are rare; more than a handful at once
 *  would itself be the anomaly. */
export const BURST_DIGESTS_PER_TICK = 5;

/** After this many failed digest sends, force the cursor forward so one wedged
 *  target can't cause infinite re-sends to the healthy ones. */
export const BURST_MAX_DIGEST_ATTEMPTS = 3;

/** All timestamps are WALLCLOCK seconds — see the DDL comment in db.ts. The
 *  on-chain span a digest reports is derived from the hop events themselves. */
export type BurstRow = {
  inscription_number: number;
  opened_at: number;
  last_hop_seen_at: number;
  first_event_id: number;
  last_event_id: number;
  last_digest_at: number | null;
  digest_attempts: number;
};

export type BurstHop = {
  id: number;
  old_owner: string | null;
  new_owner: string | null;
  block_timestamp: number;
};

export type BurstInscription = {
  inscription_id: string;
  color: string | null;
  collection_slug: string;
};

type Stmts = {
  get: Statement;
  countInWindow: Statement;
  open: Statement;
  advance: Statement;
  due: Statement;
  hops: Statement;
  inscription: Statement;
  advanceCursor: Statement;
  bumpAttempts: Statement;
  close: Statement;
};

let stmts: Stmts | null = null;

function getStmts(): Stmts {
  if (stmts) return stmts;
  const db = getDb();
  stmts = {
    get: db.prepare(`SELECT * FROM notify_bursts WHERE inscription_number = ?`),

    // Anchored on the event's own id + block_timestamp rather than wallclock,
    // so the decision is deterministic and a re-processed event (crash between
    // the burst write and the queue dequeue) reaches the same verdict.
    countInWindow: db.prepare(`
      SELECT COUNT(*) AS n
      FROM events
      WHERE inscription_number = @inscription_number
        AND event_type = 'transferred'
        AND id <= @id
        AND block_timestamp >= @since
    `),

    open: db.prepare(`
      INSERT INTO notify_bursts (
        inscription_number, opened_at, last_hop_seen_at,
        first_event_id, last_event_id, updated_at
      ) VALUES (@inscription_number, @now, @now, @id, @id, unixepoch())
    `),

    // Idempotent: a hop we've already absorbed can't drag the cursors backward.
    advance: db.prepare(`
      UPDATE notify_bursts
      SET last_hop_seen_at = @now,
          last_event_id    = MAX(last_event_id, @id),
          updated_at       = unixepoch()
      WHERE inscription_number = @inscription_number
        AND @id > last_event_id
    `),

    // Due when: gone quiet (final digest), or the heartbeat is old enough.
    // A row that is fully digested AND quiet has nothing left to say — it comes
    // back with no pending hops and the caller just deletes it.
    due: db.prepare(`
      SELECT * FROM notify_bursts
      WHERE (@now - last_hop_seen_at) >= @quiet
         OR (first_event_id <= last_event_id
             AND (@now - COALESCE(last_digest_at, opened_at)) >= @interval)
      ORDER BY last_hop_seen_at ASC
      LIMIT @limit
    `),

    hops: db.prepare(`
      SELECT id, old_owner, new_owner, block_timestamp
      FROM events
      WHERE inscription_number = @inscription_number
        AND event_type = 'transferred'
        AND id BETWEEN @first_event_id AND @last_event_id
      ORDER BY id ASC
    `),

    inscription: db.prepare(`
      SELECT inscription_id, color, collection_slug
      FROM inscriptions
      WHERE inscription_number = ?
    `),

    advanceCursor: db.prepare(`
      UPDATE notify_bursts
      SET first_event_id  = @first_event_id,
          last_digest_at  = @now,
          digest_attempts = 0,
          updated_at      = unixepoch()
      WHERE inscription_number = @inscription_number
    `),

    bumpAttempts: db.prepare(`
      UPDATE notify_bursts
      SET digest_attempts = digest_attempts + 1,
          updated_at      = unixepoch()
      WHERE inscription_number = @inscription_number
    `),

    close: db.prepare(`DELETE FROM notify_bursts WHERE inscription_number = ?`),
  };
  return stmts;
}

/** Absorb a `transferred` event into a burst if one is running, or open a burst
 *  if this hop is the one that trips the threshold.
 *
 *  Returns true iff the hop was absorbed — the caller must then suppress its
 *  individual notification. Returns false for hops 1..BURST_MIN_HOPS-1, which
 *  still alert normally.
 *
 *  Safe to call twice for the same event (the cursor advance is monotonic), so
 *  a crash between this write and the queue dequeue re-suppresses rather than
 *  double-sending. */
export function recordBurstHop(
  ev: { id: number; inscription_number: number; block_timestamp: number },
  now: number = Math.floor(Date.now() / 1000)
): boolean {
  const s = getStmts();
  const params = { inscription_number: ev.inscription_number, id: ev.id, now };

  if (s.get.get(ev.inscription_number)) {
    s.advance.run(params);
    return true;
  }

  // The entry test is the one place chain time is right: "did this thing move
  // four times in six hours of BLOCK time" is a claim about on-chain velocity,
  // and anchoring it on the event's own id + timestamp keeps the verdict
  // deterministic across a replay.
  const { n } = s.countInWindow.get({
    inscription_number: ev.inscription_number,
    id: ev.id,
    since: ev.block_timestamp - BURST_WINDOW_SEC,
  }) as { n: number };

  if (n < BURST_MIN_HOPS) return false;

  // This hop opens the burst; the ones before it already went out individually.
  s.open.run(params);
  return true;
}

/** Bursts that need a digest emitted this tick.
 *
 *  `forced` jumps the queue — a sale landing mid-burst flushes the accumulated
 *  hops immediately so the subscriber reads "SOLD" and then "it moved N times
 *  before this", rather than getting the backstory an hour later. */
export function dueBursts(now: number, forced: Set<number> = new Set()): BurstRow[] {
  const s = getStmts();
  const rows = s.due.all({
    now,
    quiet: BURST_QUIET_SEC,
    interval: BURST_DIGEST_MIN_INTERVAL_SEC,
    limit: BURST_DIGESTS_PER_TICK,
  }) as BurstRow[];

  const seen = new Set(rows.map(r => r.inscription_number));
  for (const num of Array.from(forced)) {
    if (seen.has(num)) continue;
    const row = s.get.get(num) as BurstRow | undefined;
    if (row) rows.push(row);
  }
  return rows;
}

/** The hops a digest should describe. Re-derived from `events` rather than
 *  stored, which is why losing a notify_bursts row is harmless.
 *
 *  Filters on `event_type = 'transferred'`, so a hop later upgraded to `sold`
 *  by a fingerprint tagger silently drops out of the count — the digest stays
 *  truthful without any explicit reconciliation. */
export function burstHops(row: BurstRow): BurstHop[] {
  if (row.first_event_id > row.last_event_id) return [];
  return getStmts().hops.all({
    inscription_number: row.inscription_number,
    first_event_id: row.first_event_id,
    last_event_id: row.last_event_id,
  }) as BurstHop[];
}

/** Color + collection for the bursting inscription, so the digest can be
 *  matched against subscriptions exactly like a normal event. */
export function burstInscription(inscriptionNumber: number): BurstInscription | null {
  return (getStmts().inscription.get(inscriptionNumber) as BurstInscription | undefined) ?? null;
}

/** Digest delivered, but the burst is still running — mark the hops digested
 *  and let it keep accumulating. */
export function markBurstDigested(row: BurstRow, now: number): void {
  getStmts().advanceCursor.run({
    inscription_number: row.inscription_number,
    first_event_id: row.last_event_id + 1,
    now,
  });
}

/** Burst is over (quiet, or flushed by a sale). */
export function closeBurst(inscriptionNumber: number): void {
  getStmts().close.run(inscriptionNumber);
}

/** A digest send failed. Returns true once the retry budget is exhausted, at
 *  which point the caller should force the burst closed rather than re-send to
 *  healthy targets forever. */
export function recordBurstDigestFailure(row: BurstRow): boolean {
  getStmts().bumpAttempts.run({ inscription_number: row.inscription_number });
  return row.digest_attempts + 1 >= BURST_MAX_DIGEST_ATTEMPTS;
}
