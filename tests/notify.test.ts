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
