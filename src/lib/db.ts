import 'server-only';
import path from 'node:path';
import fs from 'node:fs';
import Database, { type Database as DB } from 'better-sqlite3';
import ombInscriptions from '../data/collections/omb/inscriptions.json';
import ombManifest from '../data/collections/omb/manifest.json';
import bravocadosInscriptions from '../data/collections/bravocados/inscriptions.json';
import bravocadosManifest from '../data/collections/bravocados/manifest.json';

const DB_PATH = process.env.OMB_DB_PATH ?? '/data/app.db';
const SCHEMA_VERSION = 8;

// OMB-shape entry: filename = "<inscription_number>.jpg|webp", per-color groups.
type ImageEntry = { filename: string; description: string; tags: string[] };
type ImagesByColor = Record<string, ImageEntry[]>;

// Flat-shape entry (e.g. Bravocados): { inscription_id, inscription_number }.
type FlatEntry = { inscription_id: string; inscription_number: number | null };

type CollectionManifest = {
  slug: string;
  name: string;
  satflow_slug: string | null;
  /** 'color-grouped' = OMB-style; 'flat' = Bravocados-style. */
  shape: 'color-grouped' | 'flat';
};

// Static collection registry. Adding a 3rd collection means: drop the JSON
// pair under src/data/collections/<slug>/, add another entry here. Static
// imports (vs runtime fs walk) keep Next.js bundling predictable and avoid
// `outputFileTracingIncludes` configuration.
const COLLECTIONS = [
  {
    manifest: ombManifest as CollectionManifest,
    data: ombInscriptions as ImagesByColor,
  },
  {
    manifest: bravocadosManifest as CollectionManifest,
    data: bravocadosInscriptions as FlatEntry[],
  },
] as const;

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
  db.pragma('cache_size = -65536');
  db.pragma('mmap_size = 268435456');

  migrate(db);
  seedInscriptions(db);

  dbInstance = db;
  return db;
}

