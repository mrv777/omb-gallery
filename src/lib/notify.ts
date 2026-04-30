import 'server-only';
import { getDb, getStmts } from './db';
import { lookupInscription } from './inscriptionLookup';
import { log } from './log';
import { sendMessage, escapeHtml, type SendArgs } from './telegram';
import { postWebhook, type DiscordEmbed } from './discord';
import { satflowInscriptionLink } from './format';
import {
  cleanupExpiredPending,
  findMatchesForEvent,
  recordDeliveryFailure,
  recordDeliverySuccess,
  hashTarget,
  MASK_TRANSFERRED,
  MASK_SOLD,
  MASK_LISTED,
  type SubscriptionRow,
} from './subscriptionStore';

type EventRow = {
  id: number;
  event_type: 'inscribed' | 'transferred' | 'sold' | 'listed';
  inscription_id: string;
  inscription_number: number;
  block_timestamp: number;
  marketplace: string | null;
  sale_price_sats: number | null;
  new_owner: string | null;
  old_owner: string | null;
  txid: string;
  color: string | null;
  collection_slug: string | null;
};

const PER_TICK_LIMIT = 1000;
const STREAM = 'notify';
const COLLECTION = 'omb';

// Per-recipient cap. Each bucket maps to one outbound message; capping events
// at 10 keeps Discord embeds within the 10-per-message API limit and Telegram
// HTML well under the 4096-char message limit (~120 chars per event line).
// Excess events stay in notify_pending → next tick → next message. Users in
// catch-up scenarios get N/10 messages over N ticks instead of one truncated
// message that silently drops events.
const MAX_EVENTS_PER_BUCKET = 10;

// Fanout shares the 30s cron budget with ord/satflow/listings. Cap our
// wallclock at 8s and dispatch buckets concurrently so a handful of slow
// targets don't push the whole tick over the cron deadline. With 4s per-call
// timeouts and concurrency 8, a single batch of 8 dead targets resolves in
// ≤4s; a tick processes ~16 buckets in the worst case before bailing out.
const FANOUT_BUDGET_MS = 8_000;
const FANOUT_CONCURRENCY = 8;

function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || 'https://ordinalmaxibiz.wiki').replace(/\/$/, '');
}

function colorHex(color: string | null): number {
  switch (color) {
    case 'red': return 0xff5544;
    case 'blue': return 0x4488ff;
    case 'green': return 0x44cc77;
    case 'orange': return 0xff9933;
    case 'black': return 0x222222;
    default: return 0x888888;
  }
}

function eventBit(t: EventRow['event_type']): number {
  if (t === 'sold') return MASK_SOLD;
  if (t === 'transferred') return MASK_TRANSFERRED;
  if (t === 'listed') return MASK_LISTED;
  return 0;
}

function actionLabel(t: EventRow['event_type']): { upper: string; lower: string; emoji: string } {
  if (t === 'sold') return { upper: 'SOLD', lower: 'sold', emoji: '💰' };
  if (t === 'listed') return { upper: 'LISTED', lower: 'listed', emoji: '🏷️' };
  return { upper: 'TRANSFERRED', lower: 'transferred', emoji: '🔄' };
}

