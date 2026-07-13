import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let dbModule: typeof import('../src/lib/db');

const tempDir = path.join(
  os.tmpdir(),
  `omb-notify-test-${process.pid}-${Math.random().toString(36).slice(2)}`
);

const WEBHOOK_A = `https://discord.com/api/webhooks/123456789012345678/${'a'.repeat(40)}`;
const WEBHOOK_B = `https://discord.com/api/webhooks/234567890123456789/${'b'.repeat(40)}`;

type PostedWebhook = {
  url: string;
  body: { embeds?: unknown[] };
};

beforeEach(async () => {
  fs.mkdirSync(tempDir, { recursive: true });
  process.env.OMB_DB_PATH = path.join(tempDir, `t-${Math.random().toString(36).slice(2)}.db`);
  vi.resetModules();
  dbModule = await import('../src/lib/db');
});

afterEach(() => {
  vi.unstubAllGlobals();
  try {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
});

function firstOmb(): { inscription_number: number; inscription_id: string } {
  const row = dbModule
    .getDb()
    .prepare(
      `SELECT inscription_number
       FROM inscriptions
       WHERE collection_slug = 'omb'
       LIMIT 1`
    )
    .get() as { inscription_number: number };
  return {
    inscription_number: row.inscription_number,
    inscription_id: `${String(row.inscription_number).padStart(64, '0')}i0`,
  };
}

function enqueueListedEvent(
  sourceId: string,
  overrides: Partial<{ block_timestamp: number; ageSec: number }> = {}
) {
  const row = firstOmb();
  const blockTimestamp = overrides.block_timestamp ?? 1_800_000_000;
  const txid = `listed:satflow:${row.inscription_number}:id:${sourceId}`;
  dbModule.getStmts().upsertActiveListing.run({
    inscription_number: row.inscription_number,
    inscription_id: row.inscription_id,
    satflow_id: sourceId,
    price_sats: 2_200_000,
    seller: 'bc1pseller',
    marketplace: 'satflow',
    listed_at: blockTimestamp,
    refreshed_at: Math.floor(Date.now() / 1000),
  });
  const insert = dbModule.getStmts().insertListedEvent.run({
    inscription_id: row.inscription_id,
    inscription_number: row.inscription_number,
    block_timestamp: blockTimestamp,
    seller: 'bc1pseller',
    marketplace: 'satflow',
    price_sats: 2_200_000,
    txid,
  });
  const eventId = Number(insert.lastInsertRowid);
  dbModule
    .getDb()
    .prepare(`UPDATE events SET created_at = unixepoch() - ? WHERE id = ?`)
    .run(overrides.ageSec ?? 120, eventId);
  dbModule.getStmts().enqueueNotify.run(eventId);
  return eventId;
}

async function subscribeDiscordTargets(...targets: string[]) {
  const store = await import('../src/lib/subscriptionStore');
  for (const target of targets) {
    const created = store.createActive({
      channel: 'discord',
      channelTarget: target,
      kind: 'collection',
      targetKey: 'omb',
      eventMask: store.MASK_LISTED,
      creatorIp: '127.0.0.1',
    });
    expect(created.ok).toBe(true);
  }
}

describe('runNotifyFanout delivery dedupe', () => {
  it('does not resend an already-delivered event to a target while another target retries', async () => {
    const posts: PostedWebhook[] = [];
    const failuresRemaining = new Map([[WEBHOOK_B, 1]]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body ?? '{}')) as PostedWebhook['body'];
        posts.push({ url, body });

        const target = url.startsWith(WEBHOOK_B) ? WEBHOOK_B : WEBHOOK_A;
        const remaining = failuresRemaining.get(target) ?? 0;
        if (remaining > 0) {
          failuresRemaining.set(target, remaining - 1);
          return new Response('temporary', { status: 500 });
        }
        return new Response('{}', { status: 200 });
      })
    );

    await subscribeDiscordTargets(WEBHOOK_A, WEBHOOK_B);
    enqueueListedEvent('listed:satflow:test-partial');

    const { runNotifyFanout } = await import('../src/lib/notify');
    const first = await runNotifyFanout();
    expect(first.events_dequeued).toBe(0);
    expect(first.events_deferred).toBe(1);
    expect(posts.filter(p => p.url.startsWith(WEBHOOK_A))).toHaveLength(1);
    expect(posts.filter(p => p.url.startsWith(WEBHOOK_B))).toHaveLength(1);

    const savedDeliveries = dbModule
      .getDb()
      .prepare(`SELECT COUNT(*) AS n FROM notify_deliveries`)
      .get() as { n: number };
    expect(savedDeliveries.n).toBe(1);

    const second = await runNotifyFanout();
    expect(second.events_dequeued).toBe(1);
    expect(second.events_deferred).toBe(0);
    expect(posts.filter(p => p.url.startsWith(WEBHOOK_A))).toHaveLength(1);
    expect(posts.filter(p => p.url.startsWith(WEBHOOK_B))).toHaveLength(2);

    const pending = dbModule.getDb().prepare(`SELECT COUNT(*) AS n FROM notify_pending`).get() as {
      n: number;
    };
    const deliveries = dbModule
      .getDb()
      .prepare(`SELECT COUNT(*) AS n FROM notify_deliveries`)
      .get() as { n: number };
    expect(pending.n).toBe(0);
    expect(deliveries.n).toBe(0);
  });

  it('coalesces identical listed events into one rendered Discord embed', async () => {
    const posts: PostedWebhook[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        posts.push({
          url: String(input),
          body: JSON.parse(String(init?.body ?? '{}')) as PostedWebhook['body'],
        });
        return new Response('{}', { status: 200 });
      })
    );

    await subscribeDiscordTargets(WEBHOOK_A);
    enqueueListedEvent('listed:satflow:test-dupe-a', { block_timestamp: 1_800_000_000 });
    enqueueListedEvent('listed:satflow:test-dupe-b', { block_timestamp: 1_800_000_030 });

    const { runNotifyFanout } = await import('../src/lib/notify');
    const result = await runNotifyFanout();

    expect(result.events_dequeued).toBe(2);
    expect(posts).toHaveLength(1);
    expect(posts[0].body.embeds).toHaveLength(1);
  });

  it('defers fresh listed events during the listing notification grace window', async () => {
    const posts: PostedWebhook[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        posts.push({
          url: String(input),
          body: JSON.parse(String(init?.body ?? '{}')) as PostedWebhook['body'],
        });
        return new Response('{}', { status: 200 });
      })
    );

    await subscribeDiscordTargets(WEBHOOK_A);
    enqueueListedEvent('listed:satflow:test-fresh', { ageSec: 10 });

    const { runNotifyFanout } = await import('../src/lib/notify');
    const result = await runNotifyFanout();

    expect(result.events_dequeued).toBe(0);
    expect(result.events_deferred).toBe(1);
    expect(posts).toHaveLength(0);
  });

  it('drops stale listed events when the active listing has already changed', async () => {
    const posts: PostedWebhook[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        posts.push({
          url: String(input),
          body: JSON.parse(String(init?.body ?? '{}')) as PostedWebhook['body'],
        });
        return new Response('{}', { status: 200 });
      })
    );

    await subscribeDiscordTargets(WEBHOOK_A);
    enqueueListedEvent('listed:satflow:test-stale-a');
    const row = firstOmb();
    dbModule.getStmts().upsertActiveListing.run({
      inscription_number: row.inscription_number,
      inscription_id: row.inscription_id,
      satflow_id: 'listed:satflow:test-stale-a',
      price_sats: 1_900_000,
      seller: 'bc1pseller',
      marketplace: 'satflow',
      listed_at: 1_800_000_060,
      refreshed_at: Math.floor(Date.now() / 1000),
    });

    const { runNotifyFanout } = await import('../src/lib/notify');
    const result = await runNotifyFanout();

    expect(result.events_dequeued).toBe(1);
    expect(result.events_deferred).toBe(0);
    expect(posts).toHaveLength(0);
  });

  it('skips fanout while another notify run is marked running', async () => {
    const posts: PostedWebhook[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        posts.push({
          url: String(input),
          body: JSON.parse(String(init?.body ?? '{}')) as PostedWebhook['body'],
        });
        return new Response('{}', { status: 200 });
      })
    );

    await subscribeDiscordTargets(WEBHOOK_A);
    enqueueListedEvent('listed:satflow:test-running-lock');
    dbModule
      .getDb()
      .prepare(
        `UPDATE poll_state
         SET last_status = 'running', last_run_at = unixepoch()
         WHERE stream = 'notify' AND collection_slug = 'omb'`
      )
      .run();

    const { runNotifyFanout } = await import('../src/lib/notify');
    const result = await runNotifyFanout();

    expect(result.skipped).toBe('concurrent');
    expect(posts).toHaveLength(0);
    const pending = dbModule.getDb().prepare(`SELECT COUNT(*) AS n FROM notify_pending`).get() as {
      n: number;
    };
    expect(pending.n).toBe(1);
  });
});