function migrate(db: DB): void {
  const current = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  if (current >= SCHEMA_VERSION) return;

  // Atomic so a SIGTERM mid-migration leaves the DB recoverable on restart.
  const tx = db.transaction(() => {
    if (current === 0) {
      // The v1 schema (pre-this-branch) never set user_version, so an existing
      // legacy DB also reports 0. Distinguish by probing for `holders`, which
      // only exists in v1 and is dropped by upgradeV1ToV2.
      const isLegacyV1 = !!db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='holders'`)
        .get();
      if (isLegacyV1) {
        upgradeV1ToV2(db);
        upgradeV2ToV3(db);
        upgradeV3ToV4(db);
        upgradeV4ToV5(db);
        upgradeV5ToV6(db);
        upgradeV6ToV7(db);
        upgradeV7ToV8(db);
      } else {
        initSchemaLatest(db);
      }
    } else {
      if (current < 2) upgradeV1ToV2(db);
      if (current < 3) upgradeV2ToV3(db);
      if (current < 4) upgradeV3ToV4(db);
      if (current < 5) upgradeV4ToV5(db);
      if (current < 6) upgradeV5ToV6(db);
      if (current < 7) upgradeV6ToV7(db);
      if (current < 8) upgradeV7ToV8(db);
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  });
  tx();
}

function initSchemaLatest(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collections (
      slug          TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      satflow_slug  TEXT,
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );
    INSERT OR IGNORE INTO collections (slug, name, satflow_slug, enabled)
      VALUES ('omb', 'Ordinal Maxi Biz', 'omb', 1);

    CREATE TABLE IF NOT EXISTS inscriptions (
      inscription_number  INTEGER PRIMARY KEY,
      inscription_id      TEXT,
      color               TEXT,
      current_owner       TEXT,
      current_output      TEXT,
      inscribe_at         INTEGER,
      first_event_at      INTEGER,
      last_event_at       INTEGER,
      last_movement_at    INTEGER,
      transfer_count      INTEGER NOT NULL DEFAULT 0,
      sale_count          INTEGER NOT NULL DEFAULT 0,
      total_volume_sats   INTEGER NOT NULL DEFAULT 0,
      highest_sale_sats   INTEGER NOT NULL DEFAULT 0,
      last_polled_at      INTEGER NOT NULL DEFAULT 0,
      collection_slug     TEXT REFERENCES collections (slug)
    );
    CREATE INDEX IF NOT EXISTS idx_insc_movement   ON inscriptions (last_movement_at);
    CREATE INDEX IF NOT EXISTS idx_insc_xfer_count ON inscriptions (transfer_count DESC);
    CREATE INDEX IF NOT EXISTS idx_insc_sale_count ON inscriptions (sale_count DESC);
    CREATE INDEX IF NOT EXISTS idx_insc_volume     ON inscriptions (total_volume_sats DESC);
    CREATE INDEX IF NOT EXISTS idx_insc_high_sale  ON inscriptions (highest_sale_sats DESC);
    CREATE INDEX IF NOT EXISTS idx_insc_owner      ON inscriptions (current_owner);
    CREATE INDEX IF NOT EXISTS idx_insc_id         ON inscriptions (inscription_id);
    CREATE INDEX IF NOT EXISTS idx_insc_collection ON inscriptions (collection_slug, inscription_number);

    CREATE TABLE IF NOT EXISTS backfill_state (
      collection_slug      TEXT NOT NULL,
      inscription_id       TEXT NOT NULL,
      status               TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','in_progress','done','error')),
      walked_to_satpoint   TEXT,
      transfers_recorded   INTEGER NOT NULL DEFAULT 0,
      last_error           TEXT,
      updated_at           INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (collection_slug, inscription_id)
    );
    CREATE INDEX IF NOT EXISTS idx_backfill_status ON backfill_state (collection_slug, status);

    CREATE TABLE IF NOT EXISTS events (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      inscription_id      TEXT    NOT NULL,
      inscription_number  INTEGER NOT NULL,
      event_type          TEXT    NOT NULL CHECK (event_type IN ('inscribed','transferred','sold')),
      block_height        INTEGER,
      block_timestamp     INTEGER NOT NULL,
      new_satpoint        TEXT,
      old_owner           TEXT,
      new_owner           TEXT,
      marketplace         TEXT,
      sale_price_sats     INTEGER,
      txid                TEXT    NOT NULL,
      raw_json            TEXT,
      created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (inscription_number) REFERENCES inscriptions (inscription_number) ON DELETE CASCADE,
      UNIQUE (inscription_id, txid)
    );
    CREATE INDEX IF NOT EXISTS idx_events_block_ts        ON events (block_timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_events_inscription_num ON events (inscription_number, block_timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_events_id_desc         ON events (id DESC);
    CREATE INDEX IF NOT EXISTS idx_events_type_id         ON events (event_type, id DESC);

    CREATE TABLE IF NOT EXISTS poll_state (
      stream                    TEXT PRIMARY KEY CHECK (stream IN ('ord','satflow','satflow_listings')),
      last_cursor               TEXT,
      last_run_at               INTEGER,
      last_status               TEXT,
      last_event_count          INTEGER,
      is_backfilling            INTEGER NOT NULL DEFAULT 0,
      last_known_height         INTEGER,
      backfill_unresolved_seen  INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO poll_state (stream) VALUES ('ord'), ('satflow'), ('satflow_listings');

    -- Snapshot of currently-active listings on Satflow. Refreshed atomically
    -- every listings tick (DELETE + bulk INSERT in a transaction). One row per
    -- inscription; if multiple marketplaces ever list the same one, the lowest
    -- price wins (write-time conflict resolution via INSERT … ON CONFLICT).
    CREATE TABLE IF NOT EXISTS active_listings (
      inscription_number INTEGER PRIMARY KEY,
      inscription_id     TEXT    NOT NULL,
      satflow_id         TEXT    NOT NULL,
      price_sats         INTEGER NOT NULL,
      seller             TEXT,
      marketplace        TEXT    NOT NULL DEFAULT 'satflow',
      listed_at          INTEGER NOT NULL,
      refreshed_at       INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (inscription_number) REFERENCES inscriptions (inscription_number) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_listings_price ON active_listings (price_sats);

    -- Rolling counter for Satflow API call quota visibility. Single row.
    CREATE TABLE IF NOT EXISTS satflow_call_budget (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      window_start  INTEGER NOT NULL,
      call_count    INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO satflow_call_budget (id, window_start, call_count) VALUES (1, unixepoch(), 0);

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

function upgradeV1ToV2(db: DB): void {
  // v1 had: holders table, BiS-shaped poll_state (activity/holders streams + daily_call_*),
  // events.UNIQUE(new_satpoint), no current_output column.
  // Strategy: rebuild events with the new UNIQUE constraint, add current_output column,
  // drop holders, recreate poll_state.
  db.exec(`
    DROP TABLE IF EXISTS holders;

    -- inscriptions: add current_output (column-add is non-destructive)
    ALTER TABLE inscriptions ADD COLUMN current_output TEXT;
    CREATE INDEX IF NOT EXISTS idx_insc_owner ON inscriptions (current_owner);
    CREATE INDEX IF NOT EXISTS idx_insc_id    ON inscriptions (inscription_id);

    -- events: rebuild with new unique constraint and nullable new_satpoint
    CREATE TABLE events_v2 (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      inscription_id      TEXT    NOT NULL,
      inscription_number  INTEGER NOT NULL,
      event_type          TEXT    NOT NULL CHECK (event_type IN ('inscribed','transferred','sold')),
      block_height        INTEGER,
      block_timestamp     INTEGER NOT NULL,
      new_satpoint        TEXT,
      old_owner           TEXT,
      new_owner           TEXT,
      marketplace         TEXT,
      sale_price_sats     INTEGER,
      txid                TEXT    NOT NULL,
      raw_json            TEXT,
      created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (inscription_number) REFERENCES inscriptions (inscription_number) ON DELETE CASCADE,
      UNIQUE (inscription_id, txid)
    );
    INSERT OR IGNORE INTO events_v2
      SELECT id, inscription_id, inscription_number, event_type, block_height, block_timestamp,
             new_satpoint, old_owner, new_owner, marketplace, sale_price_sats, txid, raw_json, created_at
      FROM events;
    DROP TABLE events;
    ALTER TABLE events_v2 RENAME TO events;
    CREATE INDEX IF NOT EXISTS idx_events_block_ts        ON events (block_timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_events_inscription_num ON events (inscription_number, block_timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_events_id_desc         ON events (id DESC);

    -- poll_state: drop old table, recreate with new stream values
    DROP TABLE IF EXISTS poll_state;
    CREATE TABLE poll_state (
      stream            TEXT PRIMARY KEY CHECK (stream IN ('ord','satflow')),
      last_cursor       TEXT,
      last_run_at       INTEGER,
      last_status       TEXT,
      last_event_count  INTEGER,
      is_backfilling    INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO poll_state (stream) VALUES ('ord'), ('satflow');
  `);
}

function upgradeV2ToV3(db: DB): void {
  // Track the highest block height we've successfully ingested per stream so
  // runOrdTick can detect when ord regresses (e.g. is reindexing) and refuse
  // to write phantom transfers from stale satpoints.
  // Idempotent: skip if column already exists (defensive against partial runs).
  const cols = db.pragma('table_info(poll_state)') as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'last_known_height')) {
    db.exec(`ALTER TABLE poll_state ADD COLUMN last_known_height INTEGER`);
  }
}

function upgradeV3ToV4(db: DB): void {
  // Compound index for /api/activity?type=sales|transfers — without it, the
  // query planner walks idx_events_id_desc and post-filters, which scans
  // further as the events table grows.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_type_id ON events (event_type, id DESC)`);
}

function upgradeV5ToV6(db: DB): void {
  // Add active_listings table + extend poll_state CHECK to permit a third
  // stream value ('satflow_listings'). SQLite can't ALTER a CHECK constraint
  // in place, so we rebuild poll_state. Existing rows ('ord', 'satflow') are
  // copied verbatim; the new stream gets a default row.
  db.exec(`
    CREATE TABLE poll_state_v6 (
      stream            TEXT PRIMARY KEY CHECK (stream IN ('ord','satflow','satflow_listings')),
      last_cursor       TEXT,
      last_run_at       INTEGER,
      last_status       TEXT,
      last_event_count  INTEGER,
      is_backfilling    INTEGER NOT NULL DEFAULT 0,
      last_known_height INTEGER
    );
    INSERT INTO poll_state_v6 SELECT * FROM poll_state;
    DROP TABLE poll_state;
    ALTER TABLE poll_state_v6 RENAME TO poll_state;
    INSERT OR IGNORE INTO poll_state (stream) VALUES ('satflow_listings');

    CREATE TABLE active_listings (
      inscription_number INTEGER PRIMARY KEY,
      inscription_id     TEXT    NOT NULL,
      satflow_id         TEXT    NOT NULL,
      price_sats         INTEGER NOT NULL,
      seller             TEXT,
      marketplace        TEXT    NOT NULL DEFAULT 'satflow',
      listed_at          INTEGER NOT NULL,
      refreshed_at       INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (inscription_number) REFERENCES inscriptions (inscription_number) ON DELETE CASCADE
    );
    CREATE INDEX idx_listings_price ON active_listings (price_sats);

    CREATE TABLE satflow_call_budget (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      window_start  INTEGER NOT NULL,
      call_count    INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO satflow_call_budget (id, window_start, call_count) VALUES (1, unixepoch(), 0);
  `);
}

function upgradeV6ToV7(db: DB): void {
  // Add a sticky cross-tick counter for unresolved sales seen during a backfill
  // walk. Without this, an unresolved sale on an early page is missed forever:
  // the cursor advances past it, later ticks see unresolved=0, and the
  // is_backfilling flag clears before ord bootstrap could rescue it.
  // Idempotent: skip if column already exists.
  const cols = db.pragma('table_info(poll_state)') as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'backfill_unresolved_seen')) {
    db.exec(`ALTER TABLE poll_state ADD COLUMN backfill_unresolved_seen INTEGER NOT NULL DEFAULT 0`);
  }
}

function upgradeV7ToV8(db: DB): void {
  // Multi-collection groundwork. Purely additive: introduces a `collections`
  // table, tags every existing inscription as 'omb', and adds `backfill_state`
  // for the per-inscription transfer-history walker. No callsite changes
  // required yet — every read still defaults to OMB until Phase 4 wires the
  // poller through the collection axis.
  db.exec(`
    CREATE TABLE IF NOT EXISTS collections (
      slug          TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      satflow_slug  TEXT,
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );
    INSERT OR IGNORE INTO collections (slug, name, satflow_slug, enabled)
      VALUES ('omb', 'Ordinal Maxi Biz', 'omb', 1);
  `);

  const cols = db.pragma('table_info(inscriptions)') as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'collection_slug')) {
    db.exec(`ALTER TABLE inscriptions ADD COLUMN collection_slug TEXT REFERENCES collections (slug)`);
  }
  // Backfill the column for every existing row. Every inscription in the DB
  // today is an OMB by definition (collections/omb/inscriptions.json is the
  // only seed source pre-Phase 4).
  db.exec(`UPDATE inscriptions SET collection_slug = 'omb' WHERE collection_slug IS NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_insc_collection ON inscriptions (collection_slug, inscription_number)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS backfill_state (
      collection_slug      TEXT NOT NULL,
      inscription_id       TEXT NOT NULL,
      status               TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','in_progress','done','error')),
      walked_to_satpoint   TEXT,
      transfers_recorded   INTEGER NOT NULL DEFAULT 0,
      last_error           TEXT,
      updated_at           INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (collection_slug, inscription_id)
    );
    CREATE INDEX IF NOT EXISTS idx_backfill_status ON backfill_state (collection_slug, status);
  `);
}

function upgradeV4ToV5(db: DB): void {
  // Round-robin poll order: without this, runOrdTick always polls in
  // inscription_number ASC and breaks at the wallclock budget, so the back
  // half of the list never gets re-polled and silently misses transfers.
  // Adding `last_polled_at` (default 0 = "never") and ordering by it ASC
  // means each tick prioritizes least-recently-polled rows, so coverage
  // catches up over a few ticks even when one tick doesn't fit them all.
  // Idempotent: skip if column already exists.
  const cols = db.pragma('table_info(inscriptions)') as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'last_polled_at')) {
    db.exec(`ALTER TABLE inscriptions ADD COLUMN last_polled_at INTEGER NOT NULL DEFAULT 0`);
  }
}

