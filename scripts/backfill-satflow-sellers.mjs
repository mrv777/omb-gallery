#!/usr/bin/env node
// One-shot backfill: re-derive `old_owner` (seller) for satflow `sold` events
// where it's currently NULL. The original normalizer pulled seller off the
// order body unconditionally, which is wrong for `bid` orders (seller is the
// taker — top-level fillOrdAddress / fillAddress). raw_json is preserved on
// every row, so we can re-parse without touching Satflow.
//
// Usage:
//   OMB_DB_PATH=/data/app.db node scripts/backfill-satflow-sellers.mjs [--dry]
//
// Default DB path is /data/app.db (prod). Pass --dry to print what would
// change without writing.

import Database from 'better-sqlite3';

const DRY = process.argv.includes('--dry');
const DB_PATH = process.env.OMB_DB_PATH ?? '/data/app.db';

const db = new Database(DB_PATH, { readonly: DRY });
db.pragma('journal_mode = WAL');

const rows = db
  .prepare(
    `SELECT id, raw_json
       FROM events
      WHERE event_type = 'sold'
        AND marketplace = 'satflow'
        AND old_owner IS NULL
        AND raw_json IS NOT NULL`
  )
  .all();

console.log(`scanning ${rows.length} null-seller satflow events`);

const update = DRY
  ? null
  : db.prepare(`UPDATE events SET old_owner = @seller WHERE id = @id AND old_owner IS NULL`);

let updated = 0;
let stillNull = 0;
let parseFail = 0;

const tx = DRY
  ? null
  : db.transaction(items => {
      for (const it of items) update.run(it);
    });

const pending = [];

for (const row of rows) {
  let item;
  try {
    item = JSON.parse(row.raw_json);
  } catch {
    parseFail++;
    continue;
  }

  const order = pickOrder(item);
  if (!order) {
    stillNull++;
    continue;
  }

  const seller =
    order.kind === 'ask'
      ? pickString(order.body, ['sellerOrdAddress', 'sellerReceiveAddress'])
      : pickString(item, ['fillOrdAddress', 'fillAddress']);

  if (!seller) {
    stillNull++;
    continue;
  }

  pending.push({ id: row.id, seller });
  updated++;
}

if (!DRY && pending.length > 0) tx(pending);

console.log(`done: updated=${updated} stillNull=${stillNull} parseFail=${parseFail} dry=${DRY}`);

db.close();

function pickOrder(item) {
  if (item.ask && typeof item.ask === 'object') return { body: item.ask, kind: 'ask' };
  if (item.bid && typeof item.bid === 'object') return { body: item.bid, kind: 'bid' };
  return null;
}

function pickString(item, keys) {
  if (!item || typeof item !== 'object') return null;
  for (const k of keys) {
    const v = item[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}
