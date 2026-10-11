import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { refreshActivityWindow } from '../src/components/Activity/refreshActivityWindow';
import {
  mergeRevalidatedEvents,
  selectRevalidationBatch,
} from '../src/components/Activity/useActivityFeed';
import type { ApiEvent } from '../src/components/Activity/types';

const dir = mkdtempSync(path.join(tmpdir(), 'omb-pipeline-audit-'));
let storage: typeof import('../src/lib/db');
let activity: typeof import('../src/app/api/activity/route');
let health: typeof import('../src/app/api/internal/health/route');

beforeAll(async () => {
  vi.stubEnv('OMB_DB_PATH', path.join(dir, 'fresh.db'));
  storage = await import('../src/lib/db');
  activity = await import('../src/app/api/activity/route');
  health = await import('../src/app/api/internal/health/route');
  storage.getDb();
});
afterAll(() => {
  storage.getDb().close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  storage.getDb().exec('DELETE FROM events; UPDATE poll_state SET lock_until=NULL');
});

async function page(query: string) {
  return (await activity.GET(new NextRequest(`http://localhost/api/activity?${query}`))).json();
}

function seedTransfers() {
  const db = storage.getDb();
  const { inscription_number: number } = db
    .prepare("SELECT inscription_number FROM inscriptions WHERE collection_slug='omb' LIMIT 1")
    .get() as { inscription_number: number };
  const insert = db.prepare(`INSERT INTO events
    (inscription_id,inscription_number,event_type,block_timestamp,txid)
    VALUES ('audit-inscription',?,'transferred',?,?)`);
  for (let i = 0; i < 7; i++) insert.run(number, i < 4 ? 100 : 99, `audit-${i}`);
}

describe('isolated pipeline audit simulations', () => {
  it('preserves all timestamp ties across composite keyset pages', async () => {
    seedTransfers();
    let result = await page('limit=2');
    const ids: number[] = [];
    for (let safety = 0; safety < 10; safety++) {
      ids.push(...result.events.map((event: ApiEvent) => event.id));
      if (!result.next_cursor) break;
      result = await page(`limit=2&cursor=${result.next_cursor}`);
    }
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
  });

  it('removes a transfer after sale enrichment while keeping older loaded transfers', async () => {
    seedTransfers();
    const before = await page('type=transfers');
    const enriched = before.events[0] as ApiEvent;
    storage
      .getDb()
      .prepare("UPDATE events SET event_type='sold',sale_price_sats=100 WHERE id=?")
      .run(enriched.id);
    const after = await page('type=transfers');
    expect(after.events.some((event: ApiEvent) => event.id === enriched.id)).toBe(false);
    const refreshed = await refreshActivityWindow(before.events, cursor =>
      page(`type=transfers&limit=2&refresh=1${cursor ? `&cursor=${cursor}` : ''}`)
    );
    const selection = selectRevalidationBatch(before.events, 0);
    const revalidated = await page(`type=transfers&ids=${selection.ids.join(',')}`);
    const reconciled = mergeRevalidatedEvents(refreshed.events, selection.ids, revalidated.events);
    expect(reconciled.some(event => event.id === enriched.id)).toBe(false);
    expect(reconciled.map(event => event.id)).toEqual(
      after.events.map((event: ApiEvent) => event.id)
    );
  });

  it('fills a burst gap and resumes pagination from the refreshed window without losing rows', async () => {
    seedTransfers();
    const initial = await page('limit=2');
    expect(initial.next_cursor).not.toBeNull();
    const db = storage.getDb();
    const number = initial.events[0].inscription_number;
    const insert = db.prepare(`INSERT INTO events
      (inscription_id,inscription_number,event_type,block_timestamp,txid)
      VALUES ('audit-inscription',?,'transferred',?,?)`);
    for (let i = 0; i < 5; i++) insert.run(number, 200 + i, `new-audit-${i}`);
    const refreshed = await refreshActivityWindow(
      initial.events,
      cursor => page(`limit=2&refresh=1${cursor ? `&cursor=${cursor}` : ''}`),
      initial.next_cursor
    );
    const continuation = refreshed.next_cursor
      ? await page(`limit=100&cursor=${refreshed.next_cursor}`)
      : { events: [] };
    const rendered = [...refreshed.events, ...continuation.events];
    expect(rendered.filter(event => event.txid.startsWith('new-audit-'))).toHaveLength(5);
    expect(rendered).toHaveLength(12);
    expect(new Set(rendered.map(event => event.id)).size).toBe(12);
  });

  it('does not cache authoritative refresh pages', async () => {
    const response = await activity.GET(new NextRequest('http://localhost/api/activity?refresh=1'));
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('releases successful poll leases immediately and recovers expired leases', () => {
    const stmts = storage.getStmts();
    const key = { stream: 'satflow', collection: 'omb' };
    expect(stmts.acquireLock.run(key).changes).toBe(1);
    expect(stmts.acquireLock.run(key).changes).toBe(0);
    stmts.setPollResult.run({ ...key, status: 'ok', event_count: 0, cursor: null });
    expect(stmts.acquireLock.run(key).changes).toBe(1);
    storage
      .getDb()
      .prepare("UPDATE poll_state SET lock_until=unixepoch()-1 WHERE stream='satflow'")
      .run();
    expect(stmts.acquireLock.run(key).changes).toBe(1);
  });

  it('rolls healthy, stale, failed and lagged streams into expected health states', async () => {
    const db = storage.getDb();
    db.exec(
      "UPDATE poll_state SET last_run_at=unixepoch(),last_status='idle',last_known_height=NULL"
    );
    expect((await (await health.GET()).json()).status).toBe('ok');
    db.exec("UPDATE poll_state SET last_status='RPC failed' WHERE stream='ord'");
    expect((await (await health.GET()).json()).status).toBe('warn');
    db.exec(
      "UPDATE poll_state SET last_status='ok',last_run_at=unixepoch()-601 WHERE stream='ord'"
    );
    expect((await (await health.GET()).json()).status).toBe('degraded');
    db.exec(
      "UPDATE poll_state SET last_run_at=unixepoch(),last_known_height=100 WHERE stream='ord'"
    );
    storage.setOrdState({ bitcoindTip: 1200 });
    expect((await (await health.GET()).json()).status).toBe('degraded');
  });
});