// A "peel chain": a bot sweeping one inscription through many one-in/one-out
// hops to freshly-derived addresses. Real transfers (distinct owners each hop),
// so detection keeps them — but they must not become one push per hop.
const BURST_BASE_TS = 1_800_000_000;

function enqueueTransferEvent(n: number): number {
  const row = firstOmb();
  const insert = dbModule.getStmts().insertEvent.run({
    inscription_id: row.inscription_id,
    inscription_number: row.inscription_number,
    event_type: 'transferred',
    block_height: 957_700 + n,
    // Hops land ~15 min apart, well inside the 6h burst window.
    block_timestamp: BURST_BASE_TS + n * 900,
    new_satpoint: `${String(n).padStart(64, 'd')}:0:0`,
    old_owner: `bc1qhop${n}`,
    new_owner: `bc1qhop${n + 1}`,
    marketplace: null,
    sale_price_sats: null,
    txid: String(n).padStart(64, 'd'),
    raw_json: null,
  });
  const eventId = Number(insert.lastInsertRowid);
  dbModule
    .getDb()
    .prepare(`UPDATE events SET created_at = unixepoch() - 120 WHERE id = ?`)
    .run(eventId);
  dbModule.getStmts().enqueueNotify.run(eventId);
  return eventId;
}

function enqueueSoldEvent(n: number): number {
  const row = firstOmb();
  const insert = dbModule.getStmts().insertEvent.run({
    inscription_id: row.inscription_id,
    inscription_number: row.inscription_number,
    event_type: 'sold',
    block_height: 957_700 + n,
    block_timestamp: BURST_BASE_TS + n * 900,
    new_satpoint: `${String(n).padStart(64, 'e')}:0:0`,
    old_owner: `bc1qhop${n}`,
    new_owner: 'bc1qbuyer',
    marketplace: 'satflow',
    sale_price_sats: 2_200_000,
    txid: String(n).padStart(64, 'e'),
    raw_json: null,
  });
  const eventId = Number(insert.lastInsertRowid);
  dbModule
    .getDb()
    .prepare(`UPDATE events SET created_at = unixepoch() - 120 WHERE id = ?`)
    .run(eventId);
  dbModule.getStmts().enqueueNotify.run(eventId);
  return eventId;
}

