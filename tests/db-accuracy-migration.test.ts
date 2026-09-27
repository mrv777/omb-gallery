import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'accuracy-migration-'));
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('v47 data accuracy repair', () => {
  it('repairs historical mint and loan trade totals, schedules a rescan, and creates usable loan indexes', async () => {
    vi.stubEnv('OMB_DB_PATH', path.join(dir, 'test.db'));
    let mod = await import('../src/lib/db');
    let db = mod.getDb();
    const row = db
      .prepare(
        "SELECT inscription_number FROM inscriptions WHERE color='green' AND collection_slug='omb' LIMIT 1"
      )
      .get() as { inscription_number: number };
    const n = row.inscription_number;
    db.prepare(
      `INSERT INTO events (inscription_id,inscription_number,event_type,block_timestamp,txid,old_owner,sale_price_sats)
      VALUES ('mint-id',?,'sold',1688169600,'mint-tx','bc1pyl6g53k220rggaukyx929qnnxqw8vzt8xrfw88muw22pnwfvqjkqreeqpw',100)`
    ).run(n);
    db.prepare(
      `INSERT INTO events (inscription_id,inscription_number,event_type,block_timestamp,txid,raw_json)
      VALUES ('loan-id',?,'loan-originated',1750000000,'loan-tx','{"borrower_addr":"borrower"}')`
    ).run(n);
    db.prepare(
      'UPDATE inscriptions SET transfer_count=9,sale_count=2,total_volume_sats=200,highest_sale_sats=100 WHERE inscription_number=?'
    ).run(n);
    db.pragma('user_version=46');
    db.close();
    vi.resetModules();
    mod = await import('../src/lib/db');
    db = mod.getDb();
    expect(db.pragma('user_version', { simple: true })).toBe(47);
    expect(
      db
        .prepare(
          'SELECT transfer_count,sale_count,total_volume_sats,highest_sale_sats FROM inscriptions WHERE inscription_number=?'
        )
        .get(n)
    ).toEqual({ transfer_count: 0, sale_count: 0, total_volume_sats: 0, highest_sale_sats: 0 });
    expect(
      db.prepare("SELECT event_type,sale_price_sats FROM events WHERE txid='mint-tx'").get()
    ).toEqual({ event_type: 'mint', sale_price_sats: 100 });
    expect(mod.getStmts().getPollState.get({ stream: 'satflow', collection: 'omb' })).toMatchObject(
      { is_backfilling: 1, last_cursor: 'page:1' }
    );
    const plan = db
      .prepare('EXPLAIN QUERY PLAN ' + mod.getStmts().countEventsByAddress.source)
      .all({ owner: 'borrower' }) as { detail: string }[];
    expect(plan.some(r => r.detail.includes('idx_events_loan_borrower'))).toBe(true);
    expect(plan.some(r => r.detail.includes('idx_events_loan_lender'))).toBe(true);
    // Reopening v47 must not reset an in-progress historical scan.
    db.prepare("UPDATE poll_state SET last_cursor='page:8' WHERE stream='satflow'").run();
    db.close();
    vi.resetModules();
    mod = await import('../src/lib/db');
    db = mod.getDb();
    expect(mod.getStmts().getPollState.get({ stream: 'satflow', collection: 'omb' })).toMatchObject(
      { last_cursor: 'page:8' }
    );
    db.close();
  });
});
