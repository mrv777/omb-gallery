import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import type { Statement } from 'better-sqlite3';
import { getDb } from './db';

// Notification subscription store. Prepared statements live here so this
// module can be hot-reloaded in dev without rebuilding the global Stmts in db.ts.

export type Channel = 'telegram' | 'discord';
export type SubKind = 'inscription' | 'color' | 'collection';
export type SubStatus = 'pending' | 'active' | 'muted' | 'failed';

// event_mask bits
export const MASK_TRANSFERRED = 1;
export const MASK_SOLD = 2;
export const MASK_LISTED = 4; // reserved; not yet emitted

export type SubscriptionRow = {
  id: number;
  channel: Channel;
  channel_target: string;
  kind: SubKind;
  target_key: string;
  event_mask: number;
  unsub_token: string;
  status: SubStatus;
  claim_token: string | null;
  claim_expires_at: number | null;
  creator_ip: string;
  created_at: number;
  last_sent_at: number | null;
  fail_count: number;
};

const PER_TARGET_CAP = 50;
const PENDING_TTL_SEC = 60 * 60; // 1 hour

type Stmts = {
  insertActive: Statement;
  insertPending: Statement;
  promotePending: Statement;
  countByTarget: Statement;
  getById: Statement;
  getByUnsubToken: Statement;
  getByClaimToken: Statement;
  listByTarget: Statement;
  setStatus: Statement;
  setStatusForTarget: Statement;
  bumpFailCount: Statement;
  resetFailCount: Statement;
  markSent: Statement;
  cleanupPending: Statement;
  clearStaleActiveClaimTokens: Statement;
  clearClaimTokenById: Statement;
  matchesForEvent: Statement;
  findExistingForTarget: Statement;
  mergeExistingFromPending: Statement;
  deleteSubById: Statement;
  getExistingToken: Statement;
};

let stmts: Stmts | null = null;

