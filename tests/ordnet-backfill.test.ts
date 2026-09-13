import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import fixtures from './chain-fixtures/ordnet-settlements.json';

const dir = mkdtempSync(path.join(tmpdir(), 'ordnet-repair-'));
const dbPath = path.join(dir, 'test.db');
let server: Server;
let rpcUrl: string;
let failRpc = false;
const txs: Record<string, unknown> = fixtures.txs;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const call = JSON.parse(raw);
    const result =
      call.method === 'getblockchaininfo' ? { blocks: 966795, chain: 'main' } : txs[call.params[0]];
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify(
        failRpc && call.method === 'getrawtransaction'
          ? { error: { message: 'unavailable' } }
          : { result }
      )
    );
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No RPC listener');
  rpcUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

function run(...args: string[]) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['scripts/backfill-ord-net-fingerprint.js', '--settlements-only', ...args],
      {
        env: { ...process.env, OMB_DB_PATH: dbPath, BITCOIN_RPC_URL: rpcUrl },
      }
    );
    let output = '';
    child.stdout.on('data', data => {
      output += data;
    });
    child.stderr.on('data', data => {
      output += data;
    });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
}

it('dry-runs, repairs, and reruns idempotently without changing the notification queue', async () => {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE inscriptions (inscription_number INTEGER PRIMARY KEY,
    transfer_count INTEGER DEFAULT 1,sale_count INTEGER DEFAULT 0,
    total_volume_sats INTEGER DEFAULT 0,highest_sale_sats INTEGER DEFAULT 0);
    CREATE TABLE events (id INTEGER PRIMARY KEY,inscription_id TEXT,inscription_number INTEGER,
    event_type TEXT,marketplace TEXT,sale_price_sats INTEGER,old_owner TEXT,new_owner TEXT,
    new_satpoint TEXT,txid TEXT,block_timestamp INTEGER,raw_json TEXT);
    CREATE TABLE notify_pending(event_id INTEGER PRIMARY KEY); INSERT INTO notify_pending VALUES (12345);`);
  const events = [fixtures.offers[0], fixtures.offers[1], ...fixtures.bulk.slice(0, 2)];
  events.forEach((event, i) => {
    db.prepare('INSERT INTO inscriptions(inscription_number) VALUES (?)').run(
      event.inscription_number
    );
    db.prepare(
      `INSERT INTO events VALUES (@id,@inscription_id,@inscription_number,
      'transferred',NULL,NULL,@old_owner,@new_owner,@new_satpoint,@txid,1789288785,'{"source":"ord"}')`
    ).run({ ...event, id: i + 1 });
  });
  const before = db.prepare('SELECT * FROM events').all();
  const dry = await run('--dry-run');
  expect(dry.code, dry.output).toBe(0);
  expect(dry.output).toContain('upgraded=4');
  expect(db.prepare('SELECT * FROM events').all()).toEqual(before);

  failRpc = true;
  const failure = await run('--dry-run');
  expect(failure.code).toBe(1);
  expect(failure.output).toContain('rpcFails=4');
  failRpc = false;

  const applied = await run();
  expect(applied.code, applied.output).toBe(0);
  expect(applied.output).toContain('upgraded=4');
  expect(db.prepare('SELECT event_type,sale_price_sats FROM events ORDER BY id').all()).toEqual([
    { event_type: 'sold', sale_price_sats: 1_810_000 },
    { event_type: 'sold', sale_price_sats: 1_805_000 },
    { event_type: 'sold', sale_price_sats: null },
    { event_type: 'sold', sale_price_sats: null },
  ]);
  expect(
    db
      .prepare(
        'SELECT SUM(transfer_count) AS transfers,SUM(sale_count) AS sales,SUM(total_volume_sats) AS volume FROM inscriptions'
      )
      .get()
  ).toEqual({ transfers: 0, sales: 4, volume: 3_615_000 });
  expect(db.prepare('SELECT * FROM notify_pending').all()).toEqual([{ event_id: 12345 }]);
  const after = db.prepare('SELECT * FROM events').all();
  const repeated = await run();
  expect(repeated.code, repeated.output).toBe(0);
  expect(repeated.output).toContain('upgraded=0');
  expect(db.prepare('SELECT * FROM events').all()).toEqual(after);
  db.close();
});
