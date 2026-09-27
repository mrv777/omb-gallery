import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const upstream = vi.hoisted(() => ({
  sales: vi.fn(),
  states: vi.fn(),
  confirmations: vi.fn(),
  timestamp: vi.fn(),
}));
vi.mock('../src/lib/satflow', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/lib/satflow')>()),
  fetchSalesPage: upstream.sales,
}));
vi.mock('../src/lib/ord', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/lib/ord')>()),
  fetchBlockHeight: async () => 900000,
  fetchBitcoindTip: async () => 900000,
  fetchInscriptionsBatch: upstream.states,
  fetchOutputConfirmations: upstream.confirmations,
  fetchBlockTimestamp: upstream.timestamp,
}));

let dbModule: typeof import('../src/lib/db');
let poll: typeof import('../src/app/api/internal/poll/route').GET;
const id = 'a'.repeat(64) + 'i0';
const output = 'c'.repeat(64) + ':0';

beforeAll(async () => {
  vi.stubEnv('OMB_DB_PATH', ':memory:');
  vi.stubEnv('INTERNAL_POLL_SECRET', 'test-secret');
  vi.stubEnv('ORD_BASE_URL', 'http://ord.invalid');
  dbModule = await import('../src/lib/db');
  poll = (await import('../src/app/api/internal/poll/route')).GET;
});
afterAll(() => {
  dbModule.getDb().close();
  vi.unstubAllEnvs();
});
beforeEach(() => {
  const db = dbModule.getDb();
  db.exec(`DELETE FROM events; DELETE FROM inscriptions;
    UPDATE poll_state SET last_cursor=NULL,lock_until=NULL,is_backfilling=0,backfill_unresolved_seen=0`);
  db.prepare(
    `INSERT INTO inscriptions
    (inscription_number,inscription_id,color,collection_slug,current_output,current_owner,effective_owner)
    VALUES (1,?,'green','omb',?,'current-holder','current-holder')`
  ).run(id, output);
  upstream.sales.mockReset();
  upstream.states
    .mockReset()
    .mockResolvedValue([{ inscription_id: id, output, address: 'current-holder' }]);
  upstream.confirmations.mockReset().mockResolvedValue(1);
  upstream.timestamp.mockReset().mockResolvedValue(1688169600);
});

function sale(index = 1) {
  return {
    satflow_id: String(index),
    inscription_id: id,
    txid: index.toString(16).padStart(64, '0'),
    transfer_txid: null,
    sale_price_sats: 100,
    block_timestamp: 1700000000 + index,
    block_height: null,
    marketplace: 'satflow',
    seller: 'seller',
    buyer: 'historical-buyer',
    raw_json: '{}',
  };
}
async function tick(mode: string) {
  const response = await poll(
    new NextRequest(`http://localhost/api/internal/poll?mode=${mode}&collection=omb`, {
      headers: { authorization: 'Bearer test-secret' },
    })
  );
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  return result;
}
function owner() {
  return dbModule
    .getDb()
    .prepare('SELECT current_owner,effective_owner FROM inscriptions WHERE inscription_number=1')
    .get();
}

