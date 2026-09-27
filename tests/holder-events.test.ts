import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let dbModule: typeof import('../src/lib/db');
let holderEvents: typeof import('../src/lib/holderEvents');
const tempDir = path.join(
  os.tmpdir(),
  `omb-holder-events-${process.pid}-${Math.random().toString(36).slice(2)}`
);

beforeEach(async () => {
  fs.mkdirSync(tempDir, { recursive: true });
  process.env.OMB_DB_PATH = path.join(tempDir, `t-${Math.random().toString(36).slice(2)}.db`);
  vi.resetModules();
  dbModule = await import('../src/lib/db');
  holderEvents = await import('../src/lib/holderEvents');
});

afterEach(() => {
  delete process.env.OMB_DB_PATH;
  if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('countHolderEvents', () => {
  it('counts an internal transfer once and counts inferred events as a distinct subset', () => {
    const db = dbModule.getDb();
    const insc = db
      .prepare(
        `SELECT inscription_number, inscription_id FROM inscriptions WHERE collection_slug='omb' LIMIT 1`
      )
      .get() as { inscription_number: number; inscription_id: string };
    const inscriptionId = insc.inscription_id ?? `holder-events-${insc.inscription_number}i0`;
    if (!insc.inscription_id) {
      db.prepare(`UPDATE inscriptions SET inscription_id=? WHERE inscription_number=?`).run(
        inscriptionId,
        insc.inscription_number
      );
    }
    const insert = db.prepare(`
      INSERT INTO events (
        inscription_id, inscription_number, event_type, block_height, block_timestamp,
        txid, old_owner, new_owner
      ) VALUES (?, ?, ?, 100, ?, ?, ?, ?)
    `);
    const a = 'bc1qholderevents_a';
    const b = 'bc1qholderevents_b';
    const c = 'bc1qholderevents_c';
    insert.run(inscriptionId, insc.inscription_number, 'transferred', 1000, 'internal-a-b', a, b);
    insert.run(inscriptionId, insc.inscription_number, 'transferred', 2000, 'internal-b-c', b, c);

    expect(holderEvents.countHolderEvents([a, b, c], [b, c])).toEqual({ total: 2, inferred: 2 });
    expect(holderEvents.countHolderEvents([a, b, c], [c])).toEqual({ total: 2, inferred: 1 });
    expect(holderEvents.countHolderEvents([], [])).toEqual({ total: 0, inferred: 0 });
  });

  it('preserves the timeline rules for self transfers, listing rows, and loan participants', () => {
    const db = dbModule.getDb();
    const insc = db
      .prepare(
        `SELECT inscription_number, inscription_id FROM inscriptions WHERE collection_slug='omb' LIMIT 1`
      )
      .get() as { inscription_number: number; inscription_id: string };
    const inscriptionId = insc.inscription_id ?? `holder-events-${insc.inscription_number}i0`;
    if (!insc.inscription_id) {
      db.prepare(`UPDATE inscriptions SET inscription_id=? WHERE inscription_number=?`).run(
        inscriptionId,
        insc.inscription_number
      );
    }
    const insert = db.prepare(`
      INSERT INTO events (
        inscription_id, inscription_number, event_type, block_height, block_timestamp,
        txid, old_owner, new_owner, raw_json
      ) VALUES (?, ?, ?, 100, ?, ?, ?, ?, ?)
    `);
    const self = 'bc1qholderevents_self';
    const borrower = 'bc1qholderevents_borrower';
    const lender = 'bc1qholderevents_lender';
    insert.run(
      inscriptionId,
      insc.inscription_number,
      'transferred',
      1000,
      'self',
      self,
      self,
      '{}'
    );
    insert.run(inscriptionId, insc.inscription_number, 'listed', 1100, 'listing', self, null, '{}');
    insert.run(
      inscriptionId,
      insc.inscription_number,
      'loan-defaulted',
      1200,
      'default',
      'bc1qholderevents_escrow',
      lender,
      JSON.stringify({ borrower_addr: borrower, lender_addr: lender })
    );

    expect(holderEvents.countHolderEvents([self, borrower, lender], [borrower])).toEqual({
      total: 2,
      inferred: 1,
    });
  });
});