function truncAddr(a: string | null): string {
  if (!a) return '?';
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function formatBtc(sats: number | null): string {
  if (!sats || sats <= 0) return '';
  return `${(sats / 1e8).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')} BTC`;
}

function ordinalsUrl(inscriptionNumber: number): string {
  return `https://ordinals.com/inscription/${inscriptionNumber}`;
}

// Marketplace-aware link for sold/listed events. Transfers always go to
// ordinals.com (no marketplace context). Add a branch here when a new
// marketplace ships its sales/listings into the events table.
function eventLinkUrl(ev: EventRow): string {
  if (ev.event_type === 'sold' || ev.event_type === 'listed') {
    if (ev.marketplace === 'satflow') {
      const url = satflowInscriptionLink(ev.inscription_id);
      if (url) return url;
    }
  }
  return ordinalsUrl(ev.inscription_number);
}

function buildTelegramMessage(events: EventRow[], sub: SubscriptionRow): SendArgs {
  const isOne = events.length === 1;
  const lines: string[] = [];
  for (const ev of events) {
    const { upper, emoji } = actionLabel(ev.event_type);
    const price = formatBtc(ev.sale_price_sats);
    const market = ev.marketplace ? ` on ${escapeHtml(ev.marketplace)}` : '';
    // 'listed' has price but no buyer — phrase as "for X on Y" same as sold.
    // 'transferred' has neither price nor marketplace.
    const priceStr = price ? ` for <b>${escapeHtml(price)}</b>${market}` : '';
    const link = `<a href="${eventLinkUrl(ev)}">OMB #${ev.inscription_number}</a>`;
    const colorTag = ev.color ? ` <i>(${escapeHtml(ev.color)})</i>` : '';
    // Listed events show only the seller; no recipient yet.
    const movement =
      ev.event_type === 'listed'
        ? `by ${escapeHtml(truncAddr(ev.old_owner))}`
        : `${escapeHtml(truncAddr(ev.old_owner))} → ${escapeHtml(truncAddr(ev.new_owner))}`;
    lines.push(`${emoji} ${link}${colorTag} <b>${upper}</b>${priceStr}\n   ${movement}`);
  }
  let header = '';
  if (sub.kind === 'inscription') {
    header = `Watch on OMB #${sub.target_key}`;
  } else if (sub.kind === 'color') {
    header = `Watch on ${sub.target_key} OMBs`;
  } else if (sub.kind === 'collection') {
    header = `Watch on all OMB activity`;
  }
  const text = isOne
    ? lines.join('\n')
    : `<b>${escapeHtml(header)}</b> — ${events.length} events\n\n${lines.join('\n\n')}`;

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: 'View latest', url: eventLinkUrl(events[events.length - 1]) },
        { text: 'Mute this watch', callback_data: `mute:${sub.id}` },
      ],
    ],
  };
  return {
    chatId: sub.channel_target,
    text,
    parseMode: 'HTML',
    disablePreview: true,
    replyMarkup,
  };
}

