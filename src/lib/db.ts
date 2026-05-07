import 'server-only';
import path from 'node:path';
import fs from 'node:fs';
import Database, { type Database as DB } from 'better-sqlite3';
import ombInscriptions from '../data/collections/omb/inscriptions.json';
import ombManifest from '../data/collections/omb/manifest.json';
import bravocadosInscriptions from '../data/collections/bravocados/inscriptions.json';
import bravocadosManifest from '../data/collections/bravocados/manifest.json';
import { SQL_EXCLUDED_OWNERS_LIST } from './walletLabels';

const DB_PATH = process.env.OMB_DB_PATH ?? '/data/app.db';
const SCHEMA_VERSION = 32;

// Wallets that distributed inscriptions as primary-mint outflows. An event
// is `event_type = 'mint'` only when ALL of:
//   - `old_owner` matches one of these wallets
//   - inscription's color matches the wallet's registered color
//   - `block_timestamp <= valid_until_ts` (the wallet's mint window)
//
// The window matters because some mint wallets continue to do regular
// movement after distribution ended (orange and black both still hold
// OMBs and do post-mint transfers). Without the time bound, those would
// mis-tag as mints. See ONCHAIN_TAGGING.md §2.1 for window evidence.
type MintWallet = {
  addr: string;
  color: string;
  /** Unix timestamp; events from this wallet after this are NOT mints. */
  valid_until_ts: number;
  /** Human-readable for diff/blame. */
  description: string;
};

const MINT_WALLETS: MintWallet[] = [
  {
    addr: 'bc1pyl6g53k220rggaukyx929qnnxqw8vzt8xrfw88muw22pnwfvqjkqreeqpw',
    color: 'green',
    valid_until_ts: 1704067200, // 2024-01-01 UTC (last out: 2023-07-05)
    description: 'Green eyes mint distribution',
  },
  {
    addr: 'bc1p53jarhva6eg4wggv7apndndger4y4gy9s6mf3gp0rttdzensu2nq3598ur',
    color: 'blue',
    valid_until_ts: 1717200000, // 2024-06-01 UTC (last out: 2023-11-14)
    description: 'Blue eyes mint distribution',
  },
  {
    addr: 'bc1pg8jywvphzeyf9fg8tsac6jq7ft2dzz7pez720r6uanumn6lyayeshg46es',
    color: 'red',
    valid_until_ts: 1717200000, // 2024-06-01 UTC (last out: 2023-11-06)
    description: 'Red eyes mint distribution',
  },
  {
    addr: 'bc1p4a29gzwlear4csc9sz6ll97j9yl7877tasy75evq8wm6r3admtqq3m72k0',
    color: 'orange',
    valid_until_ts: 1756684800, // 2025-09-01 UTC (last out: 2025-04-09)
    description: 'Orange eyes mint distribution',
  },
  {
    addr: 'bc1q86ssqhk04chjah6kkuqw3fv5wjy7v2nflyg50t',
    color: 'black',
    valid_until_ts: 1756684800, // 2025-09-01 UTC (last out: 2025-02-26)
    description: 'Black eyes mint distribution',
  },
];

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
        upgradeV16ToV17(db);
        upgradeV17ToV18(db);
        upgradeV18ToV19(db);
        upgradeV19ToV20(db);
        upgradeV20ToV21(db);
        upgradeV21ToV22(db);
        upgradeV22ToV23(db);
        upgradeV23ToV24(db);
        upgradeV24ToV25(db);
        upgradeV25ToV26(db);
        upgradeV26ToV27(db);
        upgradeV27ToV28(db);
        upgradeV28ToV29(db);
        upgradeV29ToV30(db);
        upgradeV30ToV31(db);
        upgradeV31ToV32(db);
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
      if (current < 17) upgradeV16ToV17(db);
      if (current < 18) upgradeV17ToV18(db);
      if (current < 19) upgradeV18ToV19(db);
      if (current < 20) upgradeV19ToV20(db);
      if (current < 21) upgradeV20ToV21(db);
      if (current < 22) upgradeV21ToV22(db);
      if (current < 23) upgradeV22ToV23(db);
      if (current < 24) upgradeV23ToV24(db);
      if (current < 25) upgradeV24ToV25(db);
      if (current < 26) upgradeV25ToV26(db);
      if (current < 27) upgradeV26ToV27(db);
      if (current < 28) upgradeV27ToV28(db);
      if (current < 29) upgradeV28ToV29(db);
      if (current < 30) upgradeV29ToV30(db);
      if (current < 31) upgradeV30ToV31(db);
      if (current < 32) upgradeV31ToV32(db);
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
      collection_slug     TEXT REFERENCES collections (slug),
      -- Loan-aware aggregates (v18). loan_count is total loan cycles ever
      -- detected; active_loan_count is currently-open loans (origination
      -- without subsequent default/unlock). effective_owner is the
      -- "human-visible" owner: while a loan is open, it's the borrower
      -- (not the bc1p escrow address); on default, the lender; otherwise
      -- equals current_owner. Holders / leaderboards / per-holder pages
      -- read effective_owner so escrow taproot addresses don't surface
      -- as if they were collectors.
      loan_count          INTEGER NOT NULL DEFAULT 0,
      active_loan_count   INTEGER NOT NULL DEFAULT 0,
      effective_owner     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_insc_movement   ON inscriptions (last_movement_at);
    CREATE INDEX IF NOT EXISTS idx_insc_xfer_count ON inscriptions (transfer_count DESC);
    CREATE INDEX IF NOT EXISTS idx_insc_sale_count ON inscriptions (sale_count DESC);
    CREATE INDEX IF NOT EXISTS idx_insc_volume     ON inscriptions (total_volume_sats DESC);
    CREATE INDEX IF NOT EXISTS idx_insc_high_sale  ON inscriptions (highest_sale_sats DESC);
    CREATE INDEX IF NOT EXISTS idx_insc_owner      ON inscriptions (current_owner);
    CREATE INDEX IF NOT EXISTS idx_insc_eff_owner  ON inscriptions (effective_owner);
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
      event_type          TEXT    NOT NULL CHECK (event_type IN (
        'inscribed','transferred','sold','listed','mint',
        'loan-originated','loan-defaulted','loan-repaid','loan-unlocked'
      )),
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
    -- Backs the global-search "look up by raw txid" path. The existing
    -- UNIQUE (inscription_id, txid) autoindex can't satisfy WHERE txid = ?
    -- because txid isn't the leftmost column — without this, every txid
    -- search scans the entire events table.
    CREATE INDEX IF NOT EXISTS idx_events_txid            ON events (txid);

    -- Composite-PK shape (Phase 4). Per-collection rows for per-collection
    -- streams (satflow, satflow_listings); ord uses a single 'omb' row since
    -- one batch poll covers every inscription regardless of collection. The
    -- 'matrica' stream is also collection-agnostic — one row keyed to 'omb'.
    CREATE TABLE IF NOT EXISTS poll_state (
      stream                    TEXT NOT NULL CHECK (stream IN ('ord','satflow','satflow_listings','matrica','notify','loans','magisat_fp','magic_eden_fp','ord_net_fp','cluster')),
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
      ('notify', 'omb'),
      ('loans', 'omb'),
      ('magisat_fp', 'omb'),
      ('magic_eden_fp', 'omb'),
      ('ord_net_fp', 'omb'),
      ('cluster', 'omb');

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

    -- Holder roles (Phase 7). Derived from inscriptions.color counts per
    -- Matrica user. Recomputed every auto tick after loans finalize. Only
    -- Matrica-linked users get rows; unlinked wallets are excluded by design
    -- (link your profile to earn badges). \`rank\` denormalizes the index of
    -- the role in src/lib/roles.ts ROLES so leaderboard queries can ORDER BY
    -- rank without an IN-list join. \`earned_at\` is preserved across recomputes
    -- when the role survives the diff (informational; not currently surfaced).
    CREATE TABLE IF NOT EXISTS roles_earned (
      matrica_user_id TEXT    NOT NULL,
      role_id         TEXT    NOT NULL,
      rank            INTEGER NOT NULL,
      earned_at       INTEGER NOT NULL,
      PRIMARY KEY (matrica_user_id, role_id)
    );
    CREATE INDEX IF NOT EXISTS idx_roles_earned_role ON roles_earned (role_id);
    CREATE INDEX IF NOT EXISTS idx_roles_earned_user ON roles_earned (matrica_user_id);

    -- Phase 8: on-chain wallet clustering. Pairs stored in canonical order
    -- (addr_a < addr_b) so each unordered pair has exactly one row. Raw
    -- per-signal counts are preserved separately from the derived
    -- confidence so post-hoc threshold tweaks don't require a full
    -- recompute. evidence_json is capped at the most recent N items
    -- (see src/lib/cluster.ts EVIDENCE_CAP). See CLUSTERING.md for the
    -- signal definitions, calibration history, and tunables.
    CREATE TABLE IF NOT EXISTS wallet_cluster_edges (
      addr_a          TEXT    NOT NULL,
      addr_b          TEXT    NOT NULL,
      confidence      INTEGER NOT NULL,
      -- v1 signals (incremental in the live tick).
      cih_count       INTEGER NOT NULL DEFAULT 0,
      self_xfer_count INTEGER NOT NULL DEFAULT 0,
      self_xfer_ab    INTEGER NOT NULL DEFAULT 0,
      self_xfer_ba    INTEGER NOT NULL DEFAULT 0,
      -- v2 signals (recomputed globally by runClusterRecompute — they
      -- depend on whole-corpus fan-out maps, not per-event deltas).
      -- co_cons_count: # of distinct destinations that bridge two
      -- monogamous senders. co_parent_count: # of distinct non-MSR
      -- parents that distribute to two monogamous receivers. pmx*:
      -- direct A↔B transfers where one endpoint is a personal-MSR
      -- (consolidator that wasn't suppressed by the MSR gate). pmx_rt*:
      -- the subset of pmx events where the receiver previously owned
      -- the inscription — the strong "this was a round-trip" signal
      -- that distinguishes consolidation from cross-trader activity.
      co_cons_count   INTEGER NOT NULL DEFAULT 0,
      co_parent_count INTEGER NOT NULL DEFAULT 0,
      pmx_count       INTEGER NOT NULL DEFAULT 0,
      pmx_ab          INTEGER NOT NULL DEFAULT 0,
      pmx_ba          INTEGER NOT NULL DEFAULT 0,
      pmx_rt_count    INTEGER NOT NULL DEFAULT 0,
      pmx_rt_ab       INTEGER NOT NULL DEFAULT 0,
      pmx_rt_ba       INTEGER NOT NULL DEFAULT 0,
      evidence_json   TEXT    NOT NULL DEFAULT '[]',
      first_seen_at   INTEGER NOT NULL,
      last_seen_at    INTEGER NOT NULL,
      PRIMARY KEY (addr_a, addr_b),
      CHECK (addr_a < addr_b)
    );
    CREATE INDEX IF NOT EXISTS idx_cluster_edges_a    ON wallet_cluster_edges (addr_a, confidence DESC);
    CREATE INDEX IF NOT EXISTS idx_cluster_edges_b    ON wallet_cluster_edges (addr_b, confidence DESC);
    CREATE INDEX IF NOT EXISTS idx_cluster_edges_conf ON wallet_cluster_edges (confidence DESC);

    -- CIH-blacklist: addresses that co-input alongside unrelated parties
    -- (marketplace fee splices, Liquidium loan originations, mint
    -- distributions) plus auto-detected high-degree nodes (≥N distinct
    -- counterparties in a window). 'manual' is reserved for operator-set
    -- excludes that don't fit the other categories.
    CREATE TABLE IF NOT EXISTS cluster_blacklist (
      address  TEXT PRIMARY KEY,
      reason   TEXT NOT NULL CHECK (reason IN ('marketplace','liquidium','mint','auto-high-degree','manual')),
      degree   INTEGER,
      added_at INTEGER NOT NULL,
      notes    TEXT
    );

    -- Materialized connected-components at IDENTITY_FOLD_THRESHOLD (9900).
    -- One row per wallet that's a member of a non-singleton component;
    -- absent wallets fall through Matrica then their own address in
    -- leaderboard COALESCE chains. anchor_id is the canonical group key:
    -- when the component contains exactly one Matrica user, anchor_id =
    -- matrica_users.user_id (and matrica_user_id is set to enable display
    -- joins); when the component is unlinked-only, anchor_id = lex-min
    -- wallet address. Components with 2+ distinct Matrica users (rare —
    -- two real people who heavily co-spend) are skipped to keep authoritative
    -- Matrica linkage from being clobbered by heuristic merges. Recomputed
    -- every cluster tick from wallet_cluster_edges; cheap (<500 wallets at
    -- threshold).
    CREATE TABLE IF NOT EXISTS cluster_anchors (
      wallet_addr     TEXT PRIMARY KEY,
      anchor_id       TEXT NOT NULL,
      matrica_user_id TEXT REFERENCES matrica_users (user_id),
      cluster_size    INTEGER NOT NULL,
      computed_at     INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_cluster_anchors_anchor ON cluster_anchors (anchor_id);
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

function upgradeV16ToV17(db: DB): void {
  // Backs the global-search "lookup by raw txid" path. The existing
  // UNIQUE (inscription_id, txid) autoindex can't satisfy WHERE-on-txid-only
  // (txid isn't the leftmost column), so every txid search would otherwise
  // scan the entire events table.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_txid ON events (txid);`);
}

