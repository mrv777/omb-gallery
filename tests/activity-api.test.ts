import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let dbModule: typeof import('../src/lib/db');
let getActivity: typeof import('../src/app/api/activity/route').GET;
const tempDir = path.join(
  os.tmpdir(),
  `omb-activity-api-${process.pid}-${Math.random().toString(36).slice(2)}`
);

beforeEach(async () => {
  fs.mkdirSync(tempDir, { recursive: true });
  process.env.OMB_DB_PATH = path.join(tempDir, `t-${Math.random().toString(36).slice(2)}.db`);
  vi.resetModules();
  dbModule = await import('../src/lib/db');
  ({ GET: getActivity } = await import('../src/app/api/activity/route'));
});

afterEach(() => {
  delete process.env.OMB_DB_PATH;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function get(url: string) {
  return getActivity(new NextRequest(`http://localhost${url}`));
}

describe('/api/activity exact-ID revalidation', () => {
  it('returns updated rows that still match and omits upgraded or deleted rows for the filter', async () => {
    const db = dbModule.getDb();
    const inscription = db
      .prepare(
        `SELECT inscription_number, inscription_id FROM inscriptions WHERE collection_slug='omb' LIMIT 1`
      )
      .get() as { inscription_number: number; inscription_id: string | null };
    const inscriptionId =
      inscription.inscription_id ?? `activity-revalidate-${inscription.inscription_number}`;
    db.prepare(
      `UPDATE inscriptions SET inscription_id=?, current_owner='test-owner' WHERE inscription_number=?`
    ).run(inscriptionId, inscription.inscription_number);
    const insert = db.prepare(`
      INSERT INTO events (inscription_id, inscription_number, event_type, block_timestamp, txid)
      VALUES (?, ?, 'transferred', 1700000000, ?)
    `);
    const inserted = insert.run(
      inscriptionId,
      inscription.inscription_number,
      `activity-tx-${Date.now()}`
    );
    const id = Number(inserted.lastInsertRowid);

    const before = await get(`/api/activity?ids=${id}&type=transfers`);
    expect(before.status).toBe(200);
    expect(before.headers.get('cache-control')).toBe('no-store');
    expect((await before.json()).events.map((event: { id: number }) => event.id)).toEqual([id]);

    db.prepare(`UPDATE events SET event_type='sold', sale_price_sats=1000 WHERE id=?`).run(id);
    const afterUpgrade = await get(`/api/activity?ids=${id}&type=transfers`);
    expect((await afterUpgrade.json()).events).toEqual([]);
    const sales = await get(`/api/activity?ids=${id}&type=sales`);
    expect((await sales.json()).events).toMatchObject([
      { id, event_type: 'sold', sale_price_sats: 1000 },
    ]);

    db.prepare(`DELETE FROM events WHERE id=?`).run(id);
    const afterDelete = await get(`/api/activity?ids=${id}`);
    expect((await afterDelete.json()).events).toEqual([]);
  });

  it('validates the batch cap and malformed IDs', async () => {
    const tooMany = Array.from({ length: 201 }, (_, index) => index + 1).join(',');
    expect((await get(`/api/activity?ids=${tooMany}`)).status).toBe(400);
    expect((await get('/api/activity?ids=1,nope')).status).toBe(400);
    expect((await get('/api/activity?ids=0')).status).toBe(400);
  });

  it('deduplicates repeated IDs and ignores IDs outside the request', async () => {
    const db = dbModule.getDb();
    const inscription = db
      .prepare(
        `SELECT inscription_number, inscription_id FROM inscriptions WHERE collection_slug='omb' LIMIT 1`
      )
      .get() as { inscription_number: number; inscription_id: string | null };
    const inscriptionId =
      inscription.inscription_id ?? `activity-revalidate-${inscription.inscription_number}`;
    db.prepare(
      `UPDATE inscriptions SET inscription_id=?, current_owner='test-owner' WHERE inscription_number=?`
    ).run(inscriptionId, inscription.inscription_number);
    const inserted = db
      .prepare(
        `
      INSERT INTO events (inscription_id, inscription_number, event_type, block_timestamp, txid)
      VALUES (?, ?, 'transferred', 1700000000, ?)
    `
      )
      .run(inscriptionId, inscription.inscription_number, `activity-tx-${Date.now()}`);
    const id = Number(inserted.lastInsertRowid);

    const response = await get(`/api/activity?ids=${id},${id},999999999`);
    const body = await response.json();
    expect(body.events.map((event: { id: number }) => event.id)).toEqual([id]);
  });
});