function seedInscriptions(db: DB): void {
  // Idempotent seed across every collection registered in COLLECTIONS.
  // INSERT OR IGNORE keeps existing rows (and their accumulated event
  // aggregates) untouched. Skipped entirely when the row count already
  // matches the registry total — that's the hot path on every server boot.
  let candidateCount = 0;
  for (const c of COLLECTIONS) {
    candidateCount += c.manifest.shape === 'flat'
      ? (c.data as FlatEntry[]).length
      : Object.values(c.data as ImagesByColor).reduce((n, list) => n + list.length, 0);
  }
  const existing = db.prepare('SELECT COUNT(*) AS n FROM inscriptions').get() as { n: number };
  if (existing.n >= candidateCount) return;

  // Two shapes of insert: OMB has a color but no inscription_id at seed time
  // (id is bootstrapped later by ord). Bravocados has the id + number from
  // the parent's children enumeration but no color. The COALESCE-on-conflict
  // path lets a re-seed (e.g. after adding a column) populate fields that
  // were NULL without overwriting later-set values.
  const insertColored = db.prepare(`
    INSERT INTO inscriptions (inscription_number, color, collection_slug)
    VALUES (@number, @color, @slug)
    ON CONFLICT(inscription_number) DO UPDATE SET
      color           = COALESCE(inscriptions.color, excluded.color),
      collection_slug = COALESCE(inscriptions.collection_slug, excluded.collection_slug)
  `);
  const insertFlat = db.prepare(`
    INSERT INTO inscriptions (inscription_number, inscription_id, collection_slug)
    VALUES (@number, @inscription_id, @slug)
    ON CONFLICT(inscription_number) DO UPDATE SET
      inscription_id  = COALESCE(inscriptions.inscription_id, excluded.inscription_id),
      collection_slug = COALESCE(inscriptions.collection_slug, excluded.collection_slug)
  `);
  const upsertCollection = db.prepare(`
    INSERT OR IGNORE INTO collections (slug, name, satflow_slug, enabled)
    VALUES (@slug, @name, @satflow_slug, 1)
  `);

  const tx = db.transaction(() => {
    for (const { manifest, data } of COLLECTIONS) {
      upsertCollection.run({
        slug: manifest.slug,
        name: manifest.name,
        satflow_slug: manifest.satflow_slug,
      });

      if (manifest.shape === 'flat') {
        for (const entry of data as FlatEntry[]) {
          if (entry.inscription_number == null) continue; // skip rows we couldn't number
          insertFlat.run({
            number: entry.inscription_number,
            inscription_id: entry.inscription_id,
            slug: manifest.slug,
          });
        }
      } else {
        for (const [color, list] of Object.entries(data as ImagesByColor)) {
          for (const entry of list) {
            const num = Number(entry.filename.replace(/\.[^/.]+$/, ''));
            if (!Number.isFinite(num)) continue;
            insertColored.run({ number: num, color, slug: manifest.slug });
          }
        }
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
  upgradeEventToSold: ReturnType<DB['prepare']>;
  upsertInscriptionFromEvent: ReturnType<DB['prepare']>;
  bumpInscriptionAggregates: ReturnType<DB['prepare']>;
  unbumpTransferOnUpgrade: ReturnType<DB['prepare']>;
  setInscriptionState: ReturnType<DB['prepare']>;
  setInscriptionId: ReturnType<DB['prepare']>;
  setInscriptionInscribeAt: ReturnType<DB['prepare']>;
  setInscriptionOwnerIfNewer: ReturnType<DB['prepare']>;
  // ord-specific reads
  listInscriptionsForPoll: ReturnType<DB['prepare']>;
  listInscriptionsMissingId: ReturnType<DB['prepare']>;
  markInscriptionPolled: ReturnType<DB['prepare']>;
  // satflow event lookup
  findEventByInscriptionAndTxid: ReturnType<DB['prepare']>;
  listInscriptionIdToNumber: ReturnType<DB['prepare']>;
  // poll_state
  getPollState: ReturnType<DB['prepare']>;
  acquireLock: ReturnType<DB['prepare']>;
  setPollResult: ReturnType<DB['prepare']>;
  setBackfilling: ReturnType<DB['prepare']>;
  setBackfillUnresolvedSeen: ReturnType<DB['prepare']>;
  setKnownHeight: ReturnType<DB['prepare']>;
  // reads
  getRecentEvents: ReturnType<DB['prepare']>;
  getRecentEventsAfter: ReturnType<DB['prepare']>;
  getRecentEventsByType: ReturnType<DB['prepare']>;
  getRecentEventsByTypeAfter: ReturnType<DB['prepare']>;
  countEvents: ReturnType<DB['prepare']>;
  countHolders: ReturnType<DB['prepare']>;
  getInscription: ReturnType<DB['prepare']>;
  getInscriptionEvents: ReturnType<DB['prepare']>;
  getAllInscriptionEvents: ReturnType<DB['prepare']>;
  otherInscriptionsByOwner: ReturnType<DB['prepare']>;
  // leaderboards
  topByTransfers: ReturnType<DB['prepare']>;
  topByLongestUnmoved: ReturnType<DB['prepare']>;
  topByVolume: ReturnType<DB['prepare']>;
  topByHighestSale: ReturnType<DB['prepare']>;
  topHolders: ReturnType<DB['prepare']>;
  // listings
  upsertActiveListing: ReturnType<DB['prepare']>;
  deleteStaleListings: ReturnType<DB['prepare']>;
  truncateActiveListings: ReturnType<DB['prepare']>;
  getActiveListing: ReturnType<DB['prepare']>;
  countActiveListings: ReturnType<DB['prepare']>;
  // satflow call budget
  bumpSatflowCallCount: ReturnType<DB['prepare']>;
  getSatflowCallBudget: ReturnType<DB['prepare']>;
  resetSatflowCallBudget: ReturnType<DB['prepare']>;
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

    // Used by Satflow when a 'transferred' row already exists for the same (inscription_id, txid):
    // upgrade it to a 'sold' row with marketplace + price.
    //
    // block_height/block_timestamp use COALESCE(@..., col) so Satflow can correct
    // an event that was written with the poller's wallclock fallback (when ord
    // enrichment failed): when Satflow ships real on-chain timing, it overwrites;
    // when it ships nothing, the existing transfer values are preserved.
    upgradeEventToSold: db.prepare(`
      UPDATE events
      SET event_type      = 'sold',
          marketplace     = @marketplace,
          sale_price_sats = @sale_price_sats,
          old_owner       = COALESCE(@old_owner, old_owner),
          new_owner       = COALESCE(@new_owner, new_owner),
          block_height    = COALESCE(@block_height, block_height),
          block_timestamp = COALESCE(@block_timestamp, block_timestamp),
          raw_json        = COALESCE(@raw_json, raw_json)
      WHERE inscription_id = @inscription_id
        AND txid           = @txid
        AND event_type     = 'transferred'
    `),

    upsertInscriptionFromEvent: db.prepare(`
      INSERT INTO inscriptions (inscription_number, inscription_id, inscribe_at, first_event_at, last_event_at)
      VALUES (@inscription_number, @inscription_id, @inscribe_at, @block_timestamp, @block_timestamp)
      ON CONFLICT(inscription_number) DO UPDATE SET
        inscription_id = COALESCE(inscriptions.inscription_id, excluded.inscription_id),
        inscribe_at    = COALESCE(inscriptions.inscribe_at, excluded.inscribe_at),
        first_event_at = MIN(COALESCE(inscriptions.first_event_at, excluded.first_event_at), excluded.first_event_at),
        last_event_at  = MAX(COALESCE(inscriptions.last_event_at, 0), excluded.last_event_at)
    `),

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
                            END
      WHERE inscription_number = @inscription_number
    `),

    // When upgrading a transferred row to a sold row, the transfer was already counted —
    // decrement transfer_count, increment sale_count, and add the sale value.
    unbumpTransferOnUpgrade: db.prepare(`
      UPDATE inscriptions SET
        transfer_count    = MAX(transfer_count - 1, 0),
        sale_count        = sale_count + 1,
        total_volume_sats = total_volume_sats + COALESCE(@sale_price_sats, 0),
        highest_sale_sats = MAX(highest_sale_sats, COALESCE(@sale_price_sats, 0))
      WHERE inscription_number = @inscription_number
    `),

    setInscriptionState: db.prepare(`
      UPDATE inscriptions
      SET current_output = @current_output,
          current_owner  = @current_owner,
          inscription_id = COALESCE(inscriptions.inscription_id, @inscription_id)
      WHERE inscription_number = @inscription_number
    `),

    setInscriptionId: db.prepare(`
      UPDATE inscriptions
      SET inscription_id = COALESCE(inscriptions.inscription_id, @inscription_id)
      WHERE inscription_number = @inscription_number
    `),

    // Set inscribe_at (genesis timestamp) only if not already set. Used by the
    // ord bootstrap pass to populate "held since mint" data for inscriptions
    // that have never moved (no event would otherwise carry the genesis time).
    setInscriptionInscribeAt: db.prepare(`
      UPDATE inscriptions
      SET inscribe_at = COALESCE(inscriptions.inscribe_at, @inscribe_at)
      WHERE inscription_number = @inscription_number
    `),

    // Update current_owner from a Satflow standalone-insert sale, but only if
    // the sale is at least as recent as anything we already know about. Run
    // BEFORE bumpInscriptionAggregates (which advances last_movement_at).
    // This keeps backfill (asc-sorted, oldest-first) from clobbering a more
    // recent owner already set by ord or a later satflow row.
    setInscriptionOwnerIfNewer: db.prepare(`
      UPDATE inscriptions
      SET current_owner = @new_owner
      WHERE inscription_number = @inscription_number
        AND @new_owner IS NOT NULL
        AND (last_movement_at IS NULL OR @block_timestamp >= last_movement_at)
    `),

    listInscriptionsForPoll: db.prepare(`
      SELECT inscription_number, inscription_id, current_output, current_owner
      FROM inscriptions
      WHERE inscription_id IS NOT NULL
      ORDER BY last_polled_at ASC, inscription_number ASC
    `),

    markInscriptionPolled: db.prepare(`
      UPDATE inscriptions SET last_polled_at = @now WHERE inscription_id = @inscription_id
    `),

    listInscriptionsMissingId: db.prepare(`
      SELECT inscription_number
      FROM inscriptions
      WHERE inscription_id IS NULL
      ORDER BY inscription_number
      LIMIT @limit
    `),

    findEventByInscriptionAndTxid: db.prepare(`
      SELECT id, event_type, inscription_number
      FROM events
      WHERE inscription_id = @inscription_id AND txid = @txid
    `),

    // Used by the satflow tick to resolve `inscription_id` (returned by
    // Satflow) to our `inscription_number` (the integer keyed everywhere
    // else in the schema). Built into a Map at the start of each tick.
    listInscriptionIdToNumber: db.prepare(`
      SELECT inscription_id, inscription_number
      FROM inscriptions
      WHERE inscription_id IS NOT NULL
    `),

    getPollState: db.prepare(`SELECT * FROM poll_state WHERE stream = ?`),

    // Soft lock: succeeds only if no recent run for this stream. The window
    // must exceed the worst-case tick duration (TICK_WALLCLOCK_BUDGET_MS plus
    // enrichment + I/O slack) — otherwise a still-running tick can be raced
    // by a fresh cron call that acquires the lock and runs concurrently.
    acquireLock: db.prepare(`
      UPDATE poll_state
      SET last_run_at = unixepoch()
      WHERE stream = ?
        AND (last_run_at IS NULL OR last_run_at < unixepoch() - 120)
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

    setBackfillUnresolvedSeen: db.prepare(`
      UPDATE poll_state SET backfill_unresolved_seen = @count WHERE stream = @stream
    `),

    setKnownHeight: db.prepare(`
      UPDATE poll_state SET last_known_height = @height WHERE stream = @stream
    `),

    // The four event-feed queries scope to a single collection by joining
    // through `inscriptions` (the `events` table has no collection_slug of
    // its own — keeping it that way avoids a denormalized column to keep in
    // sync). The join key is `inscription_number` (PK on inscriptions, indexed
    // on events). Default `@collection = 'omb'` is enforced at the route layer.
    getRecentEvents: db.prepare(`
      SELECT e.* FROM events e
      JOIN inscriptions i ON i.inscription_number = e.inscription_number
      WHERE i.collection_slug = @collection
      ORDER BY e.id DESC
      LIMIT @limit
    `),

    getRecentEventsAfter: db.prepare(`
      SELECT e.* FROM events e
      JOIN inscriptions i ON i.inscription_number = e.inscription_number
      WHERE e.id < @cursor AND i.collection_slug = @collection
      ORDER BY e.id DESC
      LIMIT @limit
    `),

    getRecentEventsByType: db.prepare(`
      SELECT e.* FROM events e
      JOIN inscriptions i ON i.inscription_number = e.inscription_number
      WHERE e.event_type = @event_type AND i.collection_slug = @collection
      ORDER BY e.id DESC
      LIMIT @limit
    `),

    getRecentEventsByTypeAfter: db.prepare(`
      SELECT e.* FROM events e
      JOIN inscriptions i ON i.inscription_number = e.inscription_number
      WHERE e.id < @cursor AND e.event_type = @event_type AND i.collection_slug = @collection
      ORDER BY e.id DESC
      LIMIT @limit
    `),

    countEvents: db.prepare(`
      SELECT COUNT(*) AS n FROM events e
      JOIN inscriptions i ON i.inscription_number = e.inscription_number
      WHERE i.collection_slug = @collection
    `),

    // Holders are derived from inscriptions.current_owner — count distinct non-null owners.
    countHolders: db.prepare(`
      SELECT COUNT(DISTINCT current_owner) AS n
      FROM inscriptions
      WHERE current_owner IS NOT NULL
        AND collection_slug = @collection
    `),

    getInscription: db.prepare(`
      SELECT * FROM inscriptions
      WHERE inscription_number = @inscription_number AND collection_slug = @collection
    `),

    getInscriptionEvents: db.prepare(`
      SELECT * FROM events
      WHERE inscription_number = ?
      ORDER BY block_timestamp DESC, id DESC
      LIMIT 50
    `),

    // Used by the detail page (server-rendered), where we want the full timeline.
    // Indexed scan via idx_events_inscription_num — fast even for thousands of rows.
    getAllInscriptionEvents: db.prepare(`
      SELECT * FROM events
      WHERE inscription_number = ?
      ORDER BY block_timestamp DESC, id DESC
    `),

    // For the "other holdings by this wallet" strip on the inscription detail page.
    otherInscriptionsByOwner: db.prepare(`
      SELECT inscription_number
      FROM inscriptions
      WHERE current_owner = @owner
        AND inscription_number != @exclude
        AND collection_slug = @collection
      ORDER BY inscription_number
      LIMIT @limit
    `),

    topByTransfers: db.prepare(`
      SELECT * FROM inscriptions
      WHERE (transfer_count + sale_count) > 0
        AND collection_slug = @collection
      ORDER BY (transfer_count + sale_count) DESC, last_movement_at DESC
      LIMIT @limit
    `),

    topByLongestUnmoved: db.prepare(`
      SELECT * FROM inscriptions
      WHERE last_movement_at IS NOT NULL
        AND collection_slug = @collection
      ORDER BY last_movement_at ASC
      LIMIT @limit
    `),

    topByVolume: db.prepare(`
      SELECT * FROM inscriptions
      WHERE total_volume_sats > 0
        AND collection_slug = @collection
      ORDER BY total_volume_sats DESC
      LIMIT @limit
    `),

    topByHighestSale: db.prepare(`
      SELECT * FROM inscriptions
      WHERE highest_sale_sats > 0
        AND collection_slug = @collection
      ORDER BY highest_sale_sats DESC
      LIMIT @limit
    `),

    topHolders: db.prepare(`
      SELECT current_owner AS wallet_addr,
             COUNT(*)      AS inscription_count,
             unixepoch()   AS updated_at
      FROM inscriptions
      WHERE current_owner IS NOT NULL
        AND collection_slug = @collection
      GROUP BY current_owner
      ORDER BY inscription_count DESC, current_owner ASC
      LIMIT @limit
    `),

    // Snapshot-replace pattern: on each listings tick we bulk-upsert every
    // active listing the API returned, then DELETE rows whose refreshed_at
    // is older than the cutoff (= rows we didn't see this tick = no longer
    // active on Satflow). All within one transaction so readers see either
    // the old snapshot or the new one, never a partial view.
    upsertActiveListing: db.prepare(`
      INSERT INTO active_listings (
        inscription_number, inscription_id, satflow_id, price_sats,
        seller, marketplace, listed_at, refreshed_at
      ) VALUES (
        @inscription_number, @inscription_id, @satflow_id, @price_sats,
        @seller, @marketplace, @listed_at, @refreshed_at
      )
      ON CONFLICT(inscription_number) DO UPDATE SET
        inscription_id = excluded.inscription_id,
        satflow_id     = excluded.satflow_id,
        price_sats     = excluded.price_sats,
        seller         = excluded.seller,
        marketplace    = excluded.marketplace,
        listed_at      = excluded.listed_at,
        refreshed_at   = excluded.refreshed_at
    `),

    deleteStaleListings: db.prepare(`
      DELETE FROM active_listings WHERE refreshed_at < @cutoff
    `),

    truncateActiveListings: db.prepare(`DELETE FROM active_listings`),

    getActiveListing: db.prepare(`
      SELECT * FROM active_listings WHERE inscription_number = ?
    `),

    countActiveListings: db.prepare(`SELECT COUNT(*) AS n FROM active_listings`),

    // Rolling monthly call counter. Resets when window_start is more than 30
    // days old — slightly imprecise vs. calendar months, but operationally
    // simpler and matches the "100k requests per month" framing.
    bumpSatflowCallCount: db.prepare(`
      UPDATE satflow_call_budget SET call_count = call_count + 1 WHERE id = 1
    `),

    getSatflowCallBudget: db.prepare(`
      SELECT window_start, call_count FROM satflow_call_budget WHERE id = 1
    `),

    resetSatflowCallBudget: db.prepare(`
      UPDATE satflow_call_budget SET window_start = unixepoch(), call_count = 0 WHERE id = 1
    `),
  };
  return stmts;
}

export function walCheckpoint(): void {
  try {
    getDb().pragma('wal_checkpoint(PASSIVE)');
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
  new_satpoint: string | null;
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
  current_output: string | null;
  inscribe_at: number | null;
  first_event_at: number | null;
  last_event_at: number | null;
  last_movement_at: number | null;
  transfer_count: number;
  sale_count: number;
  total_volume_sats: number;
  highest_sale_sats: number;
};

export type ActiveListingRow = {
  inscription_number: number;
  inscription_id: string;
  satflow_id: string;
  price_sats: number;
  seller: string | null;
  marketplace: string;
  listed_at: number;
  refreshed_at: number;
};

export type HolderRow = {
  wallet_addr: string;
  inscription_count: number;
  updated_at: number;
};

export type PollStateRow = {
  stream: 'ord' | 'satflow' | 'satflow_listings';
  last_cursor: string | null;
  last_run_at: number | null;
  last_status: string | null;
  last_event_count: number | null;
  is_backfilling: number;
  last_known_height: number | null;
  backfill_unresolved_seen: number;
};