async function subscribeDiscordTransfers(target: string) {
  const store = await import('../src/lib/subscriptionStore');
  const created = store.createActive({
    channel: 'discord',
    channelTarget: target,
    kind: 'collection',
    targetKey: 'omb',
    eventMask: store.MASK_TRANSFERRED | store.MASK_SOLD,
    creatorIp: '127.0.0.1',
  });
  expect(created.ok).toBe(true);
}

function stubOkWebhook(posts: PostedWebhook[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      posts.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? '{}')) as PostedWebhook['body'],
      });
      return new Response('{}', { status: 200 });
    })
  );
}

function countRows(table: string): number {
  return (dbModule.getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('runNotifyFanout transfer-burst coalescing', () => {
  it('alerts on the first three hops, then suppresses and still dequeues', async () => {
    const posts: PostedWebhook[] = [];
    stubOkWebhook(posts);
    await subscribeDiscordTransfers(WEBHOOK_A);

    const { runNotifyFanout } = await import('../src/lib/notify');

    // Fan-out runs every 5 min while hops land every ~15, so each hop arrives
    // in its own tick. That's exactly why coalescing has to be cross-tick.
    for (let n = 1; n <= 4; n++) {
      enqueueTransferEvent(n);
      await runNotifyFanout();
    }

    // Hops 1-3 sent individually; hop 4 tripped the burst and was suppressed.
    expect(posts).toHaveLength(3);
    expect(countRows('notify_bursts')).toBe(1);
    // The suppressed hop must not linger in the queue forever.
    expect(countRows('notify_pending')).toBe(0);

    // Further hops stay suppressed without re-running the threshold check.
    for (let n = 5; n <= 8; n++) {
      enqueueTransferEvent(n);
      await runNotifyFanout();
    }
    expect(posts).toHaveLength(3);
    expect(countRows('notify_pending')).toBe(0);
  });

  it('still alerts immediately on a sale that lands mid-burst, and flushes the digest', async () => {
    const posts: PostedWebhook[] = [];
    stubOkWebhook(posts);
    await subscribeDiscordTransfers(WEBHOOK_A);

    const { runNotifyFanout } = await import('../src/lib/notify');
    for (let n = 1; n <= 5; n++) {
      enqueueTransferEvent(n);
      await runNotifyFanout();
    }
    expect(posts).toHaveLength(3);
    expect(countRows('notify_bursts')).toBe(1);

    enqueueSoldEvent(6);
    await runNotifyFanout();

    // The sale went out, plus the digest of the hops that preceded it, and the
    // burst was closed by the flush.
    const titles = posts.flatMap(
      p => (p.body.embeds ?? []).map(e => (e as { title: string }).title) as string[]
    );
    expect(titles.some(t => t.includes('sold'))).toBe(true);
    expect(titles.some(t => t.includes('transfer burst'))).toBe(true);
    expect(countRows('notify_bursts')).toBe(0);
    expect(countRows('notify_pending')).toBe(0);
  });

  it('emits one digest and closes the burst once hops go quiet', async () => {
    const posts: PostedWebhook[] = [];
    stubOkWebhook(posts);
    await subscribeDiscordTransfers(WEBHOOK_A);

    const { runNotifyFanout } = await import('../src/lib/notify');
    for (let n = 1; n <= 6; n++) {
      enqueueTransferEvent(n);
      await runNotifyFanout();
    }
    expect(posts).toHaveLength(3);
    expect(countRows('notify_bursts')).toBe(1);

    // Age the burst past the quiet threshold — the sweep is over. This is
    // wallclock ("when did we last see a hop"), not block time.
    const { BURST_QUIET_SEC } = await import('../src/lib/notifyBurst');
    dbModule
      .getDb()
      .prepare(`UPDATE notify_bursts SET last_hop_seen_at = unixepoch() - ?`)
      .run(BURST_QUIET_SEC + 60);

    await runNotifyFanout();

    const digests = posts.flatMap(p =>
      (p.body.embeds ?? []).filter(e => (e as { title: string }).title.includes('transfer burst'))
    );
    expect(digests).toHaveLength(1);
    // Hops 4,5,6 were suppressed — the digest speaks for exactly those.
    expect((digests[0] as { fields: Array<{ name: string; value: string }> }).fields).toContainEqual(
      { name: 'Hops', value: '3', inline: true }
    );
    expect(countRows('notify_bursts')).toBe(0);
  });
});
