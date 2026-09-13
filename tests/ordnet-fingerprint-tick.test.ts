import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fixtures from './chain-fixtures/ordnet-settlements.json';
import type { FingerprintTx } from '../src/lib/marketplaceFingerprint';

const rpc = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../src/lib/bitcoind', () => ({
  bitcoindConfigured: () => true,
  getRawTransaction: rpc.get,
}));
const txs: Record<string, FingerprintTx> = fixtures.txs;
let dbModule: typeof import('../src/lib/db');
let tick: typeof import('../src/lib/ordNetFingerprintTick').runOrdNetFingerprintTick;
const dir = mkdtempSync(path.join(tmpdir(), 'ordnet-tick-'));

beforeAll(async () => {
  vi.stubEnv('OMB_DB_PATH', path.join(dir, 'test.db'));
  dbModule = await import('../src/lib/db');
  tick = (await import('../src/lib/ordNetFingerprintTick')).runOrdNetFingerprintTick;
  dbModule.getDb();
});
afterAll(() => {
  dbModule.getDb().close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  const db = dbModule.getDb();
  db.exec(`DELETE FROM notify_pending; DELETE FROM events;
    UPDATE inscriptions SET transfer_count=0,sale_count=0,total_volume_sats=0,highest_sale_sats=0;
    UPDATE poll_state SET last_cursor='0' WHERE stream='ord_net_fp'`);
  rpc.get.mockReset().mockImplementation(async (txid: string) => txs[txid]);
});

function seed(event: (typeof fixtures.offers)[number] | (typeof fixtures.bulk)[number]) {
  const db = dbModule.getDb();
  const inserted = db
    .prepare(
      `INSERT INTO events
    (inscription_id,inscription_number,txid,new_satpoint,old_owner,new_owner,event_type,block_timestamp,raw_json)
    VALUES (@inscription_id,@inscription_number,@txid,@new_satpoint,@old_owner,@new_owner,'transferred',1789288785,'{"source":"ord"}')`
    )
    .run(event);
  db.prepare(
    'UPDATE inscriptions SET transfer_count=transfer_count+1 WHERE inscription_number=?'
  ).run(event.inscription_number);
  return Number(inserted.lastInsertRowid);
}
function eventRow(id: number) {
  return dbModule.getDb().prepare('SELECT * FROM events WHERE id=?').get(id) as {
    event_type: string;
    sale_price_sats: number | null;
    raw_json: string;
  };
}
function pending() {
  return dbModule.getDb().prepare('SELECT event_id FROM notify_pending').all();
}

describe('ord.net live upgrades', () => {
  it('upgrades both reported offers once, preserves ord evidence, and enqueues sales', async () => {
    const ids = fixtures.offers.slice(0, 2).map(seed);
    expect(await tick({ live: true })).toMatchObject({ upgraded: 2, rpc_failures: 0 });
    expect(ids.map(id => eventRow(id).sale_price_sats)).toEqual([1_810_000, 1_805_000]);
    expect(JSON.parse(eventRow(ids[0]).raw_json)).toMatchObject({
      source: 'ord',
      ord_net_fp: { detector_version: 2, shape: 'offer-v2' },
    });
    expect(pending()).toHaveLength(2);
    expect(await tick({ live: true })).toMatchObject({ upgraded: 0 });
    expect(
      dbModule
        .getDb()
        .prepare(
          `SELECT transfer_count,sale_count,total_volume_sats
      FROM inscriptions WHERE inscription_number=60570592`
        )
        .get()
    ).toEqual({
      transfer_count: 0,
      sale_count: 1,
      total_volume_sats: 1_810_000,
    });
  });

  it('historical upgrades never enqueue notifications', async () => {
    seed(fixtures.offers[0]);
    expect(await tick({ live: false })).toMatchObject({ upgraded: 1 });
    expect(pending()).toHaveLength(0);
  });

  it('recognizes bulk members arriving on different ticks without duplicating basket volume', async () => {
    const first = seed(fixtures.bulk[0]);
    expect(await tick({ live: true })).toMatchObject({ upgraded: 1 });
    const second = seed(fixtures.bulk[1]);
    expect(await tick({ live: true })).toMatchObject({ upgraded: 1 });
    for (const id of [first, second])
      expect(eventRow(id)).toMatchObject({ event_type: 'sold', sale_price_sats: null });
    expect(pending()).toHaveLength(2);
    expect(
      dbModule.getDb().prepare(`SELECT SUM(total_volume_sats) AS volume FROM inscriptions`).get()
    ).toEqual({ volume: 0 });
  });

  it('holds the cursor on an RPC failure and retries without double-counting later successes', async () => {
    const first = seed(fixtures.offers[0]);
    const second = seed(fixtures.offers[1]);
    rpc.get.mockRejectedValueOnce(new Error('temporary RPC failure'));
    expect(await tick({ live: true })).toMatchObject({
      upgraded: 1,
      rpc_failures: 1,
      cursor_advanced: false,
    });
    expect(eventRow(first).event_type).toBe('transferred');
    expect(eventRow(second).event_type).toBe('sold');
    expect(await tick({ live: true })).toMatchObject({ upgraded: 1, rpc_failures: 0 });
    expect(pending()).toHaveLength(2);
  });

  it('does not revisit already-sold or loan-classified events', async () => {
    const sold = seed(fixtures.offers[0]);
    const loan = seed(fixtures.offers[1]);
    dbModule
      .getDb()
      .prepare(
        "UPDATE events SET event_type='sold',marketplace='satflow',sale_price_sats=123456 WHERE id=?"
      )
      .run(sold);
    dbModule.getDb().prepare("UPDATE events SET event_type='loan-originated' WHERE id=?").run(loan);
    expect(await tick({ live: true })).toMatchObject({ upgraded: 0 });
    expect(eventRow(sold).sale_price_sats).toBe(123456);
    expect(eventRow(loan).event_type).toBe('loan-originated');
    expect(rpc.get).not.toHaveBeenCalled();
  });
});