function getStmts(): Stmts {
  if (stmts) return stmts;
  const db = getDb();
  stmts = {
    insertActive: db.prepare(`
      INSERT INTO subscriptions (
        channel, channel_target, kind, target_key, event_mask,
        unsub_token, status, creator_ip, created_at
      ) VALUES (
        @channel, @channel_target, @kind, @target_key, @event_mask,
        @unsub_token, 'active', @creator_ip, @created_at
      )
      ON CONFLICT(channel, channel_target, kind, target_key) DO UPDATE SET
        status     = 'active',
        event_mask = excluded.event_mask,
        fail_count = 0
      RETURNING *
    `),

    findExistingForTarget: db.prepare(`
      SELECT * FROM subscriptions
      WHERE channel = @channel AND channel_target = @channel_target
        AND kind = @kind AND target_key = @target_key
    `),

    mergeExistingFromPending: db.prepare(`
      UPDATE subscriptions
      SET status      = 'active',
          claim_token = @claim_token,
          fail_count  = 0,
          event_mask  = (event_mask | @event_mask)
      WHERE id = @id
      RETURNING *
    `),

    deleteSubById: db.prepare(`DELETE FROM subscriptions WHERE id = ?`),

    getExistingToken: db.prepare(`
      SELECT unsub_token FROM subscriptions
      WHERE channel = @channel AND channel_target = @channel_target
        AND kind = @kind AND target_key = @target_key
    `),

    insertPending: db.prepare(`
      INSERT INTO subscriptions (
        channel, channel_target, kind, target_key, event_mask,
        unsub_token, status, claim_token, claim_expires_at, creator_ip, created_at
      ) VALUES (
        @channel, @channel_target, @kind, @target_key, @event_mask,
        @unsub_token, 'pending', @claim_token, @claim_expires_at, @creator_ip, @created_at
      )
      RETURNING *
    `),

    // On /start, bind the pending row to the real chat_id and flip to active.
    // Keep claim_token set — the source tab is still polling /api/subscribe/status
    // by that token to mint the session cookie. The status endpoint clears it
    // (clearClaimToken) once observed. claim_expires_at also stays in place so
    // the cleanupPending sweep eventually GCs unobserved active rows' tokens.
    promotePending: db.prepare(`
      UPDATE subscriptions
      SET channel_target   = @chat_id,
          status           = 'active',
          fail_count       = 0
      WHERE claim_token = @claim_token
        AND status      = 'pending'
        AND (claim_expires_at IS NULL OR claim_expires_at >= @now)
      RETURNING *
    `),

    countByTarget: db.prepare(`
      SELECT COUNT(*) AS n FROM subscriptions
      WHERE channel = @channel
        AND channel_target = @channel_target
        AND status IN ('active','pending')
    `),

    getById: db.prepare(`SELECT * FROM subscriptions WHERE id = ?`),

    getByUnsubToken: db.prepare(`SELECT * FROM subscriptions WHERE unsub_token = ?`),

    getByClaimToken: db.prepare(`SELECT * FROM subscriptions WHERE claim_token = ?`),

    listByTarget: db.prepare(`
      SELECT * FROM subscriptions
      WHERE channel = @channel
        AND channel_target = @channel_target
        AND status IN ('active','muted','failed')
      ORDER BY created_at DESC
    `),

    setStatus: db.prepare(`UPDATE subscriptions SET status = @status WHERE id = @id`),

    setStatusForTarget: db.prepare(`
      UPDATE subscriptions SET status = @status
      WHERE channel = @channel AND channel_target = @channel_target
        AND status IN ('active','pending','muted')
    `),

    bumpFailCount: db.prepare(`
      UPDATE subscriptions
      SET fail_count = fail_count + 1
      WHERE channel = @channel AND channel_target = @channel_target
    `),

    resetFailCount: db.prepare(`
      UPDATE subscriptions SET fail_count = 0
      WHERE channel = @channel AND channel_target = @channel_target
    `),

    markSent: db.prepare(`
      UPDATE subscriptions SET last_sent_at = @ts
      WHERE channel = @channel AND channel_target = @channel_target
    `),

    cleanupPending: db.prepare(`
      DELETE FROM subscriptions
      WHERE status = 'pending' AND claim_expires_at < @now
    `),

    // Backstop: if the source tab never polled /api/subscribe/status (closed
    // before the claim came through), the active row keeps claim_token+expiry
    // forever. Sweep them once they're past their expiry — by then the
    // subscription is in /notifications and the unsub link in Telegram is the
    // management surface.
    clearStaleActiveClaimTokens: db.prepare(`
      UPDATE subscriptions
      SET claim_token = NULL, claim_expires_at = NULL
      WHERE status = 'active' AND claim_token IS NOT NULL AND claim_expires_at < @now
    `),

    clearClaimTokenById: db.prepare(`
      UPDATE subscriptions
      SET claim_token = NULL, claim_expires_at = NULL
      WHERE id = ?
    `),

    // Resolve all subs that match an event. Caller passes inscription_number,
    // color, and collection slug for the event; we fan out across all three
    // index-backed lookups and return distinct rows. event_mask & @bit ensures
    // the subscriber asked for THIS kind of event.
    matchesForEvent: db.prepare(`
      SELECT * FROM subscriptions
      WHERE status = 'active'
        AND (event_mask & @bit) != 0
        AND (
          (kind = 'inscription' AND target_key = @inscription_number_str)
          OR (kind = 'color'      AND target_key = @color)
          OR (kind = 'collection' AND target_key = @collection)
        )
    `),
  };
  return stmts;
}