function buildDiscordEmbeds(events: EventRow[], sub: SubscriptionRow): DiscordEmbed[] {
  // Bucket is already capped at 10 events upstream; no slice needed here.
  return events.map(ev => {
    const lookup = lookupInscription(ev.inscription_number);
    const { lower } = actionLabel(ev.event_type);
    const price = formatBtc(ev.sale_price_sats);
    const market = ev.marketplace ?? '';
    const titleBits: string[] = [`OMB #${ev.inscription_number} ${lower}`];
    if (price) titleBits.push(`for ${price}`);
    if (market) titleBits.push(`on ${market}`);
    const fields: DiscordEmbed['fields'] = [];
    if (ev.color) fields.push({ name: 'Color', value: ev.color, inline: true });
    if (ev.event_type === 'listed') {
      // Listings have no recipient — show seller only.
      fields.push({ name: 'Seller', value: truncAddr(ev.old_owner), inline: true });
    } else {
      fields.push({ name: 'From', value: truncAddr(ev.old_owner), inline: true });
      fields.push({ name: 'To', value: truncAddr(ev.new_owner), inline: true });
    }
    // Listed events use a synthetic txid like "listed:<num>:<ts>"; truncating
    // the synthetic prefix to 10 chars renders fine alongside real txids.
    return {
      title: titleBits.join(' '),
      url: eventLinkUrl(ev),
      color: colorHex(ev.color),
      thumbnail: lookup ? { url: `${siteUrl()}${lookup.thumbnail}` } : undefined,
      fields,
      footer: { text: `${sub.kind === 'collection' ? 'all OMB' : sub.kind === 'color' ? `${sub.target_key} OMBs` : `OMB #${sub.target_key}`} · tx ${ev.txid.slice(0, 10)}…` },
      timestamp: new Date(ev.block_timestamp * 1000).toISOString(),
    };
  });
}

type FanoutResult = {
  mode: 'notify';
  events_processed: number;
  recipients: number;
  delivered: number;
  failed: number;
  events_dequeued: number;
  events_deferred: number;
  dur_ms: number;
};

type Bucket = {
  channel: SubscriptionRow['channel'];
  channelTarget: string;
  representative: SubscriptionRow;
  events: EventRow[];
  /** Per-bucket dedupe set so a recipient watching e.g. both
   *  collection + inscription doesn't get the same event listed twice. */
  eventIds: Set<number>;
};

export async function runNotifyFanout(): Promise<FanoutResult> {
  const startedAt = Date.now();
  const db = getDb();

  const events = getStmts().selectNotifyQueueBatch.all(PER_TICK_LIMIT) as EventRow[];

  if (events.length === 0) {
    db.prepare(
      `UPDATE poll_state SET last_run_at = unixepoch(), last_status = 'ok', last_event_count = 0
       WHERE stream = ? AND collection_slug = ?`
    ).run(STREAM, COLLECTION);
    cleanupExpiredPending();
    return {
      mode: 'notify',
      events_processed: 0,
      recipients: 0,
      delivered: 0,
      failed: 0,
      events_dequeued: 0,
      events_deferred: 0,
      dur_ms: Date.now() - startedAt,
    };
  }

  // Per-event tracking: which buckets WANTED this event (regardless of
  // whether the bucket cap let us include it this tick), and whether each
  // wanting bucket actually delivered. We dequeue an event only when every
  // wanting bucket confirmed delivery — capped-out events stay in the queue.
  const buckets = new Map<string, Bucket>();
  const eventToWantingBuckets = new Map<number, Set<string>>();

  for (const ev of events) {
    const bit = eventBit(ev.event_type);
    if (bit === 0) continue;
    const matches = findMatchesForEvent({
      inscriptionNumber: ev.inscription_number,
      color: ev.color,
      collectionSlug: ev.collection_slug ?? COLLECTION,
      eventBit: bit,
    });
    if (matches.length === 0) {
      // No active subscriber wants this event. Mark it with an empty wanting
      // set so the dequeue logic drops it (don't leave orphaned queue rows).
      eventToWantingBuckets.set(ev.id, new Set());
      continue;
    }
    const wanting = new Set<string>();
    for (const sub of matches) {
      const key = `${sub.channel}:${sub.channel_target}`;
      wanting.add(key);
      let b = buckets.get(key);
      if (!b) {
        b = {
          channel: sub.channel,
          channelTarget: sub.channel_target,
          representative: sub,
          events: [],
          eventIds: new Set(),
        };
        buckets.set(key, b);
      }
      // Per-bucket dedupe (overlapping watches: same target subscribes to
      // both collection + inscription, etc.).
      if (b.eventIds.has(ev.id)) continue;
      // Cap: leftover events stay in queue → next tick → next message.
      if (b.events.length >= MAX_EVENTS_PER_BUCKET) continue;
      b.eventIds.add(ev.id);
      b.events.push(ev);
    }
    eventToWantingBuckets.set(ev.id, wanting);
  }

  // Dispatch returns the set of event ids actually delivered to this bucket.
  // (Currently every bucket sends exactly one message containing all its
  //  capped events, so on success the whole bucket is delivered; on failure,
  //  none of it is. Returning a Set keeps the per-event reconciliation
  //  algorithm below straightforward if we ever chunk per-bucket later.)
  const dispatch = async (bucket: Bucket): Promise<Set<number>> => {
    const allIds = new Set(bucket.eventIds);
    if (bucket.channel === 'telegram') {
      const args = buildTelegramMessage(bucket.events, bucket.representative);
      const r = await sendMessage(args);
      if (r.ok) {
        recordDeliverySuccess(bucket.channel, bucket.channelTarget);
        return allIds;
      }
      const dead = r.error.kind === 'blocked';
      recordDeliveryFailure(bucket.channel, bucket.channelTarget, dead);
      log.warn('notify/telegram', 'send failed', { target: hashTarget(bucket.channelTarget), error: r.error });
      return new Set();
    }
    const embeds = buildDiscordEmbeds(bucket.events, bucket.representative);
    const r = await postWebhook(bucket.channelTarget, { embeds });
    if (r.ok) {
      recordDeliverySuccess(bucket.channel, bucket.channelTarget);
      return allIds;
    }
    const dead = r.error.kind === 'dead' || r.error.kind === 'invalid-url';
    recordDeliveryFailure(bucket.channel, bucket.channelTarget, dead);
    log.warn('notify/discord', 'post failed', { target: hashTarget(bucket.channelTarget), error: r.error });
    return new Set();
  };

  const items = Array.from(buckets.values());
  let delivered = 0;
  let failed = 0;
  let allAttempted = true;
  // bucketKey → set of event ids that were actually delivered in this tick.
  const bucketDelivered = new Map<string, Set<number>>();
  // Buckets that didn't get to dispatch this tick (budget hit). For events
  // routed to those buckets, we must NOT dequeue — next tick re-processes.
  const skippedBuckets = new Set<string>();

  for (let i = 0; i < items.length; i += FANOUT_CONCURRENCY) {
    if (Date.now() - startedAt > FANOUT_BUDGET_MS) {
      allAttempted = false;
      for (let j = i; j < items.length; j++) {
        const k = `${items[j].channel}:${items[j].channelTarget}`;
        skippedBuckets.add(k);
      }
      log.warn('notify', 'wallclock budget exceeded — deferring', {
        attempted: i,
        deferred: items.length - i,
      });
      break;
    }
    const batch = items.slice(i, i + FANOUT_CONCURRENCY);
    const results = await Promise.allSettled(batch.map(dispatch));
    for (let k = 0; k < batch.length; k++) {
      const r = results[k];
      const key = `${batch[k].channel}:${batch[k].channelTarget}`;
      if (r.status === 'fulfilled' && r.value.size > 0) {
        bucketDelivered.set(key, r.value);
        delivered++;
      } else {
        bucketDelivered.set(key, new Set());
        failed++;
      }
    }
  }

  // Reconcile: dequeue an event id iff EVERY wanting bucket either delivered
  // it or had no recipients at all. A capped-out event (in wanting set but
  // not in bucket.events) stays queued because its bucket's delivered set
  // won't contain it.
  const toDequeue: number[] = [];
  let deferred = 0;
  for (const [eventId, wanting] of Array.from(eventToWantingBuckets.entries())) {
    if (wanting.size === 0) {
      // No matching subs → safe to drop. Avoids growing the queue forever
      // when events stream in but nobody is subscribed.
      toDequeue.push(eventId);
      continue;
    }
    let allConfirmed = true;
    for (const key of Array.from(wanting)) {
      if (skippedBuckets.has(key)) {
        allConfirmed = false;
        break;
      }
      const dl = bucketDelivered.get(key);
      if (!dl || !dl.has(eventId)) {
        allConfirmed = false;
        break;
      }
    }
    if (allConfirmed) toDequeue.push(eventId);
    else deferred++;
  }

  if (toDequeue.length > 0) {
    // Build a parameterized DELETE for the dequeue batch. SQLite handles
    // 1000-element IN-lists comfortably; we cap at PER_TICK_LIMIT upstream.
    const placeholders = toDequeue.map(() => '?').join(',');
    db.prepare(`DELETE FROM notify_pending WHERE event_id IN (${placeholders})`).run(...toDequeue);
  }

  const lastStatus = !allAttempted ? 'deferred' : failed > 0 ? 'partial' : 'ok';
  // Track the highest dequeued event id in last_cursor for diagnostics only;
  // the queue table is the source of truth for "what's pending".
  const newCursor = toDequeue.length > 0 ? Math.max(...toDequeue) : null;
  db.prepare(
    `UPDATE poll_state
     SET last_cursor = COALESCE(?, last_cursor),
         last_run_at = unixepoch(),
         last_status = ?,
         last_event_count = ?
     WHERE stream = ? AND collection_slug = ?`
  ).run(newCursor != null ? String(newCursor) : null, lastStatus, delivered, STREAM, COLLECTION);

  cleanupExpiredPending();

  log.info('notify', 'fanout complete', {
    events: events.length,
    recipients: buckets.size,
    delivered,
    failed,
    dequeued: toDequeue.length,
    deferred,
    attempted_all: allAttempted,
    dur_ms: Date.now() - startedAt,
  });

  return {
    mode: 'notify',
    events_processed: events.length,
    recipients: buckets.size,
    delivered,
    failed,
    events_dequeued: toDequeue.length,
    events_deferred: deferred,
    dur_ms: Date.now() - startedAt,
  };
}