function upgradeV17ToV18(db: DB): void {
  // Widen events.event_type CHECK to allow the four loan event types
  // ('loan-originated','loan-defaulted','loan-repaid','loan-unlocked').
  // SQLite can't ALTER a CHECK in place — copy-and-swap, same pattern as
  // v3 / v6 / v9 / v12 / v14 / v16.
  //
  // History note: the prod DB had its user_version bumped to 18 by the first
  // (script-only) iteration of scripts/backfill-loans.js, which only widened
  // the events CHECK. This migration was promoted into db.ts to be the source
  // of truth; v18→v19 follows up with the inscription column additions.
  // Existing prod (already at v18 from the script) skips this and runs v19.
  db.exec(`
    CREATE TABLE events_v4 (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      inscription_id      TEXT    NOT NULL,
      inscription_number  INTEGER NOT NULL,
      event_type          TEXT    NOT NULL CHECK (event_type IN (
        'inscribed','transferred','sold','listed',
        'loan-originated','loan-defaulted','loan-repaid','loan-unlocked'
      )),
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
    INSERT INTO events_v4 SELECT * FROM events;
    DROP TABLE events;
    ALTER TABLE events_v4 RENAME TO events;
    CREATE INDEX IF NOT EXISTS idx_events_block_ts        ON events (block_timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_events_inscription_num ON events (inscription_number, block_timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_events_id_desc         ON events (id DESC);
    CREATE INDEX IF NOT EXISTS idx_events_type_id         ON events (event_type, id DESC);
    CREATE INDEX IF NOT EXISTS idx_events_type_ts_id      ON events (event_type, block_timestamp DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_events_new_owner_ts_id ON events (new_owner, block_timestamp DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_events_old_owner_ts_id ON events (old_owner, block_timestamp DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_events_txid            ON events (txid);
  `);
}

