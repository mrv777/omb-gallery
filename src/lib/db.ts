import 'server-only';
import path from 'node:path';
import fs from 'node:fs';
import Database, { type Database as DB } from 'better-sqlite3';
import imageData from '../data/images.json';

const DB_PATH = process.env.OMB_DB_PATH ?? '/data/app.db';

type ImageEntry = { filename: string; description: string; tags: string[] };
type ImagesByColor = Record<string, ImageEntry[]>;

let dbInstance: DB | null = null;

export function getDb(): DB {
  if (dbInstance) return dbInstance;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  initSchema(db);
  seedInscriptions(db);

  dbInstance = db;
  return db;
}

function initSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inscriptions (
      inscription_number  INTEGER PRIMARY KEY,
      inscription_id      TEXT,
      color               TEXT,
      current_owner       TEXT,
      inscribe_at         INTEGER,
      first_event_at      INTEGER,
      last_event_at       INTEGER,
      last_movement_at    INTEGER,
      transfer_count      INTEGER NOT NULL DEFAULT 0,
      sale_count          INTEGER NOT NULL DEFAULT 0,
      total_volume_sats   INTEGER NOT NULL DEFAULT 0,
      highest_sale_sats   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_insc_movement   ON inscriptions (last_movement_at);
    CREATE INDEX IF NOT EXISTS idx_insc_xfer_count ON inscriptions (transfer_count DESC);
    CREATE INDEX IF NOT EXISTS idx_insc_sale_count ON inscriptions (sale_count DESC);
    CREATE INDEX IF NOT EXISTS idx_insc_volume     ON inscriptions (total_volume_sats DESC);
    CREATE INDEX IF NOT EXISTS idx_insc_high_sale  ON inscriptions (highest_sale_sats DESC);

    CREATE TABLE IF NOT EXISTS events (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      inscription_id      TEXT    NOT NULL,
      inscription_number  INTEGER NOT NULL,
      event_type          TEXT    NOT NULL CHECK (event_type IN ('inscribed','transferred','sold')),
      block_height        INTEGER,
      block_timestamp     INTEGER NOT NULL,
      new_satpoint        TEXT    NOT NULL UNIQUE,
      old_owner           TEXT,
      new_owner           TEXT,
      marketplace         TEXT,
      sale_price_sats     INTEGER,
      txid                TEXT    NOT NULL,
      raw_json            TEXT,
      created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (inscription_number) REFERENCES inscriptions (inscription_number) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_events_block_ts        ON events (block_timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_events_inscription_num ON events (inscription_number, block_timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_events_id_desc         ON events (id DESC);

    CREATE TABLE IF NOT EXISTS holders (
      wallet_addr       TEXT PRIMARY KEY,
      inscription_count INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_holders_count ON holders (inscription_count DESC);

    CREATE TABLE IF NOT EXISTS poll_state (
      stream            TEXT PRIMARY KEY CHECK (stream IN ('activity','holders')),
      last_cursor       TEXT,
      last_run_at       INTEGER,
      last_status       TEXT,
      last_event_count  INTEGER,
      is_backfilling    INTEGER NOT NULL DEFAULT 0,
      daily_call_count  INTEGER NOT NULL DEFAULT 0,
      daily_call_date   TEXT
    );
    INSERT OR IGNORE INTO poll_state (stream) VALUES ('activity'), ('holders');

    CREATE TABLE IF NOT EXISTS slideshows (
      slug        TEXT PRIMARY KEY,
      ids         TEXT NOT NULL,
      title       TEXT,
      image_count INTEGER NOT NULL,
      creator_ip  TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      view_count  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_slideshows_created_ip_at ON slideshows (creator_ip, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_slideshows_created_at    ON slideshows (created_at DESC);
  `);
}

function seedInscriptions(db: DB): void {
  // One-time seed from images.json. Idempotent: INSERT OR IGNORE keeps existing rows
  // (with their accumulated event aggregates) untouched.
  const existing = db.prepare('SELECT COUNT(*) AS n FROM inscriptions').get() as { n: number };
  const data = imageData as ImagesByColor;
  let candidateCount = 0;
  for (const list of Object.values(data)) candidateCount += list.length;
  if (existing.n >= candidateCount) return;

  const insert = db.prepare(
    'INSERT OR IGNORE INTO inscriptions (inscription_number, color) VALUES (?, ?)'
  );
  const tx = db.transaction(() => {
    for (const [color, list] of Object.entries(data)) {
      for (const entry of list) {
        const numStr = entry.filename.replace(/\.[^/.]+$/, '');
        const num = Number(numStr);
        if (!Number.isFinite(num)) continue;
        insert.run(num, color);
      }
    }
  });
  tx();
}

// ---------------- prepared statement accessors ----------------
// Lazy: built on first call to keep import cost low.

type Stmts = {
  // events / inscriptions writes
  insertEvent: ReturnType<DB['prepare']>;
  upsertInscriptionFromEvent: ReturnType<DB['prepare']>;
  bumpInscriptionAggregates: ReturnType<DB['prepare']>;
  // poll_state
  getPollState: ReturnType<DB['prepare']>;
  acquireLock: ReturnType<DB['prepare']>;
  setPollResult: ReturnType<DB['prepare']>;
  setBackfilling: ReturnType<DB['prepare']>;
  bumpDailyCallCount: ReturnType<DB['prepare']>;
  resetDailyCallCount: ReturnType<DB['prepare']>;
  // reads
  getRecentEvents: ReturnType<DB['prepare']>;
  getRecentEventsAfter: ReturnType<DB['prepare']>;
  countEvents: ReturnType<DB['prepare']>;
  countHolders: ReturnType<DB['prepare']>;
  getInscription: ReturnType<DB['prepare']>;
  getInscriptionEvents: ReturnType<DB['prepare']>;
  // leaderboards
  topByTransfers: ReturnType<DB['prepare']>;
  topByLongestUnmoved: ReturnType<DB['prepare']>;
  topByVolume: ReturnType<DB['prepare']>;
  topByHighestSale: ReturnType<DB['prepare']>;
  topHolders: ReturnType<DB['prepare']>;
  // holders refresh
  deleteAllHolders: ReturnType<DB['prepare']>;
  insertHolder: ReturnType<DB['prepare']>;
  setCurrentOwnerFromLatestEvent: ReturnType<DB['prepare']>;
};

let stmts: Stmts | null = null;

export function getStmts(): Stmts {
  if (stmts) return stmts;
  const db = getDb();
  stmts = {
    insertEvent: db.prepare(`
      INSERT OR IGNORE INTO events (
        inscription_id, inscription_number, event_type, block_height, block_timestamp,
        new_satpoint, old_owner, new_owner, marketplace, sale_price_sats, txid, raw_json
      ) VALUES (
        @inscription_id, @inscription_number, @event_type, @block_height, @block_timestamp,
        @new_satpoint, @old_owner, @new_owner, @marketplace, @sale_price_sats, @txid, @raw_json
      )
    `),

    // Make sure an inscriptions row exists. If discovered via BiS only, color is NULL.
    // Fills inscription_id once (immutable thereafter) and inscribe_at/first_event_at if newer info.
    upsertInscriptionFromEvent: db.prepare(`
      INSERT INTO inscriptions (inscription_number, inscription_id, inscribe_at, first_event_at, last_event_at)
      VALUES (@inscription_number, @inscription_id, @inscribe_at, @block_timestamp, @block_timestamp)
      ON CONFLICT(inscription_number) DO UPDATE SET
        inscription_id = COALESCE(inscriptions.inscription_id, excluded.inscription_id),
        inscribe_at    = COALESCE(inscriptions.inscribe_at, excluded.inscribe_at),
        first_event_at = MIN(COALESCE(inscriptions.first_event_at, excluded.first_event_at), excluded.first_event_at),
        last_event_at  = MAX(COALESCE(inscriptions.last_event_at, 0), excluded.last_event_at)
    `),

    // Apply a single event's contribution to the aggregates (called only when the events row was actually inserted).
    bumpInscriptionAggregates: db.prepare(`
      UPDATE inscriptions SET
        transfer_count    = transfer_count    + CASE WHEN @event_type = 'transferred' THEN 1 ELSE 0 END,
        sale_count        = sale_count        + CASE WHEN @event_type = 'sold'        THEN 1 ELSE 0 END,
        total_volume_sats = total_volume_sats + COALESCE(@sale_price_sats, 0),
        highest_sale_sats = MAX(highest_sale_sats, COALESCE(@sale_price_sats, 0)),
        last_movement_at  = CASE
                              WHEN @event_type IN ('transferred','sold')
                                THEN MAX(COALESCE(last_movement_at, 0), @block_timestamp)
                              ELSE last_movement_at
                            END,
        current_owner     = COALESCE(@new_owner, current_owner)
      WHERE inscription_number = @inscription_number
    `),

    getPollState: db.prepare(`SELECT * FROM poll_state WHERE stream = ?`),

    // Soft lock: succeeds only if no recent run for this stream.
    acquireLock: db.prepare(`
      UPDATE poll_state
      SET last_run_at = unixepoch()
      WHERE stream = ?
        AND (last_run_at IS NULL OR last_run_at < unixepoch() - 30)
    `),

    setPollResult: db.prepare(`
      UPDATE poll_state
      SET last_run_at = unixepoch(),
          last_status = @status,
          last_event_count = @event_count,
          last_cursor = COALESCE(@cursor, last_cursor)
      WHERE stream = @stream
    `),

    setBackfilling: db.prepare(`
      UPDATE poll_state SET is_backfilling = @flag WHERE stream = @stream
    `),

    bumpDailyCallCount: db.prepare(`
      UPDATE poll_state
      SET daily_call_count = daily_call_count + @n,
          daily_call_date  = @date
      WHERE stream = @stream
    `),

    resetDailyCallCount: db.prepare(`
      UPDATE poll_state
      SET daily_call_count = 0, daily_call_date = @date
      WHERE stream = @stream
    `),

    getRecentEvents: db.prepare(`
      SELECT * FROM events
      ORDER BY id DESC
      LIMIT @limit
    `),

    getRecentEventsAfter: db.prepare(`
      SELECT * FROM events
      WHERE id < @cursor
      ORDER BY id DESC
      LIMIT @limit
    `),

    countEvents: db.prepare(`SELECT COUNT(*) AS n FROM events`),
    countHolders: db.prepare(`SELECT COUNT(*) AS n FROM holders`),

    getInscription: db.prepare(`SELECT * FROM inscriptions WHERE inscription_number = ?`),

    getInscriptionEvents: db.prepare(`
      SELECT * FROM events
      WHERE inscription_number = ?
      ORDER BY block_timestamp DESC, id DESC
      LIMIT 50
    `),

    topByTransfers: db.prepare(`
      SELECT * FROM inscriptions
      WHERE (transfer_count + sale_count) > 0
      ORDER BY (transfer_count + sale_count) DESC, last_movement_at DESC
      LIMIT @limit
    `),

    // "Longest unmoved" — show inscriptions that have moved at least once,
    // ranked by oldest last_movement_at. Inscriptions with NULL last_movement_at
    // are "never moved since mint" — handled by a separate endpoint/section.
    topByLongestUnmoved: db.prepare(`
      SELECT * FROM inscriptions
      WHERE last_movement_at IS NOT NULL
      ORDER BY last_movement_at ASC
      LIMIT @limit
    `),

    topByVolume: db.prepare(`
      SELECT * FROM inscriptions
      WHERE total_volume_sats > 0
      ORDER BY total_volume_sats DESC
      LIMIT @limit
    `),

    topByHighestSale: db.prepare(`
      SELECT * FROM inscriptions
      WHERE highest_sale_sats > 0
      ORDER BY highest_sale_sats DESC
      LIMIT @limit
    `),

    topHolders: db.prepare(`
      SELECT * FROM holders
      ORDER BY inscription_count DESC, wallet_addr ASC
      LIMIT @limit
    `),

    deleteAllHolders: db.prepare(`DELETE FROM holders`),

    insertHolder: db.prepare(`
      INSERT INTO holders (wallet_addr, inscription_count, updated_at)
      VALUES (@wallet_addr, @inscription_count, unixepoch())
      ON CONFLICT(wallet_addr) DO UPDATE SET
        inscription_count = excluded.inscription_count,
        updated_at = excluded.updated_at
    `),

    // Used as a fallback for current_owner when holders endpoint doesn't expose
    // wallet→inscription_id mappings: derive owner from latest event.
    setCurrentOwnerFromLatestEvent: db.prepare(`
      UPDATE inscriptions SET current_owner = (
        SELECT new_owner FROM events
        WHERE events.inscription_number = inscriptions.inscription_number
          AND new_owner IS NOT NULL
        ORDER BY block_timestamp DESC, id DESC
        LIMIT 1
      )
      WHERE current_owner IS NULL
    `),
  };
  return stmts;
}

export function walCheckpoint(): void {
  try {
    getDb().pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // checkpoint failure is non-fatal
  }
}

export type EventRow = {
  id: number;
  inscription_id: string;
  inscription_number: number;
  event_type: 'inscribed' | 'transferred' | 'sold';
  block_height: number | null;
  block_timestamp: number;
  new_satpoint: string;
  old_owner: string | null;
  new_owner: string | null;
  marketplace: string | null;
  sale_price_sats: number | null;
  txid: string;
  created_at: number;
};

export type InscriptionRow = {
  inscription_number: number;
  inscription_id: string | null;
  color: string | null;
  current_owner: string | null;
  inscribe_at: number | null;
  first_event_at: number | null;
  last_event_at: number | null;
  last_movement_at: number | null;
  transfer_count: number;
  sale_count: number;
  total_volume_sats: number;
  highest_sale_sats: number;
};

export type HolderRow = {
  wallet_addr: string;
  inscription_count: number;
  updated_at: number;
};

export type PollStateRow = {
  stream: 'activity' | 'holders';
  last_cursor: string | null;
  last_run_at: number | null;
  last_status: string | null;
  last_event_count: number | null;
  is_backfilling: number;
  daily_call_count: number;
  daily_call_date: string | null;
};
