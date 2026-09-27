import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { applyOriginationAggregateUpdates } from '../src/lib/loanDetect';

const databases: Database.Database[] = [];

function makeDb() {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(`
    CREATE TABLE events (
      inscription_number INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      sale_price_sats INTEGER
    );
    CREATE TABLE inscriptions (
      inscription_number INTEGER PRIMARY KEY,
      transfer_count INTEGER NOT NULL,
      sale_count INTEGER NOT NULL,
      total_volume_sats INTEGER NOT NULL,
      highest_sale_sats INTEGER NOT NULL,
      loan_count INTEGER NOT NULL,
      active_loan_count INTEGER NOT NULL,
      effective_owner TEXT
    );
  `);
  const stmts = {
    onOrigination: db.prepare(`
      UPDATE inscriptions SET
        transfer_count = MAX(transfer_count - 1, 0),
        loan_count = loan_count + 1,
        active_loan_count = active_loan_count + 1,
        effective_owner = @borrower
      WHERE inscription_number = @inscription_number
    `),
    onSoldOrigination: db.prepare(`
      UPDATE inscriptions SET
        sale_count = MAX(sale_count - 1, 0),
        total_volume_sats = MAX(total_volume_sats - COALESCE(@sale_price_sats, 0), 0),
        loan_count = loan_count + 1,
        active_loan_count = active_loan_count + 1,
        effective_owner = @borrower
      WHERE inscription_number = @inscription_number
    `),
    recomputeHighestSale: db.prepare(`
      UPDATE inscriptions
      SET highest_sale_sats = COALESCE((
        SELECT MAX(sale_price_sats) FROM events
        WHERE inscription_number = @inscription_number AND event_type = 'sold'
      ), 0)
      WHERE inscription_number = @inscription_number
    `),
  };
  return { db, stmts };
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('origination aggregate reclassification', () => {
  it('removes a recovered sold origination from sale totals and recomputes the remaining high sale', () => {
    const { db, stmts } = makeDb();
    db.exec(`
      INSERT INTO events VALUES (1, 'sold', 100), (1, 'sold', 50);
      INSERT INTO inscriptions VALUES (1, 0, 2, 150, 100, 0, 0, 'seller');
    `);

    const upgrade = db
      .prepare(
        `
      UPDATE events SET event_type = 'loan-originated', sale_price_sats = NULL
      WHERE inscription_number = 1 AND event_type = 'sold' AND sale_price_sats = 100
    `
      )
      .run();
    expect(upgrade.changes).toBe(1);
    applyOriginationAggregateUpdates(
      stmts,
      { event_type: 'sold', sale_price_sats: 100 },
      1,
      'borrower'
    );

    expect(db.prepare('SELECT * FROM inscriptions').get()).toMatchObject({
      transfer_count: 0,
      sale_count: 1,
      total_volume_sats: 50,
      highest_sale_sats: 50,
      loan_count: 1,
      active_loan_count: 1,
      effective_owner: 'borrower',
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 'sold'").get()).toEqual({
      n: 1,
    });
  });

  it('removes a transferred origination without changing sale aggregates', () => {
    const { db, stmts } = makeDb();
    db.exec(`
      INSERT INTO events VALUES (1, 'sold', 50), (1, 'transferred', NULL);
      INSERT INTO inscriptions VALUES (1, 1, 1, 50, 50, 0, 0, 'sender');
    `);

    applyOriginationAggregateUpdates(
      stmts,
      { event_type: 'transferred', sale_price_sats: null },
      1,
      'borrower'
    );

    expect(db.prepare('SELECT * FROM inscriptions').get()).toMatchObject({
      transfer_count: 0,
      sale_count: 1,
      total_volume_sats: 50,
      highest_sale_sats: 50,
      loan_count: 1,
      active_loan_count: 1,
      effective_owner: 'borrower',
    });
  });

  it('does not apply aggregates again when a replay finds the loan event already reclassified', () => {
    const { db, stmts } = makeDb();
    db.exec(`
      INSERT INTO events VALUES (1, 'loan-originated', NULL);
      INSERT INTO inscriptions VALUES (1, 0, 0, 0, 0, 1, 1, 'borrower');
    `);
    const upgrade = db
      .prepare(
        `
      UPDATE events SET event_type = 'loan-originated'
      WHERE inscription_number = 1 AND event_type IN ('transferred', 'sold')
    `
      )
      .run();

    if (upgrade.changes > 0) {
      applyOriginationAggregateUpdates(
        stmts,
        { event_type: 'transferred', sale_price_sats: null },
        1,
        'borrower'
      );
    }

    expect(upgrade.changes).toBe(0);
    expect(db.prepare('SELECT * FROM inscriptions').get()).toMatchObject({
      transfer_count: 0,
      sale_count: 0,
      total_volume_sats: 0,
      highest_sale_sats: 0,
      loan_count: 1,
      active_loan_count: 1,
    });
  });
});