function upgradeV18ToV19(db: DB): void {
  // Loan-aware aggregates on inscriptions:
  //
  //   loan_count        — total loan cycles ever detected (lifetime).
  //   active_loan_count — currently-open loans (origination not yet
  //                       followed by default/unlock). Always 0 or 1 in
  //                       practice but typed as INTEGER for forward-compat.
  //   effective_owner   — "human-visible" owner. While a loan is open this
  //                       is the borrower (not the bc1p escrow taproot
  //                       address). Holders / leaderboards / per-holder
  //                       pages read this so escrow addrs don't surface
  //                       as if they were collectors. Initialized to
  //                       current_owner here; the loan backfill is the
  //                       only thing that diverges them.
  //
  // Idempotent ALTERs: probe table_info first so re-running the migration
  // (which can happen on prod where v18 was set by the script before this
  // db.ts upgrade existed) is safe.
  const cols = db.pragma('table_info(inscriptions)') as Array<{ name: string }>;
  const colNames = new Set(cols.map(c => c.name));
  if (!colNames.has('loan_count')) {
    db.exec(`ALTER TABLE inscriptions ADD COLUMN loan_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (!colNames.has('active_loan_count')) {
    db.exec(`ALTER TABLE inscriptions ADD COLUMN active_loan_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (!colNames.has('effective_owner')) {
    db.exec(`ALTER TABLE inscriptions ADD COLUMN effective_owner TEXT`);
    db.exec(
      `UPDATE inscriptions SET effective_owner = current_owner WHERE effective_owner IS NULL`
    );
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_insc_eff_owner ON inscriptions (effective_owner)`);
}

function upgradeV19ToV20(db: DB): void {
  // Forward-integration of loan detection: extend poll_state.stream CHECK
  // to allow 'loans' (the cursor for the per-tick incremental detector).
  // SQLite can't ALTER a CHECK in place — copy-and-swap, same pattern as
  // v6 / v9 / v12 / v14.
  db.exec(`
    CREATE TABLE poll_state_v20 (
      stream                    TEXT NOT NULL CHECK (stream IN ('ord','satflow','satflow_listings','matrica','notify','loans')),
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
    INSERT INTO poll_state_v20 SELECT * FROM poll_state;
    DROP TABLE poll_state;
    ALTER TABLE poll_state_v20 RENAME TO poll_state;
    INSERT OR IGNORE INTO poll_state (stream, collection_slug) VALUES ('loans', 'omb');
  `);
}

function upgradeV20ToV21(db: DB): void {
  // Self-transfer cleanup: an inscription getting respent within the same
  // wallet (postage move, UTXO consolidation, fee bump) is a real on-chain
  // event but isn't a "transfer" in the collection-circulation sense. They
  // dominated the most-transferred leaderboard (e.g. #83307312 had 85 self
  // shuffles vs 17 real transfers). Going forward, the ord poll skips
  // recording them at insert time. This migration deletes the historical
  // ones and recomputes per-inscription aggregates from the surviving rows.
  db.exec(`
    DELETE FROM events WHERE event_type = 'transferred' AND old_owner = new_owner;

    UPDATE inscriptions SET
      transfer_count = (
        SELECT COUNT(*) FROM events e
        WHERE e.inscription_number = inscriptions.inscription_number
          AND e.event_type = 'transferred'
      ),
      last_movement_at = (
        SELECT MAX(block_timestamp) FROM events e
        WHERE e.inscription_number = inscriptions.inscription_number
          AND e.event_type IN ('transferred','sold')
      ),
      last_event_at = (
        SELECT MAX(block_timestamp) FROM events e
        WHERE e.inscription_number = inscriptions.inscription_number
      );
  `);
}

function upgradeV21ToV22(db: DB): void {
  // Active loan escrow tracking. Liquidium's loan-origination tx is a
  // structurally-fingerprintable shape: vin[0] is P2TR (the OMB UTXO from
  // the borrower), vout[0] is P2TR (the escrow output), and there are
  // exactly 4 outputs total (escrow + principal-to-borrower + lender-change
  // + borrower-change). Combined with "destination address is single-use,
  // never spent, last-touched within 30 days" this filter lands on exactly
  // the active loan set (verified against ground truth).
  //
  // The detector is structural — it doesn't need to verify cryptographic
  // properties of the escrow's tap-tree (which we can't, since the script
  // tree is only revealed on script-path spend). When the loan eventually
  // resolves (default/unlock/repay), the row is removed because the
  // inscription's current_owner moves off the escrow address.
  //
  // Refreshed by `?mode=loan-escrows` poll — see `src/lib/loanEscrowDetect.ts`.
  db.exec(`
    CREATE TABLE active_loan_escrows (
      inscription_number INTEGER PRIMARY KEY,
      escrow_addr        TEXT    NOT NULL,
      funding_txid       TEXT    NOT NULL,
      funded_at          INTEGER NOT NULL,
      detected_at        INTEGER NOT NULL DEFAULT (unixepoch()),
      refreshed_at       INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (inscription_number) REFERENCES inscriptions (inscription_number) ON DELETE CASCADE
    );
    CREATE INDEX idx_ale_funded_at ON active_loan_escrows (funded_at DESC);
  `);

  // Extend poll_state.stream CHECK to allow 'loan_escrows' (the cursor for
  // the per-tick refresh of active_loan_escrows). SQLite can't ALTER a
  // CHECK in place — copy-and-swap, same pattern as previous extensions.
  db.exec(`
    CREATE TABLE poll_state_v22 (
      stream                    TEXT NOT NULL CHECK (stream IN ('ord','satflow','satflow_listings','matrica','notify','loans','loan_escrows')),
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
    INSERT INTO poll_state_v22 SELECT * FROM poll_state;
    DROP TABLE poll_state;
    ALTER TABLE poll_state_v22 RENAME TO poll_state;
    INSERT OR IGNORE INTO poll_state (stream, collection_slug) VALUES ('loan_escrows', 'omb');
  `);
}

function upgradeV22ToV23(db: DB): void {
  // Add 'mint' to events.event_type CHECK so primary-mint distributions
  // (e.g. green-eye outflows from bc1pyl6g…qreeqpw in 2023) can be
  // distinguished from secondary-market sales. Then reclassify matching
  // historical events and recompute aggregates so mint prices stop
  // counting toward sale-volume / highest-sale leaderboards.
  //
  // SQLite can't ALTER a CHECK in place — copy-and-swap, same pattern as
  // v3 / v6 / v9 / v12 / v14 / v16.
  db.exec(`
    CREATE TABLE events_v5 (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      inscription_id      TEXT    NOT NULL,
      inscription_number  INTEGER NOT NULL,
      event_type          TEXT    NOT NULL CHECK (event_type IN (
        'inscribed','transferred','sold','listed','mint',
        'loan-originated','loan-defaulted','loan-repaid','loan-unlocked'
      )),
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
    INSERT INTO events_v5 SELECT * FROM events;
    DROP TABLE events;
    ALTER TABLE events_v5 RENAME TO events;
    CREATE INDEX IF NOT EXISTS idx_events_block_ts        ON events (block_timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_events_inscription_num ON events (inscription_number, block_timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_events_id_desc         ON events (id DESC);
    CREATE INDEX IF NOT EXISTS idx_events_type_id         ON events (event_type, id DESC);
    CREATE INDEX IF NOT EXISTS idx_events_type_ts_id      ON events (event_type, block_timestamp DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_events_new_owner_ts_id ON events (new_owner, block_timestamp DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_events_old_owner_ts_id ON events (old_owner, block_timestamp DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_events_txid            ON events (txid);
  `);

  // Reclassify primary-mint events. Three constraints applied per wallet:
  //   1. old_owner = wallet's addr
  //   2. inscription's color matches the wallet's registered color (the
  //      black wallet has 2 outflows of red eyes that are NOT mints)
  //   3. block_timestamp <= valid_until_ts (orange and black still hold
  //      OMBs and do post-mint regular transfers; without the time bound
  //      those would mis-tag)
  const reclassify = db.prepare(`
    UPDATE events
       SET event_type = 'mint',
           marketplace = NULL
     WHERE old_owner = @addr
       AND block_timestamp <= @valid_until_ts
       AND inscription_number IN (
         SELECT inscription_number FROM inscriptions WHERE color = @color
       )
       AND event_type IN ('transferred','sold')
  `);
  for (const w of MINT_WALLETS) {
    reclassify.run({ addr: w.addr, color: w.color, valid_until_ts: w.valid_until_ts });
  }

  // Recompute aggregates on affected inscriptions so mint events don't
  // count as transfers or sales. Affected = any inscription that now has
  // a 'mint' event.
  db.exec(`
    UPDATE inscriptions AS i
       SET transfer_count = (
             SELECT COUNT(*) FROM events e
              WHERE e.inscription_number = i.inscription_number
                AND e.event_type = 'transferred'
           ),
           sale_count = (
             SELECT COUNT(*) FROM events e
              WHERE e.inscription_number = i.inscription_number
                AND e.event_type = 'sold'
           ),
           total_volume_sats = (
             SELECT COALESCE(SUM(e.sale_price_sats),0) FROM events e
              WHERE e.inscription_number = i.inscription_number
                AND e.event_type = 'sold'
           ),
           highest_sale_sats = (
             SELECT COALESCE(MAX(e.sale_price_sats),0) FROM events e
              WHERE e.inscription_number = i.inscription_number
                AND e.event_type = 'sold'
           )
     WHERE i.inscription_number IN (
       SELECT DISTINCT inscription_number FROM events WHERE event_type = 'mint'
     );
  `);
}

function upgradeV23ToV24(db: DB): void {
  // v23 only registered the green mint wallet. v24 adds the remaining
  // four (blue, red, orange, black) AND introduces a per-wallet time
  // bound (`block_timestamp <= valid_until_ts`) so post-mint regular
  // transfers from still-active wallets (orange, black) don't mis-tag
  // as mints. See ONCHAIN_TAGGING.md §2.1 for window evidence.
  //
  // Idempotent: the UPDATE only flips rows still in 'transferred'/'sold'.
  // For prod (already at v23 with greens reclassified) this catches the
  // 4 new wallets. For fresh DBs (v23 modified to handle all 5 already)
  // this is a no-op.

  const reclassify = db.prepare(`
    UPDATE events
       SET event_type = 'mint',
           marketplace = NULL
     WHERE old_owner = @addr
       AND block_timestamp <= @valid_until_ts
       AND inscription_number IN (
         SELECT inscription_number FROM inscriptions WHERE color = @color
       )
       AND event_type IN ('transferred','sold')
  `);
  for (const w of MINT_WALLETS) {
    reclassify.run({ addr: w.addr, color: w.color, valid_until_ts: w.valid_until_ts });
  }

  // Recompute aggregates on every inscription that now has any mint
  // event so transfer_count / sale_count / total_volume_sats /
  // highest_sale_sats reflect secondary-market activity only.
  //
  // Single-pass GROUP BY + UPDATE...FROM is ~100× faster than the
  // per-row correlated-subquery pattern v23 used; with ~6,800 affected
  // inscriptions on prod the v23 shape would tie up the connection
  // long enough to risk the app's startup probe. SQLite ≥ 3.33
  // supports UPDATE...FROM (better-sqlite3 ships ≥ 3.42).
  db.exec(`
    WITH agg AS (
      SELECT e.inscription_number                                                       AS num,
             SUM(CASE WHEN e.event_type = 'transferred' THEN 1 ELSE 0 END)              AS xfer,
             SUM(CASE WHEN e.event_type = 'sold'        THEN 1 ELSE 0 END)              AS sold_n,
             COALESCE(SUM(CASE WHEN e.event_type='sold' THEN e.sale_price_sats END),0)  AS vol,
             COALESCE(MAX(CASE WHEN e.event_type='sold' THEN e.sale_price_sats END),0)  AS hi
      FROM events e
      WHERE e.inscription_number IN (
        SELECT DISTINCT inscription_number FROM events WHERE event_type = 'mint'
      )
      GROUP BY e.inscription_number
    )
    UPDATE inscriptions
       SET transfer_count    = agg.xfer,
           sale_count        = agg.sold_n,
           total_volume_sats = agg.vol,
           highest_sale_sats = agg.hi
      FROM agg
     WHERE inscriptions.inscription_number = agg.num;
  `);
}

function upgradeV24ToV25(db: DB): void {
  // Add the 'magisat_fp' poll stream — cursor for the live Magisat
  // fingerprint detector that walks new `transferred` events and upgrades
  // them to `sold` + marketplace='magisat' when the on-chain fingerprint
  // matches (ONCHAIN_TAGGING.md §2.7).
  //
  // SQLite can't ALTER a CHECK in place — copy-and-swap, same pattern as
  // v6 / v9 / v12 / v14 / v20 / v22.
  //
  // Cursor bootstrap: leave last_cursor NULL so the first live tick jumps to
  // current MAX(events.id) instead of replaying 36k+ historical transferred
  // rows. Operators run scripts/backfill-magisat-fingerprint.js for the
  // historical sweep.
  db.exec(`
    CREATE TABLE poll_state_v25 (
      stream                    TEXT NOT NULL CHECK (stream IN ('ord','satflow','satflow_listings','matrica','notify','loans','loan_escrows','magisat_fp')),
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
    INSERT INTO poll_state_v25 SELECT * FROM poll_state;
    DROP TABLE poll_state;
    ALTER TABLE poll_state_v25 RENAME TO poll_state;
    INSERT OR IGNORE INTO poll_state (stream, collection_slug) VALUES ('magisat_fp', 'omb');
  `);
}

function upgradeV25ToV26(db: DB): void {
  // Phase 7 teardown + onchain-coop-heuristic revert.
  //
  // Per ONCHAIN_TAGGING.md §7.1 / §7.3 — "tear out anything we are not sure
  // about" — this migration:
  //
  //   1. Reverts the 5,085 `onchain-coop-heuristic` `sold` events back to
  //      `transferred` and clears their marketplace + sale_price_sats. The
  //      Layer 2 cooperative-sale detector had at least one verified false
  //      positive (#83309450) and structural shape between real cooperative
  //      sales and coincidental flows can't be separated on-chain. Stamps
  //      raw_json.source = 'reverted-from-coop-heuristic' for traceability so
  //      we can audit how many real sales we lost if we ever revisit.
  //
  //   2. Drops `active_loan_escrows` (Phase 7) entirely. ONCHAIN_TAGGING.md
  //      §2.3 proves there is no cryptographic on-chain proof for currently-
  //      active Liquidium loans — the previous detector populated false positives.
  //      The loan-escrows poll mode and loanEscrowDetect.ts are removed in the
  //      same commit. /explorer/currently-loaned was later restored from the
  //      event-lifecycle `inscriptions.active_loan_count` aggregate, not from
  //      escrow-address probing.
  //
  //   3. Removes 'loan_escrows' from poll_state.stream CHECK + drops the row.
  //
  //   4. Recomputes per-inscription aggregates so transfer_count, sale_count,
  //      total_volume_sats, and highest_sale_sats reflect the reverted rows.
  //      Single-pass GROUP BY + UPDATE...FROM (same shape as v24).
  //
  // Cleanup of the 3 historical loan-* events with non-Liquidium internal
  // pubkeys (§7.2) is handled out-of-band by `scripts/cleanup-non-liquidium-
  // loans.js` because identifying them requires bitcoind RPC to re-check each
  // event's witness — not safe inside a sync migration.

  db.exec(`
    UPDATE events
       SET event_type      = 'transferred',
           marketplace     = NULL,
           sale_price_sats = NULL,
           raw_json        = json_set(
             COALESCE(raw_json, '{}'),
             '$.source',      'reverted-from-coop-heuristic',
             '$.reverted_at', unixepoch(),
             '$.prior_source','onchain-coop-heuristic'
           )
     WHERE event_type = 'sold'
       AND json_extract(raw_json, '$.source') = 'onchain-coop-heuristic';
  `);

  db.exec(`DROP TABLE IF EXISTS active_loan_escrows;`);

  db.exec(`
    CREATE TABLE poll_state_v26 (
      stream                    TEXT NOT NULL CHECK (stream IN ('ord','satflow','satflow_listings','matrica','notify','loans','magisat_fp')),
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
    INSERT INTO poll_state_v26
      SELECT * FROM poll_state WHERE stream != 'loan_escrows';
    DROP TABLE poll_state;
    ALTER TABLE poll_state_v26 RENAME TO poll_state;
  `);

  // Recompute aggregates for every inscription whose row count changed.
  // Affected = inscriptions referenced by any reverted event. Cheaper to
  // simply recompute over every inscription that has at least one event,
  // since v25→v26 only runs once and the aggregate query is bounded.
  db.exec(`
    WITH agg AS (
      SELECT e.inscription_number                                                       AS num,
             SUM(CASE WHEN e.event_type = 'transferred' THEN 1 ELSE 0 END)              AS xfer,
             SUM(CASE WHEN e.event_type = 'sold'        THEN 1 ELSE 0 END)              AS sold_n,
             COALESCE(SUM(CASE WHEN e.event_type='sold' THEN e.sale_price_sats END),0)  AS vol,
             COALESCE(MAX(CASE WHEN e.event_type='sold' THEN e.sale_price_sats END),0)  AS hi
      FROM events e
      WHERE e.inscription_number IN (
        SELECT DISTINCT inscription_number FROM events
         WHERE json_extract(raw_json, '$.source') = 'reverted-from-coop-heuristic'
      )
      GROUP BY e.inscription_number
    )
    UPDATE inscriptions
       SET transfer_count    = agg.xfer,
           sale_count        = agg.sold_n,
           total_volume_sats = agg.vol,
           highest_sale_sats = agg.hi
      FROM agg
     WHERE inscriptions.inscription_number = agg.num;
  `);
}

function upgradeV26ToV27(db: DB): void {
  // Add the 'magic_eden_fp' poll stream — cursor for the live Magic Eden
  // fingerprint detector, sibling to the existing magisat tagger
  // (ONCHAIN_TAGGING.md §2.10). Same shape as v25's `magisat_fp` add: copy-
  // and-swap the CHECK constraint, leave last_cursor NULL so the first live
  // tick bootstraps to current MAX(events.id) and operators run
  // scripts/backfill-magic-eden-fingerprint.js for the historical sweep.
  db.exec(`
    CREATE TABLE poll_state_v27 (
      stream                    TEXT NOT NULL CHECK (stream IN ('ord','satflow','satflow_listings','matrica','notify','loans','magisat_fp','magic_eden_fp')),
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
    INSERT INTO poll_state_v27 SELECT * FROM poll_state;
    DROP TABLE poll_state;
    ALTER TABLE poll_state_v27 RENAME TO poll_state;
    INSERT OR IGNORE INTO poll_state (stream, collection_slug) VALUES ('magic_eden_fp', 'omb');
  `);
}

function upgradeV27ToV28(db: DB): void {
  // Add the 'ord_net_fp' poll stream — cursor for the live ord.net
  // fingerprint detector (ONCHAIN_TAGGING.md §2.11). Same shape as v25 / v27:
  // copy-and-swap the CHECK constraint, leave last_cursor NULL so the first
  // live tick bootstraps to current MAX(events.id) and operators run
  // scripts/backfill-ord-net-fingerprint.js for the historical sweep.
  db.exec(`
    CREATE TABLE poll_state_v28 (
      stream                    TEXT NOT NULL CHECK (stream IN ('ord','satflow','satflow_listings','matrica','notify','loans','magisat_fp','magic_eden_fp','ord_net_fp')),
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
    INSERT INTO poll_state_v28 SELECT * FROM poll_state;
    DROP TABLE poll_state;
    ALTER TABLE poll_state_v28 RENAME TO poll_state;
    INSERT OR IGNORE INTO poll_state (stream, collection_slug) VALUES ('ord_net_fp', 'omb');
  `);
}

function upgradeV28ToV29(db: DB): void {
  // Phase 7: holder roles. Pure additive — adds the roles_earned derived
  // table. The runRolesTick step in the auto poll populates it on the next
  // tick after deploy; until then queries against it return zero rows
  // (badges simply don't render).
  db.exec(`
    CREATE TABLE IF NOT EXISTS roles_earned (
      matrica_user_id TEXT    NOT NULL,
      role_id         TEXT    NOT NULL,
      rank            INTEGER NOT NULL,
      earned_at       INTEGER NOT NULL,
      PRIMARY KEY (matrica_user_id, role_id)
    );
    CREATE INDEX IF NOT EXISTS idx_roles_earned_role ON roles_earned (role_id);
    CREATE INDEX IF NOT EXISTS idx_roles_earned_user ON roles_earned (matrica_user_id);
  `);
}

function upgradeV29ToV30(db: DB): void {
  // Phase 8: on-chain wallet clustering. Adds `wallet_cluster_edges`
  // (undirected pairs in canonical order with a confidence score and a
  // capped JSON evidence trail), `cluster_blacklist` (addresses that
  // multiplex unrelated parties — marketplace fee outputs, Liquidium
  // pubkey, mint wallets, plus auto-detected high-degree nodes), and
  // adds the 'cluster' poll_state stream so the live tick can advance
  // an event-id cursor without re-walking history. Existing poll_state
  // rows are preserved via copy-and-swap (sole reason we touch that
  // table — confidence stays out of it).
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallet_cluster_edges (
      addr_a          TEXT    NOT NULL,
      addr_b          TEXT    NOT NULL,
      -- Confidence in [0,10000]; readers divide by 10000.
      confidence      INTEGER NOT NULL,
      cih_count       INTEGER NOT NULL DEFAULT 0,
      self_xfer_count INTEGER NOT NULL DEFAULT 0,
      self_xfer_ab    INTEGER NOT NULL DEFAULT 0,
      self_xfer_ba    INTEGER NOT NULL DEFAULT 0,
      -- Capped JSON array of {type,txid,ts,direction?}. Most-recent N retained.
      evidence_json   TEXT    NOT NULL DEFAULT '[]',
      first_seen_at   INTEGER NOT NULL,
      last_seen_at    INTEGER NOT NULL,
      PRIMARY KEY (addr_a, addr_b),
      CHECK (addr_a < addr_b)
    );
    CREATE INDEX IF NOT EXISTS idx_cluster_edges_a    ON wallet_cluster_edges (addr_a, confidence DESC);
    CREATE INDEX IF NOT EXISTS idx_cluster_edges_b    ON wallet_cluster_edges (addr_b, confidence DESC);
    CREATE INDEX IF NOT EXISTS idx_cluster_edges_conf ON wallet_cluster_edges (confidence DESC);

    CREATE TABLE IF NOT EXISTS cluster_blacklist (
      address  TEXT PRIMARY KEY,
      reason   TEXT NOT NULL CHECK (reason IN ('marketplace','liquidium','mint','auto-high-degree','manual')),
      degree   INTEGER,
      added_at INTEGER NOT NULL,
      notes    TEXT
    );

    CREATE TABLE poll_state_v30 (
      stream                    TEXT NOT NULL CHECK (stream IN ('ord','satflow','satflow_listings','matrica','notify','loans','magisat_fp','magic_eden_fp','ord_net_fp','cluster')),
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
    INSERT INTO poll_state_v30 SELECT * FROM poll_state;
    DROP TABLE poll_state;
    ALTER TABLE poll_state_v30 RENAME TO poll_state;
    INSERT OR IGNORE INTO poll_state (stream, collection_slug) VALUES ('cluster', 'omb');
  `);
}

function upgradeV31ToV32(db: DB): void {
  // Phase 8.1: extend wallet_cluster_edges with v2 signals — co-consolidator
  // (cc), co-parent (cp), personal-MSR self-xfer (pmx), and round-trip
  // subset of pmx (pmx_rt). All purely additive — no row rewrite.
  // See CLUSTERING.md for the signal definitions and the calibration
  // background.
  const cols = db.pragma('table_info(wallet_cluster_edges)') as Array<{ name: string }>;
  const have = new Set(cols.map(c => c.name));
  const adds: Array<[string, string]> = [
    ['co_cons_count',   `INTEGER NOT NULL DEFAULT 0`],
    ['co_parent_count', `INTEGER NOT NULL DEFAULT 0`],
    ['pmx_count',       `INTEGER NOT NULL DEFAULT 0`],
    ['pmx_ab',          `INTEGER NOT NULL DEFAULT 0`],
    ['pmx_ba',          `INTEGER NOT NULL DEFAULT 0`],
    ['pmx_rt_count',    `INTEGER NOT NULL DEFAULT 0`],
    ['pmx_rt_ab',       `INTEGER NOT NULL DEFAULT 0`],
    ['pmx_rt_ba',       `INTEGER NOT NULL DEFAULT 0`],
  ];
  for (const [name, def] of adds) {
    if (!have.has(name)) {
      db.exec(`ALTER TABLE wallet_cluster_edges ADD COLUMN ${name} ${def}`);
    }
  }
}

function upgradeV30ToV31(db: DB): void {
  // Materialize connected components at IDENTITY_FOLD_THRESHOLD so the
  // top-holders leaderboard, color leaderboards, holder distribution
  // histogram, and per-holder aggregation can fold high-confidence (99%+)
  // inferred peers into the canonical identity alongside Matrica siblings.
  // Schema only — population happens in runClusterTick on the next tick
  // (or via the backfill script's existing one-shot path).
  db.exec(`
    CREATE TABLE IF NOT EXISTS cluster_anchors (
      wallet_addr     TEXT PRIMARY KEY,
      anchor_id       TEXT NOT NULL,
      matrica_user_id TEXT REFERENCES matrica_users (user_id),
      cluster_size    INTEGER NOT NULL,
      computed_at     INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_cluster_anchors_anchor ON cluster_anchors (anchor_id);
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
  findEventByMovement: ReturnType<DB['prepare']>;
  upgradeEventToSoldById: ReturnType<DB['prepare']>;
  mergeOrdEnrichmentIntoSold: ReturnType<DB['prepare']>;
  getEventById: ReturnType<DB['prepare']>;
  deleteEventById: ReturnType<DB['prepare']>;
  unbumpSoldOnDelete: ReturnType<DB['prepare']>;
  unbumpTransferOnDelete: ReturnType<DB['prepare']>;
  recomputeHighestSale: ReturnType<DB['prepare']>;
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
  getRecentLoanEvents: ReturnType<DB['prepare']>;
  getRecentLoanEventsAfter: ReturnType<DB['prepare']>;
  countEvents: ReturnType<DB['prepare']>;
  countHolders: ReturnType<DB['prepare']>;
  getInscription: ReturnType<DB['prepare']>;
  getInscriptionEvents: ReturnType<DB['prepare']>;
  getAllInscriptionEvents: ReturnType<DB['prepare']>;
  otherInscriptionsByOwner: ReturnType<DB['prepare']>;
  getInscriptionsByOwner: ReturnType<DB['prepare']>;
  firstInscriptionByOwner: ReturnType<DB['prepare']>;
  getEventsByAddress: ReturnType<DB['prepare']>;
  getEventsByAddressBefore: ReturnType<DB['prepare']>;
  countEventsByAddress: ReturnType<DB['prepare']>;
  // leaderboards
  topByTransfers: ReturnType<DB['prepare']>;
  topByLongestUnmoved: ReturnType<DB['prepare']>;
  topByVolume: ReturnType<DB['prepare']>;
  topByHighestSale: ReturnType<DB['prepare']>;
  topByLoans: ReturnType<DB['prepare']>;
  topByActiveLoans: ReturnType<DB['prepare']>;
  topHolders: ReturnType<DB['prepare']>;
  // leaderboards (cursor-paginated, with stable secondary sort by
  // inscription_number for keyset pagination on the /explorer/[type] detail
  // pages).
  topByTransfersPaged: ReturnType<DB['prepare']>;
  topByLongestUnmovedPaged: ReturnType<DB['prepare']>;
  topByVolumePaged: ReturnType<DB['prepare']>;
  topByHighestSalePaged: ReturnType<DB['prepare']>;
  topByLoansPaged: ReturnType<DB['prepare']>;
  topByActiveLoansPaged: ReturnType<DB['prepare']>;
  topHoldersGroupedPaged: ReturnType<DB['prepare']>;
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
  getMatricaProfilesForAddrsWithInferred: ReturnType<DB['prepare']>;
  topHoldersGrouped: ReturnType<DB['prepare']>;
  countHolderIdentities: ReturnType<DB['prepare']>;
  // charts
  holderDistributionBuckets: ReturnType<DB['prepare']>;
  holdingDurationBuckets: ReturnType<DB['prepare']>;
  transferActivityByDay: ReturnType<DB['prepare']>;
  ownershipChangesByAddress: ReturnType<DB['prepare']>;
  holderColorHighlights: ReturnType<DB['prepare']>;
  // global search
  searchInscriptionByNumber: ReturnType<DB['prepare']>;
  searchInscriptionById: ReturnType<DB['prepare']>;
  searchInscriptionsByIdPrefix: ReturnType<DB['prepare']>;
  searchEventsByTxid: ReturnType<DB['prepare']>;
  searchHolderByAddress: ReturnType<DB['prepare']>;
  searchHoldersBySuffix: ReturnType<DB['prepare']>;
  searchUsersByName: ReturnType<DB['prepare']>;
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
      SET current_output  = @current_output,
          current_owner   = @current_owner,
          -- effective_owner mirrors current_owner here (the on-chain truth).
          -- The loan backfill is the only writer that diverges them: when
          -- it detects an inscription is currently in escrow, it overwrites
          -- effective_owner to the borrower. That overwrite happens AFTER
          -- ord ticks, so the brief window between an ord tick observing
          -- a transfer-into-escrow and the loan backfill catching it shows
          -- the escrow address as owner — acceptable.
          effective_owner = @current_owner,
          inscription_id  = COALESCE(inscriptions.inscription_id, @inscription_id)
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
    // the sale is strictly newer than anything we already know about. Run
    // BEFORE bumpInscriptionAggregates (which advances last_movement_at).
    // Strict `>` (not `>=`) so a backfilled historical sale can't clobber the
    // chain-final owner when sale + transfer share a block (timestamps tie).
    setInscriptionOwnerIfNewer: db.prepare(`
      UPDATE inscriptions
      SET current_owner   = @new_owner,
          effective_owner = @new_owner
      WHERE inscription_number = @inscription_number
        AND @new_owner IS NOT NULL
        AND (last_movement_at IS NULL OR @block_timestamp > last_movement_at)
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
      SELECT id, event_type, inscription_number, new_owner
      FROM events
      WHERE inscription_id = @inscription_id AND txid = @txid
    `),

    // Secondary match for the same on-chain movement when txid differs across
    // sources. Used when satflow's `fillTx` (marketplace order tx) does not
    // match the actual UTXO-moving txid that ord observes — without this, the
    // primary (inscription_id, txid) lookup misses and we end up with a
    // duplicate row for the same effective transfer. Block_timestamp is part
    // of the key to avoid mismatching an A→B→A→B owner cycle to an older
    // event. Returns whichever event_type is present so callers can branch:
    // a 'sold' match means already-counted (skip), a 'transferred' match
    // means upgrade-in-place. Prefers 'sold' if both exist (degenerate state).
    findEventByMovement: db.prepare(`
      SELECT id, event_type, inscription_number, txid, block_height
      FROM events
      WHERE inscription_id  = @inscription_id
        AND old_owner       IS @old_owner
        AND new_owner       IS @new_owner
        AND block_timestamp = @block_timestamp
        AND event_type IN ('transferred','sold')
      ORDER BY CASE event_type WHEN 'sold' THEN 0 ELSE 1 END
      LIMIT 1
    `),

    // Used by satflow's secondary-match path: an existing 'transferred' row
    // already has ord's authoritative txid + block_height. We only stamp
    // marketplace + price + raw_json onto it; ord's chain data is preserved.
    upgradeEventToSoldById: db.prepare(`
      UPDATE events
      SET event_type      = 'sold',
          marketplace     = @marketplace,
          sale_price_sats = @sale_price_sats,
          raw_json        = COALESCE(@raw_json, raw_json)
      WHERE id = @id AND event_type = 'transferred'
    `),

    // Used by ord's secondary-match path: a 'sold' row was inserted standalone
    // by satflow earlier (with a synthetic fillTx). Replace the satflow txid
    // with ord's authoritative on-chain txid + block_height + new_satpoint.
    // Preserves marketplace / sale_price_sats / raw_json.
    mergeOrdEnrichmentIntoSold: db.prepare(`
      UPDATE events
      SET txid            = @txid,
          block_height    = @block_height,
          block_timestamp = @block_timestamp,
          new_satpoint    = COALESCE(@new_satpoint, new_satpoint)
      WHERE id = @id AND event_type = 'sold'
    `),

    // Read a single event row by id — used by the transferTx-cleanup path to
    // recover the row's `sale_price_sats` before deletion so aggregates can be
    // unbumped accurately.
    getEventById: db.prepare(`
      SELECT id, inscription_number, event_type, sale_price_sats
      FROM events WHERE id = @id
    `),

    // Used by satflow apply to clean up the spurious second row written for a
    // 2-tx escrow-style settlement (`transferTx` hop). The notify_pending FK
    // is ON DELETE CASCADE, so any queued alert for this row is also dropped.
    deleteEventById: db.prepare(`DELETE FROM events WHERE id = @id`),

    // Undo the aggregates a sold row contributed when it was first written.
    // Pairs with deleteEventById; recomputeHighestSale must be called after
    // since highest_sale is MAX-derived, not delta-tracked.
    unbumpSoldOnDelete: db.prepare(`
      UPDATE inscriptions
         SET sale_count        = MAX(sale_count - 1, 0),
             total_volume_sats = MAX(total_volume_sats - COALESCE(@sale_price_sats, 0), 0)
       WHERE inscription_number = @inscription_number
    `),
    // Same for a transferred row.
    unbumpTransferOnDelete: db.prepare(`
      UPDATE inscriptions
         SET transfer_count = MAX(transfer_count - 1, 0)
       WHERE inscription_number = @inscription_number
    `),
    // Recompute highest_sale_sats from the surviving sold rows. Run after any
    // delete that might have been the previous max.
    recomputeHighestSale: db.prepare(`
      UPDATE inscriptions
         SET highest_sale_sats = COALESCE((
               SELECT MAX(sale_price_sats) FROM events
                WHERE inscription_number = @inscription_number AND event_type = 'sold'
             ), 0)
       WHERE inscription_number = @inscription_number
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
    // The activity feed scopes events through their inscription's CURRENT
    // owner: an inscription parked in an excluded wallet (treasury) drops
    // from the feed entirely, including its prior history. This stays
    // consistent with the leaderboard exclusion — same set of inscriptions
    // hidden everywhere.
    getRecentEvents: db.prepare(`
      SELECT e.* FROM events e
      JOIN inscriptions i ON i.inscription_number = e.inscription_number
      WHERE i.collection_slug = @collection
        AND (@color IS NULL OR i.color = @color)
        AND e.event_type != 'listed'
        AND (i.current_owner IS NULL OR i.current_owner NOT IN (${SQL_EXCLUDED_OWNERS_LIST}))
      ORDER BY e.block_timestamp DESC, e.id DESC
      LIMIT @limit
    `),

    getRecentEventsAfter: db.prepare(`
      SELECT e.* FROM events e
      JOIN inscriptions i ON i.inscription_number = e.inscription_number
      WHERE i.collection_slug = @collection
        AND (@color IS NULL OR i.color = @color)
        AND e.event_type != 'listed'
        AND (i.current_owner IS NULL OR i.current_owner NOT IN (${SQL_EXCLUDED_OWNERS_LIST}))
        AND (e.block_timestamp, e.id) < (@cursor_ts, @cursor_id)
      ORDER BY e.block_timestamp DESC, e.id DESC
      LIMIT @limit
    `),

    getRecentEventsByType: db.prepare(`
      SELECT e.* FROM events e
      JOIN inscriptions i ON i.inscription_number = e.inscription_number
      WHERE e.event_type = @event_type AND i.collection_slug = @collection
        AND (@color IS NULL OR i.color = @color)
        AND (i.current_owner IS NULL OR i.current_owner NOT IN (${SQL_EXCLUDED_OWNERS_LIST}))
      ORDER BY e.block_timestamp DESC, e.id DESC
      LIMIT @limit
    `),

    getRecentEventsByTypeAfter: db.prepare(`
      SELECT e.* FROM events e
      JOIN inscriptions i ON i.inscription_number = e.inscription_number
      WHERE e.event_type = @event_type AND i.collection_slug = @collection
        AND (@color IS NULL OR i.color = @color)
        AND (i.current_owner IS NULL OR i.current_owner NOT IN (${SQL_EXCLUDED_OWNERS_LIST}))
        AND (e.block_timestamp, e.id) < (@cursor_ts, @cursor_id)
      ORDER BY e.block_timestamp DESC, e.id DESC
      LIMIT @limit
    `),

    getRecentLoanEvents: db.prepare(`
      SELECT e.* FROM events e
      JOIN inscriptions i ON i.inscription_number = e.inscription_number
      WHERE e.event_type IN ('loan-originated','loan-defaulted','loan-repaid','loan-unlocked')
        AND i.collection_slug = @collection
        AND (@color IS NULL OR i.color = @color)
        AND (i.current_owner IS NULL OR i.current_owner NOT IN (${SQL_EXCLUDED_OWNERS_LIST}))
      ORDER BY e.block_timestamp DESC, e.id DESC
      LIMIT @limit
    `),

    getRecentLoanEventsAfter: db.prepare(`
      SELECT e.* FROM events e
      JOIN inscriptions i ON i.inscription_number = e.inscription_number
      WHERE e.event_type IN ('loan-originated','loan-defaulted','loan-repaid','loan-unlocked')
        AND i.collection_slug = @collection
        AND (@color IS NULL OR i.color = @color)
        AND (i.current_owner IS NULL OR i.current_owner NOT IN (${SQL_EXCLUDED_OWNERS_LIST}))
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
        AND (i.current_owner IS NULL OR i.current_owner NOT IN (${SQL_EXCLUDED_OWNERS_LIST}))
    `),

    // Holders are derived from inscriptions.effective_owner — distinct
    // human-visible owners (re-attributing inscriptions in loan escrow back
    // to their borrower). Mirrors countEvents in excluding protocol wallets
    // so the two stats shown side-by-side on the activity feed describe the
    // same population.
    countHolders: db.prepare(`
      SELECT COUNT(DISTINCT effective_owner) AS n
      FROM inscriptions
      WHERE effective_owner IS NOT NULL
        AND collection_slug = @collection
        AND (@color IS NULL OR color = @color)
        AND effective_owner NOT IN (${SQL_EXCLUDED_OWNERS_LIST})
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
    // Uses effective_owner so a borrower's strip still shows inscriptions
    // they have parked in loan escrow.
    otherInscriptionsByOwner: db.prepare(`
      SELECT inscription_number
      FROM inscriptions
      WHERE effective_owner = @owner
        AND inscription_number != @exclude
        AND collection_slug = @collection
      ORDER BY inscription_number
      LIMIT @limit
    `),

    // Holder profile: every inscription this address currently owns in a given
    // collection. Uses effective_owner so a borrower sees inscriptions
    // currently in their loan escrows; the on-chain bc1p escrow address
    // doesn't get a (mostly-empty) profile page of its own. Walks
    // idx_insc_eff_owner; the per-collection filter narrows the result via
    // idx_insc_collection. Returns inscription_number ASC for stable grid
    // ordering across reloads.
    getInscriptionsByOwner: db.prepare(`
      SELECT * FROM inscriptions
      WHERE effective_owner = @owner
        AND collection_slug = @collection
      ORDER BY inscription_number ASC
    `),

    // Holder OG-image fast-path: lowest-numbered inscription this address
    // owns in a given collection. Same access pattern as getInscriptionsByOwner
    // but returns one row, one column — used by /holder/[address] metadata
    // generation when no Matrica avatar is available.
    firstInscriptionByOwner: db.prepare(`
      SELECT inscription_number FROM inscriptions
      WHERE effective_owner = @owner
        AND collection_slug = @collection
      ORDER BY inscription_number ASC
      LIMIT 1
    `),

    // Holder profile: events where the address shows up on either side of a
    // transfer/sale (`new_owner` / `old_owner`), OR is the borrower/lender on
    // a loan event (via raw_json). Sorted (block_timestamp, id) DESC.
    // UNION ALL'd four lookups since SQLite won't pick a single index for
    // a disjunction across them; outer ORDER BY merges. At the LIMIT we use
    // (50) the cost is negligible.
    //
    // The two raw_json branches cover the case where a user borrowed an
    // inscription (so the on-chain old_owner is the user, captured by the
    // primary branch) and then it defaulted (where old_owner=escrow,
    // new_owner=lender — neither is the borrower, but raw_json records who
    // the borrower was). Without these branches, a defaulted borrower's
    // holder page would show the loan-originated event but go silent on
    // the eventual default. The `NOT IN` guards keep us from double-counting
    // events where the user is BOTH on a primary side AND mentioned in
    // raw_json (e.g. borrower=user is also old_owner=user on origination).
    //
    // Excludes 'listed': listings are off-chain notification triggers, not
    // on-chain history.
    getEventsByAddress: db.prepare(`
      SELECT * FROM (
        SELECT * FROM events WHERE new_owner = @owner AND event_type != 'listed'
        UNION ALL
        SELECT * FROM events WHERE old_owner = @owner AND event_type != 'listed'
          AND old_owner != COALESCE(new_owner, '')
        UNION ALL
        SELECT * FROM events
          WHERE event_type IN ('loan-originated','loan-defaulted','loan-repaid','loan-unlocked')
            AND json_extract(raw_json, '$.borrower_addr') = @owner
            AND COALESCE(new_owner, '') != @owner
            AND COALESCE(old_owner, '') != @owner
        UNION ALL
        SELECT * FROM events
          WHERE event_type IN ('loan-originated','loan-defaulted','loan-repaid','loan-unlocked')
            AND json_extract(raw_json, '$.lender_addr') = @owner
            AND COALESCE(new_owner, '') != @owner
            AND COALESCE(old_owner, '') != @owner
            AND COALESCE(json_extract(raw_json, '$.borrower_addr'), '') != @owner
      )
      ORDER BY block_timestamp DESC, id DESC
      LIMIT @limit
    `),

    // Keyset-paginated variant of getEventsByAddress. Used by /api/holder/.../events
    // for "load more" — same per-wallet shape, but only events strictly older
    // than the cursor (block_timestamp, id). Fan-out across linked wallets +
    // dedup happens in the API route.
    getEventsByAddressBefore: db.prepare(`
      SELECT * FROM (
        SELECT * FROM events WHERE new_owner = @owner AND event_type != 'listed'
        UNION ALL
        SELECT * FROM events WHERE old_owner = @owner AND event_type != 'listed'
          AND old_owner != COALESCE(new_owner, '')
        UNION ALL
        SELECT * FROM events
          WHERE event_type IN ('loan-originated','loan-defaulted','loan-repaid','loan-unlocked')
            AND json_extract(raw_json, '$.borrower_addr') = @owner
            AND COALESCE(new_owner, '') != @owner
            AND COALESCE(old_owner, '') != @owner
        UNION ALL
        SELECT * FROM events
          WHERE event_type IN ('loan-originated','loan-defaulted','loan-repaid','loan-unlocked')
            AND json_extract(raw_json, '$.lender_addr') = @owner
            AND COALESCE(new_owner, '') != @owner
            AND COALESCE(old_owner, '') != @owner
            AND COALESCE(json_extract(raw_json, '$.borrower_addr'), '') != @owner
      )
      WHERE block_timestamp < @cursor_ts
         OR (block_timestamp = @cursor_ts AND id < @cursor_id)
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
        + (SELECT COUNT(*) FROM events
            WHERE event_type IN ('loan-originated','loan-defaulted','loan-repaid','loan-unlocked')
              AND json_extract(raw_json, '$.borrower_addr') = @owner
              AND COALESCE(new_owner, '') != @owner
              AND COALESCE(old_owner, '') != @owner)
        + (SELECT COUNT(*) FROM events
            WHERE event_type IN ('loan-originated','loan-defaulted','loan-repaid','loan-unlocked')
              AND json_extract(raw_json, '$.lender_addr') = @owner
              AND COALESCE(new_owner, '') != @owner
              AND COALESCE(old_owner, '') != @owner
              AND COALESCE(json_extract(raw_json, '$.borrower_addr'), '') != @owner)
        AS n
    `),

    // The `current_owner NOT IN (...)` clause filters out inscriptions
    // currently parked in special wallets we surface separately (see
    // `walletLabels.ts`). Top Holders deliberately keeps them — that's the
    // intended exception so users can still find the treasury.
    topByTransfers: db.prepare(`
      SELECT * FROM inscriptions
      WHERE (transfer_count + sale_count) > 0
        AND collection_slug = @collection
        AND (@color IS NULL OR color = @color)
        AND (current_owner IS NULL OR current_owner NOT IN (${SQL_EXCLUDED_OWNERS_LIST}))
      ORDER BY (transfer_count + sale_count) DESC, last_movement_at DESC
      LIMIT @limit
    `),

    topByLongestUnmoved: db.prepare(`
      SELECT * FROM inscriptions
      WHERE last_movement_at IS NOT NULL
        AND collection_slug = @collection
        AND (@color IS NULL OR color = @color)
        AND (current_owner IS NULL OR current_owner NOT IN (${SQL_EXCLUDED_OWNERS_LIST}))
      ORDER BY last_movement_at ASC
      LIMIT @limit
    `),

    topByVolume: db.prepare(`
      SELECT * FROM inscriptions
      WHERE total_volume_sats > 0
        AND collection_slug = @collection
        AND (@color IS NULL OR color = @color)
        AND (current_owner IS NULL OR current_owner NOT IN (${SQL_EXCLUDED_OWNERS_LIST}))
      ORDER BY total_volume_sats DESC
      LIMIT @limit
    `),

    topByHighestSale: db.prepare(`
      SELECT * FROM inscriptions
      WHERE highest_sale_sats > 0
        AND collection_slug = @collection
        AND (@color IS NULL OR color = @color)
        AND (current_owner IS NULL OR current_owner NOT IN (${SQL_EXCLUDED_OWNERS_LIST}))
      ORDER BY highest_sale_sats DESC
      LIMIT @limit
    `),

    // Most-borrowed-against: inscriptions used as collateral most often. Uses
    // the denormalized loan_count column (incremented per loan-originated
    // event by the loan detector). Ties broken by last_event_at DESC so the
    // more recently-active piece wins.
    topByLoans: db.prepare(`
      SELECT * FROM inscriptions
      WHERE loan_count > 0
        AND collection_slug = @collection
        AND (@color IS NULL OR color = @color)
      ORDER BY loan_count DESC, last_event_at DESC
      LIMIT @limit
    `),

    // Currently-loaned: open loan cycles as tracked by tagged
    // loan-originated events minus observed loan resolutions. This is an
    // event-lifecycle leaderboard, not an escrow-address proof table. Surfaces
    // the active loan's origination timestamp so the UI can render "loaned 3d
    // ago" instead of a count — active_loan_count is effectively 0/1 per
    // inscription since escrowed pieces can't be re-loaned until released.
    topByActiveLoans: db.prepare(`
      SELECT i.*,
             (SELECT MAX(block_timestamp) FROM events e
                WHERE e.inscription_number = i.inscription_number
                  AND e.event_type = 'loan-originated') AS active_loan_started_at,
             (SELECT json_extract(raw_json,'$.lender_addr') FROM events e
                WHERE e.inscription_number = i.inscription_number
                  AND e.event_type = 'loan-originated'
                ORDER BY e.id DESC LIMIT 1) AS active_loan_lender_vault
        FROM inscriptions i
       WHERE i.active_loan_count > 0
         AND i.collection_slug = @collection
         AND (@color IS NULL OR i.color = @color)
       ORDER BY active_loan_started_at DESC, i.inscription_number ASC
       LIMIT @limit
    `),

    // Paged variants for /explorer/[type] infinite scroll. Ordering uses
    // inscription_number as a unique secondary sort so keyset pagination is
    // deterministic — without it, ties on the primary metric can cause rows
    // to repeat or get skipped across page boundaries. Cursor pair is
    // (primary metric, inscription_number); when @cursor_primary IS NULL the
    // statement returns the first page.
    topByTransfersPaged: db.prepare(`
      SELECT * FROM inscriptions
      WHERE (transfer_count + sale_count) > 0
        AND collection_slug = @collection
        AND (@color IS NULL OR color = @color)
        AND (current_owner IS NULL OR current_owner NOT IN (${SQL_EXCLUDED_OWNERS_LIST}))
        AND (
          @cursor_primary IS NULL
          OR (transfer_count + sale_count) < @cursor_primary
          OR ((transfer_count + sale_count) = @cursor_primary AND inscription_number > @cursor_secondary)
        )
      ORDER BY (transfer_count + sale_count) DESC, inscription_number ASC
      LIMIT @limit
    `),

    topByLongestUnmovedPaged: db.prepare(`
      SELECT * FROM inscriptions
      WHERE last_movement_at IS NOT NULL
        AND collection_slug = @collection
        AND (@color IS NULL OR color = @color)
        AND (current_owner IS NULL OR current_owner NOT IN (${SQL_EXCLUDED_OWNERS_LIST}))
        AND (
          @cursor_primary IS NULL
          OR last_movement_at > @cursor_primary
          OR (last_movement_at = @cursor_primary AND inscription_number > @cursor_secondary)
        )
      ORDER BY last_movement_at ASC, inscription_number ASC
      LIMIT @limit
    `),

    topByVolumePaged: db.prepare(`
      SELECT * FROM inscriptions
      WHERE total_volume_sats > 0
        AND collection_slug = @collection
        AND (@color IS NULL OR color = @color)
        AND (current_owner IS NULL OR current_owner NOT IN (${SQL_EXCLUDED_OWNERS_LIST}))
        AND (
          @cursor_primary IS NULL
          OR total_volume_sats < @cursor_primary
          OR (total_volume_sats = @cursor_primary AND inscription_number > @cursor_secondary)
        )
      ORDER BY total_volume_sats DESC, inscription_number ASC
      LIMIT @limit
    `),

    topByHighestSalePaged: db.prepare(`
      SELECT * FROM inscriptions
      WHERE highest_sale_sats > 0
        AND collection_slug = @collection
        AND (@color IS NULL OR color = @color)
        AND (current_owner IS NULL OR current_owner NOT IN (${SQL_EXCLUDED_OWNERS_LIST}))
        AND (
          @cursor_primary IS NULL
          OR highest_sale_sats < @cursor_primary
          OR (highest_sale_sats = @cursor_primary AND inscription_number > @cursor_secondary)
        )
      ORDER BY highest_sale_sats DESC, inscription_number ASC
      LIMIT @limit
    `),

    topByLoansPaged: db.prepare(`
      SELECT * FROM inscriptions
      WHERE loan_count > 0
        AND collection_slug = @collection
        AND (@color IS NULL OR color = @color)
        AND (
          @cursor_primary IS NULL
          OR loan_count < @cursor_primary
          OR (loan_count = @cursor_primary AND inscription_number > @cursor_secondary)
        )
      ORDER BY loan_count DESC, inscription_number ASC
      LIMIT @limit
    `),

    // Cursor on (active_loan_started_at DESC, inscription_number ASC) so the
    // most-recently-loaned-out pieces lead and ties break deterministically.
    topByActiveLoansPaged: db.prepare(`
      SELECT * FROM (
        SELECT i.*,
               (SELECT MAX(block_timestamp) FROM events e
                  WHERE e.inscription_number = i.inscription_number
                    AND e.event_type = 'loan-originated') AS active_loan_started_at,
               (SELECT json_extract(raw_json,'$.lender_addr') FROM events e
                  WHERE e.inscription_number = i.inscription_number
                    AND e.event_type = 'loan-originated'
                  ORDER BY e.id DESC LIMIT 1) AS active_loan_lender_vault
          FROM inscriptions i
         WHERE i.active_loan_count > 0
           AND i.collection_slug = @collection
           AND (@color IS NULL OR i.color = @color)
      )
      WHERE (
        @cursor_primary IS NULL
        OR active_loan_started_at < @cursor_primary
        OR (active_loan_started_at = @cursor_primary AND inscription_number > @cursor_secondary)
      )
      ORDER BY active_loan_started_at DESC, inscription_number ASC
      LIMIT @limit
    `),

    topHolders: db.prepare(`
      SELECT effective_owner AS wallet_addr,
             COUNT(*)        AS inscription_count,
             unixepoch()     AS updated_at
      FROM inscriptions
      WHERE effective_owner IS NOT NULL
        AND collection_slug = @collection
        AND (@color IS NULL OR color = @color)
      GROUP BY effective_owner
      ORDER BY inscription_count DESC, effective_owner ASC
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
    // Uses effective_owner so we don't waste probes on bc1p loan-escrow
    // addresses (which won't have Matrica profiles by construction).
    pickWalletsToProbe: db.prepare(`
      SELECT DISTINCT i.effective_owner AS wallet_addr
      FROM inscriptions i
      WHERE i.effective_owner IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM wallet_links wl
          WHERE wl.wallet_addr = i.effective_owner
            AND wl.checked_at > @stale_before
        )
      ORDER BY wallet_addr ASC
      LIMIT @limit
    `),

    // Upsert a link. matrica_user_id is NULL when Matrica returned 400
    // "Wallet not found" — we still write the row so we don't re-probe.
    // Strictly additive: once a wallet has a non-null matrica_user_id, the
    // poller never overwrites it — not on a NULL response (user unlinked from
    // their profile) and not on a different non-null user_id (Matrica returns
    // an auto-shell user when an unlinked wallet is queried, with username =
    // wallet_addr + suffix). Re-linking a wallet to a different real user
    // requires manual SQL intervention; see "manual unlink" note below.
    upsertWalletLink: db.prepare(`
      INSERT INTO wallet_links (wallet_addr, matrica_user_id, checked_at)
      VALUES (@wallet_addr, @matrica_user_id, @checked_at)
      ON CONFLICT(wallet_addr) DO UPDATE SET
        matrica_user_id = CASE
          WHEN wallet_links.matrica_user_id IS NULL THEN excluded.matrica_user_id
          ELSE wallet_links.matrica_user_id
        END,
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
    //
    // Strict variant: only direct wl.matrica_user_id matches. Used by the
    // notifications path where heuristic merges would risk misclassifying
    // an "internal transfer" — the strict guarantee is load-bearing for
    // delivery correctness, so it intentionally ignores cluster_anchors.
    getMatricaProfilesForAddrs: db.prepare(`
      SELECT wl.wallet_addr, wl.matrica_user_id AS user_id, mu.username, mu.avatar_url
      FROM wallet_links wl
      JOIN matrica_users mu ON mu.user_id = wl.matrica_user_id
      WHERE wl.wallet_addr IN (SELECT value FROM json_each(@addrs_json))
    `),

    // Permissive variant: also resolves via cluster_anchors so wallets that
    // are heuristically folded into a Matrica identity (≥99% confidence)
    // surface the right username. The `inferred` column distinguishes the
    // two so UI layers can mark it visually. Direct Matrica wins when both
    // exist, matching the leaderboard COALESCE chain.
    //
    // Used by /api/activity + /activity SSR — the high-visibility surface
    // where the cluster work pays off most. NOT used by notifications.
    getMatricaProfilesForAddrsWithInferred: db.prepare(`
      SELECT
        addr.value AS wallet_addr,
        COALESCE(wl.matrica_user_id, ca.matrica_user_id)        AS user_id,
        COALESCE(mu_d.username,      mu_c.username)             AS username,
        COALESCE(mu_d.avatar_url,    mu_c.avatar_url)           AS avatar_url,
        CASE WHEN wl.matrica_user_id IS NOT NULL THEN 0 ELSE 1 END AS inferred
      FROM json_each(@addrs_json) addr
      LEFT JOIN wallet_links     wl   ON wl.wallet_addr = addr.value
                                     AND wl.matrica_user_id IS NOT NULL
      LEFT JOIN matrica_users    mu_d ON mu_d.user_id   = wl.matrica_user_id
      LEFT JOIN cluster_anchors  ca   ON ca.wallet_addr = addr.value
                                     AND ca.matrica_user_id IS NOT NULL
      LEFT JOIN matrica_users    mu_c ON mu_c.user_id   = ca.matrica_user_id
      WHERE COALESCE(wl.matrica_user_id, ca.matrica_user_id) IS NOT NULL
    `),

    // Reader: top holders, collapsed by Matrica user when one is known,
    // then by cluster_anchors when on-chain inference at IDENTITY_FOLD
    // confidence (≥99%) merges unlinked wallets into a same-person group.
    // Wallets with neither a Matrica user nor a cluster row keep their
    // wallet address as the group key. GROUP_CONCAT gives the route layer
    // the full wallet set; the route splits for `wallets[]` and uses the
    // first entry for deep-linking.
    //
    // COALESCE order matters: wl.matrica_user_id beats ca.anchor_id so
    // an authoritatively-linked wallet is never re-keyed by a heuristic
    // merge — the recompute also skips clusters that span multiple
    // distinct Matrica users to keep this guarantee tight. Display joins
    // fall back to mu_anchor for cluster-anchored Matrica usernames so
    // a folded wallet shows the right avatar/handle.
    //
    // Keys on effective_owner (not current_owner) so loan-escrowed pieces
    // count for the borrower instead of surfacing the escrow taproot as a
    // 1-OMB "holder". Mirrors countHolders / topHolders / per-holder pages.
    topHoldersGrouped: db.prepare(`
      SELECT
        COALESCE(wl.matrica_user_id, ca.anchor_id, i.effective_owner)            AS group_key,
        CASE WHEN wl.matrica_user_id IS NOT NULL OR ca.matrica_user_id IS NOT NULL
             THEN 1 ELSE 0 END                                                   AS is_user,
        COALESCE(mu.username,   mu_a.username)                                   AS username,
        COALESCE(mu.avatar_url, mu_a.avatar_url)                                 AS avatar_url,
        GROUP_CONCAT(DISTINCT i.effective_owner)                                 AS wallets_csv,
        COUNT(*)                                                                 AS inscription_count,
        unixepoch()                                                              AS updated_at
      FROM inscriptions i
      LEFT JOIN wallet_links     wl   ON wl.wallet_addr   = i.effective_owner
      LEFT JOIN matrica_users    mu   ON mu.user_id       = wl.matrica_user_id
      LEFT JOIN cluster_anchors  ca   ON ca.wallet_addr   = i.effective_owner
      LEFT JOIN matrica_users    mu_a ON mu_a.user_id     = ca.matrica_user_id
      WHERE i.effective_owner IS NOT NULL
        AND i.collection_slug = @collection
        AND (@color IS NULL OR i.color = @color)
      GROUP BY group_key
      ORDER BY inscription_count DESC, group_key ASC
      LIMIT @limit
    `),

    // Paged variant for the /explorer/top-holders detail page. group_key is
    // unique (Matrica user_id, cluster anchor_id, or raw wallet address),
    // so the existing ORDER BY pair is a stable keyset; we just add the
    // cursor predicate. The HAVING clause is what filters here because
    // GROUP BY happens before WHERE-on-group can run — applying the
    // cursor as HAVING avoids a wrapping subquery.
    topHoldersGroupedPaged: db.prepare(`
      SELECT
        COALESCE(wl.matrica_user_id, ca.anchor_id, i.effective_owner)            AS group_key,
        CASE WHEN wl.matrica_user_id IS NOT NULL OR ca.matrica_user_id IS NOT NULL
             THEN 1 ELSE 0 END                                                   AS is_user,
        COALESCE(mu.username,   mu_a.username)                                   AS username,
        COALESCE(mu.avatar_url, mu_a.avatar_url)                                 AS avatar_url,
        GROUP_CONCAT(DISTINCT i.effective_owner)                                 AS wallets_csv,
        COUNT(*)                                                                 AS inscription_count,
        unixepoch()                                                              AS updated_at
      FROM inscriptions i
      LEFT JOIN wallet_links     wl   ON wl.wallet_addr   = i.effective_owner
      LEFT JOIN matrica_users    mu   ON mu.user_id       = wl.matrica_user_id
      LEFT JOIN cluster_anchors  ca   ON ca.wallet_addr   = i.effective_owner
      LEFT JOIN matrica_users    mu_a ON mu_a.user_id     = ca.matrica_user_id
      WHERE i.effective_owner IS NOT NULL
        AND i.collection_slug = @collection
        AND (@color IS NULL OR i.color = @color)
      GROUP BY group_key
      HAVING
        @cursor_primary IS NULL
        OR inscription_count < @cursor_primary
        OR (inscription_count = @cursor_primary AND group_key > @cursor_secondary)
      ORDER BY inscription_count DESC, group_key ASC
      LIMIT @limit
    `),

    // Count distinct identities (Matrica user, cluster anchor, or raw
    // wallet). Mirrors the topHoldersGrouped collapse so the explorer's
    // "N holders" stat squares with the leaderboard row count.
    countHolderIdentities: db.prepare(`
      SELECT COUNT(DISTINCT COALESCE(wl.matrica_user_id, ca.anchor_id, i.effective_owner)) AS n
      FROM inscriptions i
      LEFT JOIN wallet_links    wl ON wl.wallet_addr = i.effective_owner
      LEFT JOIN cluster_anchors ca ON ca.wallet_addr = i.effective_owner
      WHERE i.effective_owner IS NOT NULL
        AND i.collection_slug = @collection
        AND (@color IS NULL OR i.color = @color)
    `),

    // Charts: holder distribution histogram. Buckets identities (Matrica
    // user → cluster anchor → raw wallet) by how many inscriptions they
    // hold. The inner query mirrors topHoldersGrouped — same collapse
    // chain — so the bucket counts square with the top-holders leaderboard.
    //
    // Excludes special wallets (treasury) so the histogram reflects the
    // organic distribution rather than being skewed by a single mass holder.
    holderDistributionBuckets: db.prepare(`
      SELECT bucket, COUNT(*) AS wallet_count FROM (
        SELECT
          CASE
            WHEN cnt = 1 THEN '1'
            WHEN cnt = 2 THEN '2'
            WHEN cnt = 3 THEN '3'
            WHEN cnt = 4 THEN '4'
            WHEN cnt = 5 THEN '5'
            ELSE '6+'
          END AS bucket
        FROM (
          SELECT COUNT(*) AS cnt
          FROM inscriptions i
          LEFT JOIN wallet_links    wl ON wl.wallet_addr = i.effective_owner
          LEFT JOIN cluster_anchors ca ON ca.wallet_addr = i.effective_owner
          WHERE i.effective_owner IS NOT NULL
            AND i.collection_slug = @collection
            AND (@color IS NULL OR i.color = @color)
            AND i.effective_owner NOT IN (${SQL_EXCLUDED_OWNERS_LIST})
          GROUP BY COALESCE(wl.matrica_user_id, ca.anchor_id, i.effective_owner)
        )
      )
      GROUP BY bucket
    `),

    // Charts: holding-duration histogram. Bucket each inscription by how long
    // it has sat at its current address. Uses last_movement_at when present,
    // falling back to inscribe_at for never-moved OMBs ("held since mint").
    // Inscriptions with neither timestamp are excluded — those are pre-bootstrap
    // rows that the indexer hasn't filled yet.
    holdingDurationBuckets: db.prepare(`
      SELECT bucket, COUNT(*) AS count FROM (
        SELECT
          CASE
            WHEN (unixepoch() - ref_ts) < 30*86400  THEN '<1mo'
            WHEN (unixepoch() - ref_ts) < 180*86400 THEN '1-6mo'
            WHEN (unixepoch() - ref_ts) < 365*86400 THEN '6-12mo'
            WHEN (unixepoch() - ref_ts) < 730*86400 THEN '1-2y'
            ELSE '2y+'
          END AS bucket
        FROM (
          SELECT COALESCE(last_movement_at, inscribe_at) AS ref_ts
          FROM inscriptions
          WHERE collection_slug = @collection
            AND (@color IS NULL OR color = @color)
            AND COALESCE(last_movement_at, inscribe_at) IS NOT NULL
            AND (current_owner IS NULL OR current_owner NOT IN (${SQL_EXCLUDED_OWNERS_LIST}))
        )
      )
      GROUP BY bucket
    `),

    // Charts: per-day "inscription moved" count for the last @days days. The
    // index idx_events_type_ts_id covers the (event_type, block_timestamp)
    // probe; the inscription join scopes to a collection.
    //
    // Includes loan-originated, loan-defaulted, and loan-unlocked alongside
    // transferred + sold — they all represent on-chain movement of the
    // inscription. loan-repaid is excluded: it's a pure-BTC tx with no
    // inscription movement, so counting it would double-count days where
    // both repayment and unlock happen. 'listed' is also excluded (off-chain
    // notification, not a movement).
    transferActivityByDay: db.prepare(`
      SELECT date(e.block_timestamp, 'unixepoch') AS date,
             COUNT(*)                              AS count
      FROM events e
      JOIN inscriptions i ON i.inscription_number = e.inscription_number
      WHERE i.collection_slug = @collection
        AND (@color IS NULL OR i.color = @color)
        AND e.event_type IN ('transferred', 'sold', 'loan-originated', 'loan-defaulted', 'loan-unlocked')
        AND e.block_timestamp >= unixepoch() - (@days * 86400)
        AND (i.current_owner IS NULL OR i.current_owner NOT IN (${SQL_EXCLUDED_OWNERS_LIST}))
      GROUP BY date
      ORDER BY date ASC
    `),

    // Charts: bag-size-over-time deltas for one address. Each OMB event
    // involving this address contributes +1 (when address received) and/or
    // -1 (when it sent). For internal transfers (same address on both sides)
    // the +1/-1 cancel correctly on the chart side. Filtered to collection
    // 'omb' so the chart matches the OMB count shown elsewhere on the page;
    // bravocados movements would otherwise inflate the running total against
    // a denominator the chart never names. No cap — full history is small
    // and we want the chart to span first-event→now. `event_id` is exposed so
    // the chart can correlate highlight markers (see `holderColorHighlights`)
    // to the running-total at that exact event.
    //
    // Loan semantics: while a loan is open the OMB is collateralized but
    // still "belongs to" the borrower (effective_owner = borrower elsewhere),
    // so loan-originated/loan-repaid/loan-unlocked must NOT decrement-then-
    // increment the borrower's bag — they're filtered out of the chain-delta
    // arms. loan-defaulted is when the OMB actually leaves the borrower for
    // the lender; the lender naturally gets +1 from `new_owner = lender`,
    // and the borrower's -1 is reconstructed via the third arm by joining to
    // the matching origination event (escrow uniquely keys the pairing).
    // 'listed' is also excluded — listings are off-chain notification triggers.
    ownershipChangesByAddress: db.prepare(`
      SELECT e.id AS event_id, e.block_timestamp, +1 AS delta
      FROM events e
      JOIN inscriptions i ON i.inscription_number = e.inscription_number
      WHERE e.new_owner = @owner
        AND e.event_type IN ('transferred','sold','loan-defaulted')
        AND i.collection_slug = 'omb'
      UNION ALL
      SELECT e.id AS event_id, e.block_timestamp, -1 AS delta
      FROM events e
      JOIN inscriptions i ON i.inscription_number = e.inscription_number
      WHERE e.old_owner = @owner
        AND e.event_type IN ('transferred','sold')
        AND i.collection_slug = 'omb'
      UNION ALL
      SELECT d.id AS event_id, d.block_timestamp, -1 AS delta
      FROM events d
      JOIN events o
        ON o.event_type = 'loan-originated'
       AND o.inscription_number = d.inscription_number
       AND o.new_owner = d.old_owner
      JOIN inscriptions i ON i.inscription_number = d.inscription_number
      WHERE d.event_type = 'loan-defaulted'
        AND o.old_owner = @owner
        AND i.collection_slug = 'omb'
      ORDER BY block_timestamp ASC, event_id ASC
    `),

    // Charts: red/blue OMB ownership changes for one address. Powers the
    // colored markers on the bag-size-over-time chart. Each row pairs a
    // delta sign with the inscription # and color so the marker can render
    // in the right swatch and link back to the inscription page. Returns
    // both directions; the API/page caller groups across wallets by
    // event_id and drops internal transfers (sum == 0).
    holderColorHighlights: db.prepare(`
      SELECT e.id AS event_id, e.block_timestamp, e.inscription_number, i.color, +1 AS delta
      FROM events e
      JOIN inscriptions i ON i.inscription_number = e.inscription_number
      WHERE e.new_owner = @owner
        AND e.event_type IN ('transferred','sold','loan-defaulted')
        AND i.collection_slug = 'omb'
        AND i.color IN ('red', 'blue')
      UNION ALL
      SELECT e.id AS event_id, e.block_timestamp, e.inscription_number, i.color, -1 AS delta
      FROM events e
      JOIN inscriptions i ON i.inscription_number = e.inscription_number
      WHERE e.old_owner = @owner
        AND e.event_type IN ('transferred','sold')
        AND i.collection_slug = 'omb'
        AND i.color IN ('red', 'blue')
      UNION ALL
      SELECT d.id AS event_id, d.block_timestamp, d.inscription_number, i.color, -1 AS delta
      FROM events d
      JOIN events o
        ON o.event_type = 'loan-originated'
       AND o.inscription_number = d.inscription_number
       AND o.new_owner = d.old_owner
      JOIN inscriptions i ON i.inscription_number = d.inscription_number
      WHERE d.event_type = 'loan-defaulted'
        AND o.old_owner = @owner
        AND i.collection_slug = 'omb'
        AND i.color IN ('red', 'blue')
      ORDER BY block_timestamp ASC, event_id ASC
    `),

    // ---------------- global search ----------------
    // Search across collections; the route layer renders the collection_slug
    // so links can deep-link to /inscription/[number] (which is OMB-only) or
    // skip out for non-OMB hits in this UI release.
    searchInscriptionByNumber: db.prepare(`
      SELECT inscription_number, inscription_id, color, current_owner, collection_slug
      FROM inscriptions
      WHERE inscription_number = ?
    `),

    searchInscriptionById: db.prepare(`
      SELECT inscription_number, inscription_id, color, current_owner, collection_slug
      FROM inscriptions
      WHERE inscription_id = ?
    `),

    // Bare-txid input: find inscriptions whose inscription_id is `<txid>i<index>`.
    // Also matches the legitimate "user pasted the genesis txid" case.
    searchInscriptionsByIdPrefix: db.prepare(`
      SELECT inscription_number, inscription_id, color, current_owner, collection_slug
      FROM inscriptions
      WHERE inscription_id LIKE ? || 'i%'
      ORDER BY inscription_number ASC
      LIMIT 5
    `),

    // LEFT JOIN inscriptions so the route layer can branch event-row links by
    // collection — without it, a non-OMB txid hit would link to /inscription/N
    // which 404s (the route is OMB-only). LEFT (vs INNER) so an event for a
    // dropped/missing inscription_number still surfaces with a fallback link.
    searchEventsByTxid: db.prepare(`
      SELECT e.id, e.inscription_number, e.inscription_id, e.event_type,
             e.old_owner, e.new_owner, e.marketplace, e.sale_price_sats,
             e.block_height, e.block_timestamp, e.txid,
             i.collection_slug
      FROM events e
      LEFT JOIN inscriptions i ON i.inscription_number = e.inscription_number
      WHERE e.txid = ?
      ORDER BY e.id DESC
      LIMIT 25
    `),

    searchHolderByAddress: db.prepare(`
      SELECT current_owner AS address, COUNT(*) AS inscription_count
      FROM inscriptions
      WHERE current_owner = ?
      GROUP BY current_owner
    `),

    // Suffix-style match: "I remember it ended in xyz123". LIKE '%' || ? matches
    // any address ending with the given fragment. Order by holding count so the
    // big collectors surface first.
    searchHoldersBySuffix: db.prepare(`
      SELECT current_owner AS address, COUNT(*) AS inscription_count
      FROM inscriptions
      WHERE current_owner IS NOT NULL
        AND current_owner LIKE '%' || ?
      GROUP BY current_owner
      ORDER BY inscription_count DESC
      LIMIT 10
    `),

    // Matrica username search: prefix-priority, falls back to substring when
    // the query is ≥3 chars. Single named param bound multiple times.
    searchUsersByName: db.prepare(`
      SELECT mu.user_id, mu.username, mu.avatar_url,
             COUNT(wl.wallet_addr) AS wallet_count,
             (SELECT wallet_addr FROM wallet_links WHERE matrica_user_id = mu.user_id LIMIT 1) AS first_wallet
      FROM matrica_users mu
      LEFT JOIN wallet_links wl ON wl.matrica_user_id = mu.user_id
      WHERE mu.username IS NOT NULL
        AND (
          LOWER(mu.username) LIKE LOWER(@q) || '%'
          OR (LENGTH(@q) >= 3 AND LOWER(mu.username) LIKE '%' || LOWER(@q) || '%')
        )
      GROUP BY mu.user_id
      ORDER BY
        (LOWER(mu.username) = LOWER(@q)) DESC,
        (LOWER(mu.username) LIKE LOWER(@q) || '%') DESC,
        LENGTH(mu.username) ASC
      LIMIT 10
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

// ord stream state JSON-packed into poll_state.last_cursor for ('ord','omb').
// `last_cursor` was unused on the ord stream (ord is a stateless poll) until
// we needed to persist (a) the derived bitcoind tip per tick — for the height
// formula and the health surface — and (b) the heal-heights cursor.
// Stored as a JSON object so future fields can be added without a migration.
export type OrdPersistedState = {
  bitcoindTip: number | null;
  healCursor: number | null;
  healCompletedAt: number | null;
};

const ORD_STATE_DEFAULT: OrdPersistedState = {
  bitcoindTip: null,
  healCursor: null,
  healCompletedAt: null,
};

export function getOrdState(): OrdPersistedState {
  const db = getDb();
  const row = db
    .prepare(`SELECT last_cursor FROM poll_state WHERE stream='ord' AND collection_slug='omb'`)
    .get() as { last_cursor: string | null } | undefined;
  if (!row || !row.last_cursor) return { ...ORD_STATE_DEFAULT };
  try {
    const parsed = JSON.parse(row.last_cursor) as Partial<OrdPersistedState>;
    if (typeof parsed !== 'object' || parsed == null) return { ...ORD_STATE_DEFAULT };
    return {
      bitcoindTip: typeof parsed.bitcoindTip === 'number' ? parsed.bitcoindTip : null,
      healCursor: typeof parsed.healCursor === 'number' ? parsed.healCursor : null,
      healCompletedAt: typeof parsed.healCompletedAt === 'number' ? parsed.healCompletedAt : null,
    };
  } catch {
    // Pre-JSON value from before this migration (or corruption) — treat as empty.
    return { ...ORD_STATE_DEFAULT };
  }
}

export function setOrdState(partial: Partial<OrdPersistedState>): void {
  const db = getDb();
  const merged: OrdPersistedState = { ...getOrdState(), ...partial };
  db.prepare(
    `UPDATE poll_state SET last_cursor=? WHERE stream='ord' AND collection_slug='omb'`
  ).run(JSON.stringify(merged));
}

export type EventRow = {
  id: number;
  inscription_id: string;
  inscription_number: number;
  event_type:
    | 'inscribed'
    | 'transferred'
    | 'sold'
    | 'mint'
    | 'loan-originated'
    | 'loan-defaulted'
    | 'loan-repaid'
    | 'loan-unlocked';
  block_height: number | null;
  block_timestamp: number;
  new_satpoint: string | null;
  old_owner: string | null;
  new_owner: string | null;
  marketplace: string | null;
  sale_price_sats: number | null;
  txid: string;
  raw_json: string | null;
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
  loan_count: number;
  active_loan_count: number;
  effective_owner: string | null;
  /** Only populated by topByActiveLoans / topByActiveLoansPaged — block
   * timestamp of the most recent loan-originated event for the inscription.
   * Drives the currently-loaned leaderboard "loaned 3d ago" UI. */
  active_loan_started_at?: number | null;
  /** Only populated by topByActiveLoans / topByActiveLoansPaged — the
   * `lender_addr` from the most recent loan-originated event's raw_json.
   * Drives per-vault expiration estimation (see lib/loanExpiration.ts). */
  active_loan_lender_vault?: string | null;
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
  stream: 'ord' | 'satflow' | 'satflow_listings' | 'matrica' | 'notify' | 'loans';
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

export type HolderDistributionBucketRow = {
  bucket: '1' | '2' | '3' | '4' | '5' | '6+';
  wallet_count: number;
};

export type HoldingDurationBucketRow = {
  bucket: '<1mo' | '1-6mo' | '6-12mo' | '1-2y' | '2y+';
  count: number;
};

export type TransferActivityDayRow = {
  /** ISO date string yyyy-mm-dd from SQLite's date(..., 'unixepoch'). */
  date: string;
  count: number;
};

export type OwnershipDeltaRow = {
  event_id: number;
  block_timestamp: number;
  delta: 1 | -1;
};

export type HolderColorHighlightRow = {
  event_id: number;
  block_timestamp: number;
  inscription_number: number;
  color: 'red' | 'blue';
  delta: 1 | -1;
};