describe('poll data accuracy', () => {
  it('does not let an older standalone sale overwrite chain-initialized ownership', async () => {
    upstream.sales.mockResolvedValue({ items: [sale()], rawCount: 1, hasMore: false, total: 1 });
    await tick('satflow');
    expect(owner()).toEqual({ current_owner: 'current-holder', effective_owner: 'current-holder' });
    await tick('ord');
    expect(owner()).toEqual({ current_owner: 'current-holder', effective_owner: 'current-holder' });
  });

  it('repairs stale current ownership at an unchanged output without adding a transfer', async () => {
    dbModule.getDb().exec("UPDATE inscriptions SET current_owner='stale',effective_owner='stale'");
    await tick('ord');
    expect(owner()).toEqual({ current_owner: 'current-holder', effective_owner: 'current-holder' });
    expect(dbModule.getDb().prepare('SELECT COUNT(*) n FROM events').get()).toEqual({ n: 0 });
  });

  it('preserves the borrower when reconciling an active loan escrow', async () => {
    dbModule
      .getDb()
      .exec(
        "UPDATE inscriptions SET current_owner='stale',effective_owner='borrower',active_loan_count=1"
      );
    await tick('ord');
    expect(owner()).toEqual({ current_owner: 'current-holder', effective_owner: 'borrower' });
  });

  it.each([null, 'd'.repeat(64) + ':0'])(
    'preserves the borrower on initial sync or an escrow self-transfer (%s)',
    async currentOutput => {
      dbModule
        .getDb()
        .prepare(
          "UPDATE inscriptions SET current_output=?,effective_owner='borrower',active_loan_count=1"
        )
        .run(currentOutput);
      await tick('ord');
      expect(owner()).toEqual({ current_owner: 'current-holder', effective_owner: 'borrower' });
    }
  );

  it('reclassifies a mint when timestamp healing replaces the poll-time fallback', async () => {
    dbModule
      .getDb()
      .prepare(
        `INSERT INTO events
      (inscription_id,inscription_number,event_type,block_timestamp,txid,old_owner,new_owner,new_satpoint)
      VALUES (?,1,'transferred',1750000000,?,'bc1pyl6g53k220rggaukyx929qnnxqw8vzt8xrfw88muw22pnwfvqjkqreeqpw','buyer',?)`
      )
      .run(id, 'c'.repeat(64), output);
    dbModule.getDb().exec('UPDATE inscriptions SET transfer_count=1');
    await tick('heal-heights');
    expect(dbModule.getDb().prepare('SELECT event_type,block_timestamp FROM events').get()).toEqual(
      { event_type: 'mint', block_timestamp: 1688169600 }
    );
    expect(
      dbModule
        .getDb()
        .prepare(
          'SELECT transfer_count,last_movement_at FROM inscriptions WHERE inscription_number=1'
        )
        .get()
    ).toEqual({ transfer_count: 0, last_movement_at: 1688169600 });
  });

  it('still uses sales as a fallback when ord has not initialized a location', async () => {
    dbModule
      .getDb()
      .exec('UPDATE inscriptions SET current_output=NULL,current_owner=NULL,effective_owner=NULL');
    upstream.sales.mockResolvedValue({ items: [sale()], rawCount: 1, hasMore: false, total: 1 });
    await tick('satflow');
    expect(owner()).toEqual({
      current_owner: 'historical-buyer',
      effective_owner: 'historical-buyer',
    });
  });

  it('resumes past duplicate head pages after hitting the incremental page budget', async () => {
    const sales = Array.from({ length: 500 }, (_, i) => sale(500 - i));
    upstream.sales.mockImplementation(async ({ page }: { page: number }) => {
      const items = sales.slice((page - 1) * 100, page * 100);
      return { items, rawCount: items.length, hasMore: items.length === 100, total: sales.length };
    });
    await tick('satflow');
    expect(dbModule.getDb().prepare('SELECT COUNT(*) n FROM events').get()).toEqual({ n: 300 });
    // New sales arrive while catch-up is pending; head polling remains live.
    sales.unshift(sale(501));
    await tick('satflow');
    await tick('satflow');
    expect(dbModule.getDb().prepare('SELECT COUNT(*) n FROM events').get()).toEqual({ n: 501 });
    expect(
      dbModule.getStmts().getPollState.get({ stream: 'satflow', collection: 'omb' })
    ).toMatchObject({ last_cursor: null });
  });

  it('resumes the failed page after a partial incremental request failure', async () => {
    const sales = Array.from({ length: 150 }, (_, i) => sale(150 - i));
    let fail = true;
    upstream.sales.mockImplementation(async ({ page }: { page: number }) => {
      if (page === 2 && fail) {
        fail = false;
        throw new Error('temporary upstream error');
      }
      const items = sales.slice((page - 1) * 100, page * 100);
      return { items, rawCount: items.length, hasMore: items.length === 100, total: sales.length };
    });
    await tick('satflow');
    await tick('satflow');
    expect(dbModule.getDb().prepare('SELECT COUNT(*) n FROM events').get()).toEqual({ n: 150 });
  });

  it('retries unresolved incremental sales even after their page becomes mostly duplicates', async () => {
    const unresolvedId = 'b'.repeat(64) + 'i0';
    const sales = [
      ...Array.from({ length: 100 }, (_, i) => sale(101 - i)),
      { ...sale(), inscription_id: unresolvedId },
    ];
    upstream.sales.mockImplementation(async ({ page }: { page: number }) => {
      const items = sales.slice((page - 1) * 100, page * 100);
      return { items, rawCount: items.length, hasMore: items.length === 100, total: sales.length };
    });
    await tick('satflow');
    dbModule
      .getDb()
      .prepare(
        "INSERT INTO inscriptions (inscription_number,inscription_id,collection_slug) VALUES (2,?,'omb')"
      )
      .run(unresolvedId);
    await tick('satflow');
    expect(dbModule.getDb().prepare('SELECT COUNT(*) n FROM events').get()).toEqual({ n: 101 });
  });

  it('classifies a newly imported primary mint without adding secondary volume, including replay', async () => {
    const mint = {
      ...sale(),
      seller: 'bc1pyl6g53k220rggaukyx929qnnxqw8vzt8xrfw88muw22pnwfvqjkqreeqpw',
      block_timestamp: 1688169600,
    };
    upstream.sales.mockResolvedValue({ items: [mint], rawCount: 1, hasMore: false, total: 1 });
    await tick('satflow');
    await tick('satflow');
    expect(dbModule.getDb().prepare('SELECT event_type,sale_price_sats FROM events').all()).toEqual(
      [{ event_type: 'mint', sale_price_sats: 100 }]
    );
    expect(
      dbModule
        .getDb()
        .prepare(
          'SELECT sale_count,total_volume_sats,highest_sale_sats FROM inscriptions WHERE inscription_number=1'
        )
        .get()
    ).toEqual({ sale_count: 0, total_volume_sats: 0, highest_sale_sats: 0 });
  });

  it('reclassifies an existing mint-window sale and preserves later secondary-sale totals', async () => {
    const mint = {
      ...sale(),
      seller: 'bc1pyl6g53k220rggaukyx929qnnxqw8vzt8xrfw88muw22pnwfvqjkqreeqpw',
      block_timestamp: 1688169600,
    };
    upstream.sales.mockResolvedValue({
      items: [sale(), sale(2)],
      rawCount: 2,
      hasMore: false,
      total: 2,
    });
    await tick('satflow');
    upstream.sales.mockResolvedValue({ items: [mint], rawCount: 1, hasMore: false, total: 1 });
    await tick('satflow');
    expect(
      dbModule
        .getDb()
        .prepare(
          'SELECT sale_count,total_volume_sats,highest_sale_sats FROM inscriptions WHERE inscription_number=1'
        )
        .get()
    ).toEqual({ sale_count: 1, total_volume_sats: 100, highest_sale_sats: 100 });
  });

  it('does not classify a post-distribution sale from a mint wallet as a mint', async () => {
    const laterSale = {
      ...sale(),
      seller: 'bc1pyl6g53k220rggaukyx929qnnxqw8vzt8xrfw88muw22pnwfvqjkqreeqpw',
      block_timestamp: 1750000000,
    };
    upstream.sales.mockResolvedValue({ items: [laterSale], rawCount: 1, hasMore: false, total: 1 });
    await tick('satflow');
    expect(dbModule.getDb().prepare('SELECT event_type FROM events').get()).toEqual({
      event_type: 'sold',
    });
  });
});