function newToken(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

export function hashTarget(channelTarget: string): string {
  return createHash('sha256').update(channelTarget).digest('hex').slice(0, 16);
}

export type CreateArgs = {
  channel: Channel;
  channelTarget: string;
  kind: SubKind;
  targetKey: string;
  eventMask: number;
  creatorIp: string;
  /** Optional pre-generated unsub token. Caller can ping the channel with this
   *  token in confirmation links BEFORE persisting the row, so a failed ping
   *  doesn't leave an orphan. On UPSERT conflict the existing row's token is
   *  preserved (we never clobber pre-existing unsub links). */
  unsubToken?: string;
};

export type CreateResult =
  | { ok: true; row: SubscriptionRow }
  | { ok: false; error: 'cap-exceeded' };

export function createActive(args: CreateArgs): CreateResult {
  const s = getStmts();
  // Cap is checked only when this would CREATE a new row. An UPSERT on an
  // existing (channel, target, kind, target_key) tuple is just reactivating
  // the same row — counting it again would block legitimate re-subscribes.
  const existing = s.findExistingForTarget.get({
    channel: args.channel,
    channel_target: args.channelTarget,
    kind: args.kind,
    target_key: args.targetKey,
  }) as SubscriptionRow | undefined;
  if (!existing) {
    const count = s.countByTarget.get({
      channel: args.channel,
      channel_target: args.channelTarget,
    }) as { n: number };
    if (count.n >= PER_TARGET_CAP) return { ok: false, error: 'cap-exceeded' };
  }

  const row = s.insertActive.get({
    channel: args.channel,
    channel_target: args.channelTarget,
    kind: args.kind,
    target_key: args.targetKey,
    event_mask: args.eventMask,
    unsub_token: args.unsubToken ?? newToken(16),
    creator_ip: args.creatorIp,
    created_at: Math.floor(Date.now() / 1000),
  }) as SubscriptionRow;
  return { ok: true, row };
}

/** Returns the existing unsub_token for a (channel, target, kind, target_key)
 *  tuple, or null if no row exists. Lets the route preserve previously-issued
 *  unsub links when the user re-subscribes from the same channel target. */
export function getExistingUnsubToken(
  channel: Channel,
  channelTarget: string,
  kind: SubKind,
  targetKey: string
): string | null {
  const row = getStmts().getExistingToken.get({
    channel,
    channel_target: channelTarget,
    kind,
    target_key: targetKey,
  }) as { unsub_token: string } | undefined;
  return row?.unsub_token ?? null;
}

export type CreatePendingArgs = Omit<CreateArgs, 'channelTarget'> & { placeholderTarget?: string };

export function createPending(args: CreatePendingArgs): { row: SubscriptionRow; claimToken: string } {
  const s = getStmts();
  const claimToken = newToken(16);
  const now = Math.floor(Date.now() / 1000);
  // For pending Telegram subs, channel_target is unknown until /start arrives.
  // Use a placeholder that's distinct per pending row so the UNIQUE constraint
  // doesn't collide with another user pending-watching the same target.
  const placeholder = args.placeholderTarget ?? `pending:${claimToken}`;
  const row = s.insertPending.get({
    channel: args.channel,
    channel_target: placeholder,
    kind: args.kind,
    target_key: args.targetKey,
    event_mask: args.eventMask,
    unsub_token: newToken(16),
    claim_token: claimToken,
    claim_expires_at: now + PENDING_TTL_SEC,
    creator_ip: args.creatorIp,
    created_at: now,
  }) as SubscriptionRow;
  return { row, claimToken };
}

export type ClaimOutcome =
  | { ok: true; row: SubscriptionRow }
  | { ok: false; reason: 'unknown' | 'expired' | 'cap-exceeded' };

/** Promote a pending Telegram claim to active, binding it to the real chat_id.
 *  Handles three edge cases the naive UPDATE doesn't:
 *    1. Pending row missing/expired → returns 'unknown'/'expired' (caller can
 *       send a useful Telegram reply instead of silently logging).
 *    2. The chat already has an ACTIVE row for the same (kind, target_key) →
 *       UNIQUE(channel, channel_target, kind, target_key) would throw; we
 *       merge instead: delete the pending row, re-attach the claim_token to
 *       the existing row (so /api/subscribe/status still mints a session),
 *       union the event_mask, reset fail_count.
 *    3. Promoting would push the chat over PER_TARGET_CAP → returns
 *       'cap-exceeded' so the bot can tell the user to /unwatch first. */
export function claimByToken(claimToken: string, chatId: string): ClaimOutcome {
  const s = getStmts();
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const pending = s.getByClaimToken.get(claimToken) as SubscriptionRow | undefined;
  if (!pending || pending.status !== 'pending') return { ok: false, reason: 'unknown' };
  if (pending.claim_expires_at != null && pending.claim_expires_at < now) {
    return { ok: false, reason: 'expired' };
  }

  // Case 2: existing row for same (chatId, kind, target_key) — merge.
  const dup = s.findExistingForTarget.get({
    channel: 'telegram',
    channel_target: chatId,
    kind: pending.kind,
    target_key: pending.target_key,
  }) as SubscriptionRow | undefined;

  if (dup) {
    const tx = db.transaction(() => {
      s.deleteSubById.run(pending.id);
      return s.mergeExistingFromPending.get({
        id: dup.id,
        claim_token: claimToken,
        event_mask: pending.event_mask,
      }) as SubscriptionRow;
    });
    return { ok: true, row: tx() };
  }

  // Case 3: cap check before creating a NEW slot.
  const count = s.countByTarget.get({
    channel: 'telegram',
    channel_target: chatId,
  }) as { n: number };
  // Pending row doesn't have the real chat_id, so it's not in `count`. Once
  // we promote it'd be the (count+1)th row.
  if (count.n >= PER_TARGET_CAP) {
    s.deleteSubById.run(pending.id);
    return { ok: false, reason: 'cap-exceeded' };
  }

  const row = s.promotePending.get({
    claim_token: claimToken,
    chat_id: chatId,
    now,
  }) as SubscriptionRow | undefined;
  if (!row) return { ok: false, reason: 'unknown' };
  return { ok: true, row };
}

export function findByClaimToken(claimToken: string): SubscriptionRow | null {
  return (getStmts().getByClaimToken.get(claimToken) as SubscriptionRow | undefined) ?? null;
}

export function findByUnsubToken(token: string): SubscriptionRow | null {
  return (getStmts().getByUnsubToken.get(token) as SubscriptionRow | undefined) ?? null;
}

export function listByTarget(channel: Channel, channelTarget: string): SubscriptionRow[] {
  return getStmts().listByTarget.all({ channel, channel_target: channelTarget }) as SubscriptionRow[];
}

export function setStatus(id: number, status: SubStatus): void {
  getStmts().setStatus.run({ id, status });
}

export function muteAllForTarget(channel: Channel, channelTarget: string): number {
  const r = getStmts().setStatusForTarget.run({
    channel,
    channel_target: channelTarget,
    status: 'failed',
  });
  return r.changes ?? 0;
}

export function findMatchesForEvent(input: {
  inscriptionNumber: number;
  color: string | null;
  collectionSlug: string;
  eventBit: number;
}): SubscriptionRow[] {
  return getStmts().matchesForEvent.all({
    bit: input.eventBit,
    inscription_number_str: String(input.inscriptionNumber),
    color: input.color ?? '__no_color__',
    collection: input.collectionSlug,
  }) as SubscriptionRow[];
}

export function recordDeliveryFailure(channel: Channel, channelTarget: string, dead: boolean): void {
  const s = getStmts();
  if (dead) {
    s.setStatusForTarget.run({ channel, channel_target: channelTarget, status: 'failed' });
    return;
  }
  s.bumpFailCount.run({ channel, channel_target: channelTarget });
  // After 3 strikes, mark all subs for this target as failed. Done here as a
  // separate query so the bump is atomic in the row sense.
  const row = getStmts().listByTarget.all({ channel, channel_target: channelTarget }) as SubscriptionRow[];
  if (row.length && row[0].fail_count >= 3) {
    s.setStatusForTarget.run({ channel, channel_target: channelTarget, status: 'failed' });
  }
}

export function recordDeliverySuccess(channel: Channel, channelTarget: string): void {
  const s = getStmts();
  s.resetFailCount.run({ channel, channel_target: channelTarget });
  s.markSent.run({ channel, channel_target: channelTarget, ts: Math.floor(Date.now() / 1000) });
}

export function cleanupExpiredPending(): number {
  const now = Math.floor(Date.now() / 1000);
  const s = getStmts();
  const deleted = s.cleanupPending.run({ now }).changes ?? 0;
  s.clearStaleActiveClaimTokens.run({ now });
  return deleted;
}

/** Clears claim_token + claim_expires_at on an active row. Called by the
 *  status endpoint after the source tab observes the claim, so the token
 *  stops being a long-lived bearer that grants unsub_token visibility. */
export function clearClaimToken(id: number): void {
  getStmts().clearClaimTokenById.run(id);
}

/** Reset fail_count for every row sharing this channel target. Used when the
 *  user un-mutes a `failed` row from /notifications — fail tracking is
 *  per-target (bumpFailCount has no row filter), so without this the next
 *  transient delivery hiccup re-fails the row immediately. */
export function resetTargetFailCount(channel: Channel, channelTarget: string): void {
  getStmts().resetFailCount.run({ channel, channel_target: channelTarget });
}

export const PENDING_TTL_SECONDS = PENDING_TTL_SEC;
export const PER_TARGET_LIMIT = PER_TARGET_CAP;
