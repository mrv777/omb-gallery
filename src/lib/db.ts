import 'server-only';
import path from 'node:path';
import fs from 'node:fs';
import Database, { type Database as DB } from 'better-sqlite3';
import ombInscriptions from '../data/collections/omb/inscriptions.json';
import ombManifest from '../data/collections/omb/manifest.json';
import bravocadosInscriptions from '../data/collections/bravocados/inscriptions.json';
import bravocadosManifest from '../data/collections/bravocados/manifest.json';

const DB_PATH = process.env.OMB_DB_PATH ?? '/data/app.db';
const SCHEMA_VERSION = 16;

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
  seedCollectionsAndPollStates(db);
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
        upgradeV8ToV9(db);
        upgradeV9ToV10(db);
        upgradeV10ToV11(db);
        upgradeV11ToV12(db);
        upgradeV12ToV13(db);
        upgradeV13ToV14(db);
        upgradeV14ToV15(db);
        upgradeV15ToV16(db);
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
      if (current < 9) upgradeV8ToV9(db);
      if (current < 10) upgradeV9ToV10(db);
      if (current < 11) upgradeV10ToV11(db);
      if (current < 12) upgradeV11ToV12(db);
      if (current < 13) upgradeV12ToV13(db);
      if (current < 14) upgradeV13ToV14(db);
      if (current < 15) upgradeV14ToV15(db);
      if (current < 16) upgradeV15ToV16(db);
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
    -- Composite (collection, color, ...) indexes back the color-filtered
    -- explorer leaderboards. With ~9k rows split across 5 colors, the planner
    -- can do an index range scan in sort order instead of a full-table scan +
    -- in-memory sort. Helps mostly when @color is bound; queries with
    -- @color IS NULL fall back to the per-column indexes above.
    CREATE INDEX IF NOT EXISTS idx_insc_color_xfer
      ON inscriptions (collection_slug, color, transfer_count DESC);
    CREATE INDEX IF NOT EXISTS idx_insc_color_volume
      ON inscriptions (collection_slug, color, total_volume_sats DESC);
    CREATE INDEX IF NOT EXISTS idx_insc_color_high_sale
      ON inscriptions (collection_slug, color, highest_sale_sats DESC);
    CREATE INDEX IF NOT EXISTS idx_insc_color_movement
      ON inscriptions (collection_slug, color, last_movement_at);

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
      event_type          TEXT    NOT NULL CHECK (event_type IN ('inscribed','transferred','sold','listed')),
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
    -- Covers the typed activity feed: WHERE event_type=? ORDER BY (block_timestamp, id) DESC.
    -- Without this the planner uses idx_events_type_id and sorts in memory.
    CREATE INDEX IF NOT EXISTS idx_events_type_ts_id      ON events (event_type, block_timestamp DESC, id DESC);
    -- Covers the holder page activity query, which fans out into two indexed
    -- lookups (UNION'd in SQL): one keyed by new_owner, one by old_owner.
    CREATE INDEX IF NOT EXISTS idx_events_new_owner_ts_id ON events (new_owner, block_timestamp DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_events_old_owner_ts_id ON events (old_owner, block_timestamp DESC, id DESC);

    -- Composite-PK shape (Phase 4). Per-collection rows for per-collection
    -- streams (satflow, satflow_listings); ord uses a single 'omb' row since
    -- one batch poll covers every inscription regardless of collection. The
    -- 'matrica' stream is also collection-agnostic — one row keyed to 'omb'.
    CREATE TABLE IF NOT EXISTS poll_state (
      stream                    TEXT NOT NULL CHECK (stream IN ('ord','satflow','satflow_listings','matrica','notify')),
      collection_slug           TEXT NOT NULL REFERENCES collections (slug),
      last_cursor               TEXT,
      last_run_at               INTEGER,
      last_status               TEXT,
      last_event_count          INTEGER,
      is_backfilling            INTEGER NOT NULL DEFAULT 0,
      last_known_height         INTEGER,
      backfill_unresolved_seen  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (stream, collection_slug)
    );
    INSERT OR IGNORE INTO poll_state (stream, collection_slug) VALUES
      ('ord', 'omb'),
      ('satflow', 'omb'),
      ('satflow_listings', 'omb'),
      ('matrica', 'omb'),
      ('notify', 'omb');

    -- Matrica wallet-linking (Phase 5). matrica_users holds one row per
    -- distinct Matrica user we've seen (across any wallet); wallet_links
    -- is the wallet → user mapping. matrica_user_id IS NULL means
    -- "we checked, no profile" — the row exists to prevent re-probing
    -- before the staleness window elapses.
    CREATE TABLE IF NOT EXISTS matrica_users (
      user_id    TEXT PRIMARY KEY,
      username   TEXT,
      avatar_url TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wallet_links (
      wallet_addr     TEXT PRIMARY KEY,
      matrica_user_id TEXT,
      checked_at      INTEGER NOT NULL,
      FOREIGN KEY (matrica_user_id) REFERENCES matrica_users(user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_links_user
      ON wallet_links(matrica_user_id) WHERE matrica_user_id IS NOT NULL;

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

    -- Phase 6: notification subscriptions. One row per (channel, channel_target,
    -- kind, target_key) — UNIQUE makes "click Watch twice" a no-op. status flow:
    -- 'pending' (telegram claim awaiting /start) → 'active' → 'muted' (user
    -- mute) | 'failed' (3 strikes or dead-target signal). channel_target is
    -- the Telegram chat_id (string) or the Discord webhook URL.
    CREATE TABLE IF NOT EXISTS subscriptions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      channel          TEXT NOT NULL CHECK (channel IN ('telegram','discord')),
      channel_target   TEXT NOT NULL,
      kind             TEXT NOT NULL CHECK (kind IN ('inscription','color','collection')),
      target_key       TEXT NOT NULL,
      event_mask       INTEGER NOT NULL DEFAULT 3,
      unsub_token      TEXT NOT NULL UNIQUE,
      status           TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('pending','active','muted','failed')),
      claim_token      TEXT UNIQUE,
      claim_expires_at INTEGER,
      creator_ip       TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      last_sent_at     INTEGER,
      fail_count       INTEGER NOT NULL DEFAULT 0,
      UNIQUE (channel, channel_target, kind, target_key)
    );
    CREATE INDEX IF NOT EXISTS idx_subs_lookup_insc
      ON subscriptions (kind, target_key) WHERE status = 'active' AND kind = 'inscription';
    CREATE INDEX IF NOT EXISTS idx_subs_lookup_color
      ON subscriptions (kind, target_key) WHERE status = 'active' AND kind = 'color';
    CREATE INDEX IF NOT EXISTS idx_subs_lookup_collection
      ON subscriptions (kind, target_key) WHERE status = 'active' AND kind = 'collection';
    CREATE INDEX IF NOT EXISTS idx_subs_target
      ON subscriptions (channel, channel_target);

    -- Phase 6: notification fan-out queue. Live writers (ord transfer detection,
    -- satflow incremental sale enrichment) INSERT OR IGNORE event ids here so
    -- runNotifyFanout has a precise list of "needs delivery" rows. Backfill
    -- writers do NOT enqueue (no historical replay). On satflow upgrade
    -- transferred → sold, we re-enqueue the same event id so sales-only
    -- subscribers can still be notified after the type change. The fanout
    -- DELETEs rows only after all wanting recipients confirmed delivery, so
    -- the queue acts as both new-event signal and per-row retry buffer.
    CREATE TABLE IF NOT EXISTS notify_pending (
      event_id    INTEGER PRIMARY KEY,
      enqueued_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (event_id) REFERENCES events (id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_notify_pending_enqueued ON notify_pending (enqueued_at);
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
  if (!cols.some(c => c.name === 'last_known_height')) {
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
  if (!cols.some(c => c.name === 'backfill_unresolved_seen')) {
    db.exec(
      `ALTER TABLE poll_state ADD COLUMN backfill_unresolved_seen INTEGER NOT NULL DEFAULT 0`
    );
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
  if (!cols.some(c => c.name === 'collection_slug')) {
    db.exec(
      `ALTER TABLE inscriptions ADD COLUMN collection_slug TEXT REFERENCES collections (slug)`
    );
  }
  // Backfill the column for every existing row. Every inscription in the DB
  // today is an OMB by definition (collections/omb/inscriptions.json is the
  // only seed source pre-Phase 4).
  db.exec(`UPDATE inscriptions SET collection_slug = 'omb' WHERE collection_slug IS NULL`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_insc_collection ON inscriptions (collection_slug, inscription_number)`
  );

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

function upgradeV8ToV9(db: DB): void {
  // Phase 4: rebuild poll_state with composite PK (stream, collection_slug).
  // Existing 3 rows ('ord','satflow','satflow_listings') are tagged 'omb' —
  // every prior row was OMB-only by construction. Future collections add
  // per-collection rows for satflow + satflow_listings; ord keeps a single
  // 'omb' bookkeeping row since one batch poll covers all inscriptions.
  //
  // SQLite can't add a column to a PK in place, so we copy-and-swap. Wrapped
  // in the outer migration transaction (see migrate()) so a crash mid-rebuild
  // leaves the DB recoverable on restart.
  db.exec(`
    CREATE TABLE poll_state_v9 (
      stream                    TEXT NOT NULL CHECK (stream IN ('ord','satflow','satflow_listings')),
      collection_slug           TEXT NOT NULL REFERENCES collections (slug),
      last_cursor               TEXT,
      last_run_at               INTEGER,
      last_status               TEXT,
      last_event_count          INTEGER,
      is_backfilling            INTEGER NOT NULL DEFAULT 0,
      last_known_height         INTEGER,
      backfill_unresolved_seen  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (stream, collection_slug)
    );
    INSERT INTO poll_state_v9 (
      stream, collection_slug, last_cursor, last_run_at, last_status,
      last_event_count, is_backfilling, last_known_height, backfill_unresolved_seen
    )
    SELECT
      stream, 'omb', last_cursor, last_run_at, last_status,
      last_event_count, is_backfilling, last_known_height, backfill_unresolved_seen
    FROM poll_state;
    DROP TABLE poll_state;
    ALTER TABLE poll_state_v9 RENAME TO poll_state;
  `);
}

function upgradeV9ToV10(db: DB): void {
  // Composite index for the typed activity feed: WHERE event_type=?
  // ORDER BY (block_timestamp, id) DESC. The pre-existing idx_events_type_id
  // is keyed by (event_type, id DESC), which forces an in-memory sort once
  // the typed result set grows beyond a page.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_type_ts_id ON events (event_type, block_timestamp DESC, id DESC)
  `);
}

function upgradeV10ToV11(db: DB): void {
  // Per-address indexes for /holder/[address]: the page lists events where
  // the address appears as either side of a transfer/sale, sorted (block_timestamp, id) DESC.
  // Two single-column composite indexes + UNION ALL beats a single OR predicate
  // because the planner can't pick one index for a disjunction.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_new_owner_ts_id ON events (new_owner, block_timestamp DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_events_old_owner_ts_id ON events (old_owner, block_timestamp DESC, id DESC);
  `);
}

function upgradeV11ToV12(db: DB): void {
  // Phase 5: Matrica wallet-linking. Three changes:
  //   1. Extend poll_state.stream CHECK to allow 'matrica'. SQLite can't
  //      ALTER a CHECK in place, so copy-and-swap (same pattern as v6/v9).
  //   2. Add matrica_users (one row per Matrica identity).
  //   3. Add wallet_links (wallet → user, with NULL meaning "checked, no profile").
  db.exec(`
    CREATE TABLE poll_state_v12 (
      stream                    TEXT NOT NULL CHECK (stream IN ('ord','satflow','satflow_listings','matrica')),
      collection_slug           TEXT NOT NULL REFERENCES collections (slug),
      last_cursor               TEXT,
      last_run_at               INTEGER,
      last_status               TEXT,
      last_event_count          INTEGER,
      is_backfilling            INTEGER NOT NULL DEFAULT 0,
      last_known_height         INTEGER,
      backfill_unresolved_seen  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (stream, collection_slug)
    );
    INSERT INTO poll_state_v12 SELECT * FROM poll_state;
    DROP TABLE poll_state;
    ALTER TABLE poll_state_v12 RENAME TO poll_state;
    INSERT OR IGNORE INTO poll_state (stream, collection_slug) VALUES ('matrica', 'omb');

    CREATE TABLE matrica_users (
      user_id    TEXT PRIMARY KEY,
      username   TEXT,
      avatar_url TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE wallet_links (
      wallet_addr     TEXT PRIMARY KEY,
      matrica_user_id TEXT,
      checked_at      INTEGER NOT NULL,
      FOREIGN KEY (matrica_user_id) REFERENCES matrica_users(user_id)
    );
    CREATE INDEX idx_wallet_links_user
      ON wallet_links(matrica_user_id) WHERE matrica_user_id IS NOT NULL;
  `);
}

function upgradeV12ToV13(db: DB): void {
  // Composite (collection, color, sort_col) indexes for color-filtered
  // explorer leaderboards. The `color` column already exists and is seeded
  // (since v0/v1) — this migration only adds index support so the new
  // `?color=` filter on /activity and /explorer queries doesn't degrade to
  // a full-table scan + sort on every request.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_insc_color_xfer
      ON inscriptions (collection_slug, color, transfer_count DESC);
    CREATE INDEX IF NOT EXISTS idx_insc_color_volume
      ON inscriptions (collection_slug, color, total_volume_sats DESC);
    CREATE INDEX IF NOT EXISTS idx_insc_color_high_sale
      ON inscriptions (collection_slug, color, highest_sale_sats DESC);
    CREATE INDEX IF NOT EXISTS idx_insc_color_movement
      ON inscriptions (collection_slug, color, last_movement_at);
  `);
}

function upgradeV13ToV14(db: DB): void {
  // Phase 6: notification subscriptions. Two changes:
  //   1. Extend poll_state.stream CHECK to allow 'notify' (cursor for the
  //      fan-out step). SQLite can't ALTER a CHECK in place, so copy-and-swap
  //      (same pattern as v6/v9/v12).
  //   2. Add `subscriptions` table with the partial-index lookup pattern keyed
  //      to (kind, target_key) where status='active'.
  db.exec(`
    CREATE TABLE poll_state_v14 (
      stream                    TEXT NOT NULL CHECK (stream IN ('ord','satflow','satflow_listings','matrica','notify')),
      collection_slug           TEXT NOT NULL REFERENCES collections (slug),
      last_cursor               TEXT,
      last_run_at               INTEGER,
      last_status               TEXT,
      last_event_count          INTEGER,
      is_backfilling            INTEGER NOT NULL DEFAULT 0,
      last_known_height         INTEGER,
      backfill_unresolved_seen  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (stream, collection_slug)
    );
    INSERT INTO poll_state_v14 SELECT * FROM poll_state;
    DROP TABLE poll_state;
    ALTER TABLE poll_state_v14 RENAME TO poll_state;
    INSERT OR IGNORE INTO poll_state (stream, collection_slug) VALUES ('notify', 'omb');

    CREATE TABLE subscriptions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      channel          TEXT NOT NULL CHECK (channel IN ('telegram','discord')),
      channel_target   TEXT NOT NULL,
      kind             TEXT NOT NULL CHECK (kind IN ('inscription','color','collection')),
      target_key       TEXT NOT NULL,
      event_mask       INTEGER NOT NULL DEFAULT 3,
      unsub_token      TEXT NOT NULL UNIQUE,
      status           TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('pending','active','muted','failed')),
      claim_token      TEXT UNIQUE,
      claim_expires_at INTEGER,
      creator_ip       TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      last_sent_at     INTEGER,
      fail_count       INTEGER NOT NULL DEFAULT 0,
      UNIQUE (channel, channel_target, kind, target_key)
    );
    CREATE INDEX idx_subs_lookup_insc
      ON subscriptions (kind, target_key) WHERE status = 'active' AND kind = 'inscription';
    CREATE INDEX idx_subs_lookup_color
      ON subscriptions (kind, target_key) WHERE status = 'active' AND kind = 'color';
    CREATE INDEX idx_subs_lookup_collection
      ON subscriptions (kind, target_key) WHERE status = 'active' AND kind = 'collection';
    CREATE INDEX idx_subs_target
      ON subscriptions (channel, channel_target);
  `);
}

function upgradeV14ToV15(db: DB): void {
  // Phase 6 v2: replace the cursor-based notify model with a persistent queue.
  //
  // The cursor (poll_state.last_cursor for stream='notify') had two problems:
  //   1. NULL → treated as 0 → first ticks would scan from events.id=1, so
  //      anyone who subscribed during catch-up could be alerted about events
  //      that happened before Phase 6 shipped (historical replay).
  //   2. satflow upgrades a 'transferred' row to 'sold' in place (same id).
  //      Once cursor passed that id, the type change was invisible to fanout
  //      and sales-only subscribers (Discord #sales channels) silently lost
  //      the alert.
  //
  // The queue model fixes both: only LIVE writers enqueue (so historical and
  // backfill rows never enter the queue), and satflow upgrade RE-enqueues the
  // existing id so the type change is delivered. Existing event rows aren't
  // backfilled into the queue — they're considered "already past" at upgrade
  // time, which is the correct semantic on a brownfield deploy.
  db.exec(`
    CREATE TABLE notify_pending (
      event_id    INTEGER PRIMARY KEY,
      enqueued_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (event_id) REFERENCES events (id) ON DELETE CASCADE
    );
    CREATE INDEX idx_notify_pending_enqueued ON notify_pending (enqueued_at);
  `);
}

function upgradeV15ToV16(db: DB): void {
  // Phase 6.1: extend events.event_type CHECK to allow 'listed' so the
  // listings poll can emit fan-out-eligible rows. SQLite can't ALTER a CHECK
  // in place — copy-and-swap, same pattern as v3 / v6 / v9 / v12 / v14.
  db.exec(`
    CREATE TABLE events_v3 (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      inscription_id      TEXT    NOT NULL,
      inscription_number  INTEGER NOT NULL,
      event_type          TEXT    NOT NULL CHECK (event_type IN ('inscribed','transferred','sold','listed')),
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
    INSERT INTO events_v3 SELECT * FROM events;
    DROP TABLE events;
    ALTER TABLE events_v3 RENAME TO events;
    CREATE INDEX IF NOT EXISTS idx_events_block_ts        ON events (block_timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_events_inscription_num ON events (inscription_number, block_timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_events_id_desc         ON events (id DESC);
    CREATE INDEX IF NOT EXISTS idx_events_type_id         ON events (event_type, id DESC);
    CREATE INDEX IF NOT EXISTS idx_events_type_ts_id      ON events (event_type, block_timestamp DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_events_new_owner_ts_id ON events (new_owner, block_timestamp DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_events_old_owner_ts_id ON events (old_owner, block_timestamp DESC, id DESC);
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
  if (!cols.some(c => c.name === 'last_polled_at')) {
    db.exec(`ALTER TABLE inscriptions ADD COLUMN last_polled_at INTEGER NOT NULL DEFAULT 0`);
  }
}

function seedCollectionsAndPollStates(db: DB): void {
  // Always-runs seed (cheap: one INSERT OR IGNORE per registered collection
  // plus 2 per satflow-tracked one). Lives outside seedInscriptions because
  // the inscription seed short-circuits once the row count matches, so a
  // post-migration server boot would otherwise skip both.
  // Upsert so manifest edits to name / satflow_slug actually reach existing
  // rows. Preserves `enabled` (operator-controlled — no programmatic writer)
  // and lets a typo fix in a manifest take effect on next deploy without a
  // manual UPDATE on prod SQLite.
  const upsertCollection = db.prepare(`
    INSERT INTO collections (slug, name, satflow_slug, enabled)
    VALUES (@slug, @name, @satflow_slug, 1)
    ON CONFLICT(slug) DO UPDATE SET
      name         = excluded.name,
      satflow_slug = excluded.satflow_slug
  `);
  // Per-collection poll_state rows for satflow streams. ord intentionally
  // stays as a single ('ord','omb') row — one batch poll already covers
  // every inscription regardless of collection.
  const upsertSatflowStreams = db.prepare(`
    INSERT OR IGNORE INTO poll_state (stream, collection_slug)
    VALUES ('satflow', @slug), ('satflow_listings', @slug)
  `);
  const tx = db.transaction(() => {
    for (const { manifest } of COLLECTIONS) {
      upsertCollection.run({
        slug: manifest.slug,
        name: manifest.name,
        satflow_slug: manifest.satflow_slug,
      });
      if (manifest.satflow_slug) {
        upsertSatflowStreams.run({ slug: manifest.slug });
      }
    }
  });
  tx();
}

function seedInscriptions(db: DB): void {
  // Idempotent seed across every collection registered in COLLECTIONS.
  // INSERT OR IGNORE keeps existing rows (and their accumulated event
  // aggregates) untouched. Skipped entirely when the row count already
  // matches the registry total — that's the hot path on every server boot.
  let candidateCount = 0;
  for (const c of COLLECTIONS) {
    candidateCount +=
      c.manifest.shape === 'flat'
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
  const tx = db.transaction(() => {
    for (const { manifest, data } of COLLECTIONS) {
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
  listEnabledCollections: ReturnType<DB['prepare']>;
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
  getInscriptionsByOwner: ReturnType<DB['prepare']>;
  getEventsByAddress: ReturnType<DB['prepare']>;
  countEventsByAddress: ReturnType<DB['prepare']>;
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
  // notify queue (Phase 6 v2)
  enqueueNotify: ReturnType<DB['prepare']>;
  selectNotifyQueueBatch: ReturnType<DB['prepare']>;
  selectActiveListingsForCollection: ReturnType<DB['prepare']>;
  insertListedEvent: ReturnType<DB['prepare']>;
  // matrica wallet-linking
  pickWalletsToProbe: ReturnType<DB['prepare']>;
  upsertWalletLink: ReturnType<DB['prepare']>;
  upsertMatricaUser: ReturnType<DB['prepare']>;
  getWalletLink: ReturnType<DB['prepare']>;
  getWalletsForUser: ReturnType<DB['prepare']>;
  getMatricaProfilesForAddrs: ReturnType<DB['prepare']>;
  topHoldersGrouped: ReturnType<DB['prepare']>;
  countHolderIdentities: ReturnType<DB['prepare']>;
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

    getPollState: db.prepare(`
      SELECT * FROM poll_state WHERE stream = @stream AND collection_slug = @collection
    `),

    // Soft lock: succeeds only if no recent run for this (stream, collection).
    // The window must exceed the worst-case tick duration
    // (TICK_WALLCLOCK_BUDGET_MS plus enrichment + I/O slack) — otherwise a
    // still-running tick can be raced by a fresh cron call.
    acquireLock: db.prepare(`
      UPDATE poll_state
      SET last_run_at = unixepoch()
      WHERE stream = @stream
        AND collection_slug = @collection
        AND (last_run_at IS NULL OR last_run_at < unixepoch() - 120)
    `),

    setPollResult: db.prepare(`
      UPDATE poll_state
      SET last_run_at = unixepoch(),
          last_status = @status,
          last_event_count = @event_count,
          last_cursor = COALESCE(@cursor, last_cursor)
      WHERE stream = @stream AND collection_slug = @collection
    `),

    setBackfilling: db.prepare(`
      UPDATE poll_state SET is_backfilling = @flag
      WHERE stream = @stream AND collection_slug = @collection
    `),

    setBackfillUnresolvedSeen: db.prepare(`
      UPDATE poll_state SET backfill_unresolved_seen = @count
      WHERE stream = @stream AND collection_slug = @collection
    `),

    setKnownHeight: db.prepare(`
      UPDATE poll_state SET last_known_height = @height
      WHERE stream = @stream AND collection_slug = @collection
    `),

    listEnabledCollections: db.prepare(`
      SELECT slug, name, satflow_slug
      FROM collections
      WHERE enabled = 1
      ORDER BY slug ASC
    `),

    // The four event-feed queries scope to a single collection by joining
    // through `inscriptions` (the `events` table has no collection_slug of
    // its own — keeping it that way avoids a denormalized column to keep in
    // sync). The join key is `inscription_number` (PK on inscriptions, indexed
    // on events). Default `@collection = 'omb'` is enforced at the route layer.
    // Activity feed orders by on-chain time (block_timestamp), tie-breaking
    // by id. Backfill ticks insert events newest-first into the DB, so id
    // order doesn't match chronological order and ordering by id alone shows
    // older sales above newer ones for the same inscription. Cursor is the
    // (block_timestamp, id) of the last row from the previous page; SQLite
    // row-value comparison gives us a stable keyset across the composite key.
    // The `(@color IS NULL OR i.color = @color)` predicate is the across-the-
    // board pattern for color-filtered reads — pass null to query the whole
    // collection, pass a concrete color to scope to that color cohort.
    // 'listed' events are notification-only — they're a Satflow-snapshot
    // derivation, not an on-chain event, and the activity feed is meant to
    // render the on-chain history. Excluding them keeps the feed semantics
    // stable and avoids ActivityRow's rendering branches mishandling them.
    getRecentEvents: db.prepare(`
      SELECT e.* FROM events e
      JOIN inscriptions i ON i.inscription_number = e.inscription_number
      WHERE i.collection_slug = @collection
        AND (@color IS NULL OR i.color = @color)
        AND e.event_type != 'listed'
      ORDER BY e.block_timestamp DESC, e.id DESC
      LIMIT @limit
    `),

    getRecentEventsAfter: db.prepare(`
      SELECT e.* FROM events e
      JOIN inscriptions i ON i.inscription_number = e.inscription_number
      WHERE i.collection_slug = @collection
        AND (@color IS NULL OR i.color = @color)
        AND e.event_type != 'listed'
        AND (e.block_timestamp, e.id) < (@cursor_ts, @cursor_id)
      ORDER BY e.block_timestamp DESC, e.id DESC
      LIMIT @limit
    `),

    getRecentEventsByType: db.prepare(`
      SELECT e.* FROM events e
      JOIN inscriptions i ON i.inscription_number = e.inscription_number
      WHERE e.event_type = @event_type AND i.collection_slug = @collection
        AND (@color IS NULL OR i.color = @color)
      ORDER BY e.block_timestamp DESC, e.id DESC
      LIMIT @limit
    `),

    getRecentEventsByTypeAfter: db.prepare(`
      SELECT e.* FROM events e
      JOIN inscriptions i ON i.inscription_number = e.inscription_number
      WHERE e.event_type = @event_type AND i.collection_slug = @collection
        AND (@color IS NULL OR i.color = @color)
        AND (e.block_timestamp, e.id) < (@cursor_ts, @cursor_id)
      ORDER BY e.block_timestamp DESC, e.id DESC
      LIMIT @limit
    `),

    countEvents: db.prepare(`
      SELECT COUNT(*) AS n FROM events e
      JOIN inscriptions i ON i.inscription_number = e.inscription_number
      WHERE i.collection_slug = @collection
        AND (@color IS NULL OR i.color = @color)
        AND e.event_type != 'listed'
    `),

    // Holders are derived from inscriptions.current_owner — count distinct non-null owners.
    countHolders: db.prepare(`
      SELECT COUNT(DISTINCT current_owner) AS n
      FROM inscriptions
      WHERE current_owner IS NOT NULL
        AND collection_slug = @collection
        AND (@color IS NULL OR color = @color)
    `),

    getInscription: db.prepare(`
      SELECT * FROM inscriptions
      WHERE inscription_number = @inscription_number AND collection_slug = @collection
    `),

    // Both inscription-detail timelines exclude 'listed' events for the
    // same reason as getRecentEvents — listings are off-chain notification
    // triggers, not on-chain history.
    getInscriptionEvents: db.prepare(`
      SELECT * FROM events
      WHERE inscription_number = ? AND event_type != 'listed'
      ORDER BY block_timestamp DESC, id DESC
      LIMIT 50
    `),

    // Used by the detail page (server-rendered), where we want the full timeline.
    // Indexed scan via idx_events_inscription_num — fast even for thousands of rows.
    getAllInscriptionEvents: db.prepare(`
      SELECT * FROM events
      WHERE inscription_number = ? AND event_type != 'listed'
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

    // Holder profile: every inscription this address currently owns in a given
    // collection. Walks idx_insc_owner; the per-collection filter narrows the
    // result via idx_insc_collection. Returns inscription_number ASC for stable
    // grid ordering across reloads.
    getInscriptionsByOwner: db.prepare(`
      SELECT * FROM inscriptions
      WHERE current_owner = @owner
        AND collection_slug = @collection
      ORDER BY inscription_number ASC
    `),

    // Holder profile: events where the address shows up on either side of a
    // transfer/sale, sorted (block_timestamp, id) DESC. UNION ALL'd two indexed
    // lookups (one per owner side) since SQLite won't pick a single index for
    // the disjunction `new_owner=? OR old_owner=?`. Outer ORDER BY does the
    // merge — at the LIMIT we use here (50) the cost is negligible.
    // Holder timeline — also excludes 'listed' events. Listings have NULL
    // new_owner so they wouldn't even match `new_owner = @owner`, but they
    // WOULD match `old_owner = @owner` for the seller's address; exclude
    // explicitly to keep the holder profile to on-chain history only.
    getEventsByAddress: db.prepare(`
      SELECT * FROM (
        SELECT * FROM events WHERE new_owner = @owner AND event_type != 'listed'
        UNION ALL
        SELECT * FROM events WHERE old_owner = @owner AND event_type != 'listed'
          AND old_owner != COALESCE(new_owner, '')
      )
      ORDER BY block_timestamp DESC, id DESC
      LIMIT @limit
    `),

    // Total event count for a holder (powers the "N events" stat). Same shape
    // as getEventsByAddress but COUNT-only — keeps the page from doing the
    // count client-side over a capped events list.
    countEventsByAddress: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM events WHERE new_owner = @owner AND event_type != 'listed')
        + (SELECT COUNT(*) FROM events WHERE old_owner = @owner AND event_type != 'listed'
           AND old_owner != COALESCE(new_owner, ''))
        AS n
    `),

    topByTransfers: db.prepare(`
      SELECT * FROM inscriptions
      WHERE (transfer_count + sale_count) > 0
        AND collection_slug = @collection
        AND (@color IS NULL OR color = @color)
      ORDER BY (transfer_count + sale_count) DESC, last_movement_at DESC
      LIMIT @limit
    `),

    topByLongestUnmoved: db.prepare(`
      SELECT * FROM inscriptions
      WHERE last_movement_at IS NOT NULL
        AND collection_slug = @collection
        AND (@color IS NULL OR color = @color)
      ORDER BY last_movement_at ASC
      LIMIT @limit
    `),

    topByVolume: db.prepare(`
      SELECT * FROM inscriptions
      WHERE total_volume_sats > 0
        AND collection_slug = @collection
        AND (@color IS NULL OR color = @color)
      ORDER BY total_volume_sats DESC
      LIMIT @limit
    `),

    topByHighestSale: db.prepare(`
      SELECT * FROM inscriptions
      WHERE highest_sale_sats > 0
        AND collection_slug = @collection
        AND (@color IS NULL OR color = @color)
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
        AND (@color IS NULL OR color = @color)
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

    // Scoped to one collection: per-collection ticks must not wipe out
    // listings owned by another collection that wasn't refreshed this tick.
    // The IN-subquery filter walks idx_insc_collection (small, fast).
    deleteStaleListings: db.prepare(`
      DELETE FROM active_listings
      WHERE refreshed_at < @cutoff
        AND inscription_number IN (
          SELECT inscription_number FROM inscriptions WHERE collection_slug = @collection
        )
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

    // ---------------- notify queue (Phase 6 v2) ----------------

    // Live event writers call this to mark a row for fanout delivery. INSERT
    // OR IGNORE — the same id can be re-enqueued safely (e.g. satflow
    // upgrades a transferred row to sold and wants the new type re-delivered;
    // already-pending rows are no-ops).
    enqueueNotify: db.prepare(`
      INSERT OR IGNORE INTO notify_pending (event_id) VALUES (?)
    `),

    // Pull a batch of pending events for fanout. Joined to inscriptions for
    // color + collection_slug (used by findMatchesForEvent). FIFO so a busy
    // tick still drains old events before new ones.
    selectNotifyQueueBatch: db.prepare(`
      SELECT e.id, e.event_type, e.inscription_id, e.inscription_number, e.block_timestamp,
             e.marketplace, e.sale_price_sats, e.new_owner, e.old_owner, e.txid,
             i.color, i.collection_slug
      FROM notify_pending q
      JOIN events       e ON e.id = q.event_id
      JOIN inscriptions i ON i.inscription_number = e.inscription_number
      WHERE e.event_type IN ('transferred','sold','listed')
      ORDER BY q.enqueued_at ASC, q.event_id ASC
      LIMIT ?
    `),

    // Read (inscription_number, listed_at) for currently-active listings in
    // ONE collection. Used to diff before/after the snapshot replace so we
    // know which rows are *newly* listed (and should fan out a 'listed'
    // event). We carry listed_at — not just the number — so a re-listing
    // (same inscription, different listed_at) emits a fresh notification
    // rather than being suppressed as "still active".
    selectActiveListingsForCollection: db.prepare(`
      SELECT al.inscription_number, al.listed_at FROM active_listings al
      JOIN inscriptions i ON i.inscription_number = al.inscription_number
      WHERE i.collection_slug = ?
    `),

    // Insert a 'listed' event with a synthetic txid so the existing
    // UNIQUE(inscription_id, txid) constraint dedupes re-detections of the
    // same listing within the same `listed_at` second. Re-listings at a
    // different `listed_at` produce a fresh row → fresh notification.
    insertListedEvent: db.prepare(`
      INSERT OR IGNORE INTO events (
        inscription_id, inscription_number, event_type,
        block_timestamp, old_owner, new_owner, marketplace,
        sale_price_sats, txid
      ) VALUES (
        @inscription_id, @inscription_number, 'listed',
        @block_timestamp, @seller, NULL, @marketplace,
        @price_sats, @txid
      )
    `),

    // ---------------- matrica wallet-linking ----------------

    // Pick wallets to probe against Matrica. Excludes wallets we've checked
    // recently (to avoid re-probing both linked and known-not-linked rows
    // every tick). The poller passes the collection-list in JS, since we want
    // owners across BOTH OMB and Bravocados — not a single collection.
    pickWalletsToProbe: db.prepare(`
      SELECT DISTINCT i.current_owner AS wallet_addr
      FROM inscriptions i
      WHERE i.current_owner IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM wallet_links wl
          WHERE wl.wallet_addr = i.current_owner
            AND wl.checked_at > @stale_before
        )
      ORDER BY wallet_addr ASC
      LIMIT @limit
    `),

    // Upsert a link. matrica_user_id is NULL when Matrica returned 400
    // "Wallet not found" — we still write the row so we don't re-probe.
    // Sticky on re-probe: if we already have a non-null user_id and a later
    // probe returns NULL (user removed the wallet from their Matrica
    // profile), we keep the prior link. A different non-null user_id IS
    // allowed to override (re-link to a new user is a fresh signature).
    upsertWalletLink: db.prepare(`
      INSERT INTO wallet_links (wallet_addr, matrica_user_id, checked_at)
      VALUES (@wallet_addr, @matrica_user_id, @checked_at)
      ON CONFLICT(wallet_addr) DO UPDATE SET
        matrica_user_id = COALESCE(excluded.matrica_user_id, wallet_links.matrica_user_id),
        checked_at      = excluded.checked_at
    `),

    upsertMatricaUser: db.prepare(`
      INSERT INTO matrica_users (user_id, username, avatar_url, updated_at)
      VALUES (@user_id, @username, @avatar_url, @updated_at)
      ON CONFLICT(user_id) DO UPDATE SET
        username   = excluded.username,
        avatar_url = excluded.avatar_url,
        updated_at = excluded.updated_at
    `),

    // Reader: full link + profile for one wallet (LEFT JOIN so we can tell
    // "checked, no profile" from "never checked").
    getWalletLink: db.prepare(`
      SELECT wl.wallet_addr, wl.matrica_user_id, wl.checked_at,
             mu.username, mu.avatar_url
      FROM wallet_links wl
      LEFT JOIN matrica_users mu ON mu.user_id = wl.matrica_user_id
      WHERE wl.wallet_addr = @wallet_addr
    `),

    // Reader: every wallet we've linked to a given user. Used by /holder/[addr]
    // to aggregate holdings across the user's wallets.
    getWalletsForUser: db.prepare(`
      SELECT wallet_addr FROM wallet_links
      WHERE matrica_user_id = @user_id
      ORDER BY wallet_addr ASC
    `),

    // Reader: bulk-lookup Matrica profile data for a JSON-array of wallet
    // addresses. Used by /api/activity and the activity SSR pass to overlay
    // @username on event rows. json_each(?) lets one prepared statement
    // handle a dynamic IN-list — pass JSON.stringify(addrs).
    getMatricaProfilesForAddrs: db.prepare(`
      SELECT wl.wallet_addr, mu.username, mu.avatar_url
      FROM wallet_links wl
      JOIN matrica_users mu ON mu.user_id = wl.matrica_user_id
      WHERE wl.wallet_addr IN (SELECT value FROM json_each(@addrs_json))
    `),

    // Reader: top holders, collapsed by Matrica user when one is known.
    // Wallets without a wallet_links row, OR with matrica_user_id IS NULL
    // (checked-no-profile), keep their wallet address as the group key.
    // GROUP_CONCAT gives the route layer the full wallet set; the route
    // splits it for `wallets[]` and uses the first entry for deep-linking.
    topHoldersGrouped: db.prepare(`
      SELECT
        COALESCE(wl.matrica_user_id, i.current_owner)            AS group_key,
        CASE WHEN wl.matrica_user_id IS NOT NULL THEN 1 ELSE 0 END AS is_user,
        mu.username                                               AS username,
        mu.avatar_url                                             AS avatar_url,
        GROUP_CONCAT(DISTINCT i.current_owner)                    AS wallets_csv,
        COUNT(*)                                                  AS inscription_count,
        unixepoch()                                               AS updated_at
      FROM inscriptions i
      LEFT JOIN wallet_links  wl ON wl.wallet_addr = i.current_owner
      LEFT JOIN matrica_users mu ON mu.user_id     = wl.matrica_user_id
      WHERE i.current_owner IS NOT NULL
        AND i.collection_slug = @collection
        AND (@color IS NULL OR i.color = @color)
      GROUP BY group_key
      ORDER BY inscription_count DESC, group_key ASC
      LIMIT @limit
    `),

    // Count distinct identities (Matrica user OR raw wallet). Replaces the
    // raw-wallet countHolders for the explorer's "N holders" stat once we
    // wire it up.
    countHolderIdentities: db.prepare(`
      SELECT COUNT(DISTINCT COALESCE(wl.matrica_user_id, i.current_owner)) AS n
      FROM inscriptions i
      LEFT JOIN wallet_links wl ON wl.wallet_addr = i.current_owner
      WHERE i.current_owner IS NOT NULL
        AND i.collection_slug = @collection
        AND (@color IS NULL OR i.color = @color)
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
  stream: 'ord' | 'satflow' | 'satflow_listings' | 'matrica' | 'notify';
  collection_slug: string;
  last_cursor: string | null;
  last_run_at: number | null;
  last_status: string | null;
  last_event_count: number | null;
  is_backfilling: number;
  last_known_height: number | null;
  backfill_unresolved_seen: number;
};

export type CollectionRow = {
  slug: string;
  name: string;
  satflow_slug: string | null;
};

export type MatricaUserRow = {
  user_id: string;
  username: string | null;
  avatar_url: string | null;
  updated_at: number;
};

export type WalletLinkRow = {
  wallet_addr: string;
  matrica_user_id: string | null;
  checked_at: number;
  username: string | null;
  avatar_url: string | null;
};

/** Holder row collapsed by Matrica user (or by raw wallet when unlinked). */
export type GroupedHolderRow = {
  group_key: string;
  is_user: 0 | 1;
  username: string | null;
  avatar_url: string | null;
  /** Comma-separated wallet list — split in the route layer. */
  wallets_csv: string;
  inscription_count: number;
  updated_at: number;
};
