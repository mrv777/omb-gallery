#!/usr/bin/env node
/* eslint-disable */
// One-shot historical-sales backfill from ord.net.
//
// Why this exists: Satflow's /v1/activity/sales API only contains
// Satflow-marketplace fills (~276 rows for OMB), but their UI surfaces older
// multi-marketplace sales (Magic Eden / OKX / Magisat era). ord.net republishes
// those older sales via its SvelteKit page data. We walk the cursor-paginated
// /collection/<slug>/sales/__data.json feed top-to-bottom and upgrade matching
// 'transferred' rows to 'sold' (or insert standalone 'sold' rows when no
// transfer was previously recorded). Mirrors the satflow incremental UPSERT
// path in src/app/api/internal/poll/route.ts so re-runs are idempotent.
//
// Required env: none. Default DB path is dev-friendly; override for prod.
// Optional env:
//   OMB_DB_PATH               default ./tmp/dev.db
//   ORDNET_BASE_URL           default https://ord.net
//   ORDNET_COLLECTION_SLUG    default omb
//
// CLI flags:
//   --dry-run                 Don't write to the DB. Reports what would change.
//   --max-pages=N             Stop after N pages (default: walk to end).
//   --from-height=H           Forge a starting cursor at block height H.
//   --rps=R                   Requests per second cap (default 2 = one per 500ms).
//                             ord.net's dev confirmed this is fine — pages are
//                             cached at the edge so we're not hammering origin.
//   --early-exit-streak=N     Stop after N consecutive pages with zero new
//                             writes. Default 3. Lets re-runs finish quickly
//                             once we've reached the satflow-API era we
//                             already have.
//
// Run from anywhere with OMB_DB_PATH pointing at the live DB.

const path = require('node:path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.OMB_DB_PATH ?? path.resolve(__dirname, '..', 'tmp', 'dev.db');
const ORDNET_BASE = (process.env.ORDNET_BASE_URL ?? 'https://ord.net').replace(/\/+$/, '');
const COLLECTION_SLUG = process.env.ORDNET_COLLECTION_SLUG ?? 'omb';
const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT = 'omb-gallery-backfill/1.0 (https://ordinalmaxibiz.wiki)';

const ARGS = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = {
    dryRun: false,
    maxPages: null,
    fromHeight: null,
    rps: 2,
    earlyExitStreak: 3,
  };
  for (const a of argv) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--max-pages=')) out.maxPages = parseInt(a.slice(12), 10);
    else if (a.startsWith('--from-height=')) out.fromHeight = parseInt(a.slice(14), 10);
    else if (a.startsWith('--rps=')) out.rps = parseFloat(a.slice(6));
    else if (a.startsWith('--early-exit-streak=')) out.earlyExitStreak = parseInt(a.slice(20), 10);
    else {
      console.error(`[ord-net-backfill] unknown arg: ${a}`);
      process.exit(1);
    }
  }
  if (!Number.isFinite(out.rps) || out.rps <= 0) {
    console.error('[ord-net-backfill] --rps must be positive');
    process.exit(1);
  }
  return out;
}

// ---------------- HTTP + rate limit ----------------

const MIN_INTERVAL_MS = 1000 / ARGS.rps;
let nextSlotAt = 0;
async function waitForSlot() {
  const now = Date.now();
  const slot = Math.max(now, nextSlotAt);
  nextSlotAt = slot + MIN_INTERVAL_MS;
  const wait = slot - now;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
}

async function fetchJson(url, attempt = 0) {
  await waitForSlot();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: ctl.signal,
    });
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 3) throw new Error(`HTTP ${res.status} after ${attempt + 1} attempts`);
      const backoff = Math.min(60_000, 1000 * 2 ** attempt + Math.random() * 500);
      console.warn(`[ord-net-backfill] HTTP ${res.status}; backing off ${Math.round(backoff)}ms`);
      await new Promise(r => setTimeout(r, backoff));
      return fetchJson(url, attempt + 1);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// ---------------- SvelteKit devalue decoder ----------------
//
// Response is one or more JSON objects concatenated (NDJSON-ish). We need the
// {type:"chunk", id:1, data:[<pool>]} object. The pool is a deduped value
// table where dicts/lists carry integer refs into the pool. Each sale row is
// a dict with type/txid/inscriptionId/inscriptionNumber/item/price/from/to/
// time/priceUsd keys; we feature-detect rather than relying on the schema-id
// numeric (which can vary across pages).

function parseNdjson(raw) {
  const out = [];
  let i = 0;
  const dec = JSON;
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  // Streaming bracket balance to slice out top-level objects.
  for (let p = 0; p < raw.length; p++) {
    const c = raw[p];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '{' || c === '[') {
      if (depth === 0) start = p;
      depth++;
    } else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0 && start !== -1) {
        out.push(dec.parse(raw.slice(start, p + 1)));
        start = -1;
      }
    }
  }
  return out;
}

const SALE_KEYS = [
  'type',
  'txid',
  'inscriptionId',
  'inscriptionNumber',
  'price',
  'from',
  'to',
  'time',
];

function isSaleShape(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  for (const k of SALE_KEYS) if (!(k in obj)) return false;
  return true;
}

function deref(pool, v, seen = new Set()) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v >= pool.length) return v;
  if (seen.has(v)) return null;
  const next = pool[v];
  // If the pool entry is itself an int ref, follow once. (Devalue rarely double-
  // hops, but it's cheap insurance.)
  if (typeof next === 'number' && Number.isInteger(next) && next !== v) {
    return deref(pool, next, new Set([...seen, v]));
  }
  return next;
}

function extractSales(rawText) {
  const objs = parseNdjson(rawText);
  let pool = null;
  for (const o of objs) {
    if (o && o.type === 'chunk' && Array.isArray(o.data)) {
      pool = o.data;
      break;
    }
  }
  if (!pool) return { sales: [], nextCursor: null };

  const sales = [];
  for (const entry of pool) {
    if (!isSaleShape(entry)) continue;
    const txid = deref(pool, entry.txid);
    const inscriptionId = deref(pool, entry.inscriptionId);
    const inscriptionNumberStr = deref(pool, entry.inscriptionNumber);
    const priceBtc = deref(pool, entry.price);
    const from = deref(pool, entry.from);
    const to = deref(pool, entry.to);
    const timeMs = deref(pool, entry.time);
    if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/i.test(txid)) continue;
    if (typeof inscriptionId !== 'string' || !/^[0-9a-f]{64}i\d+$/.test(inscriptionId)) continue;
    if (typeof priceBtc !== 'number' || !Number.isFinite(priceBtc) || priceBtc <= 0) continue;
    if (typeof timeMs !== 'number' || !Number.isFinite(timeMs) || timeMs <= 0) continue;
    const inscriptionNumber =
      typeof inscriptionNumberStr === 'string'
        ? parseInt(inscriptionNumberStr, 10)
        : typeof inscriptionNumberStr === 'number'
          ? inscriptionNumberStr
          : null;
    sales.push({
      txid: txid.toLowerCase(),
      inscription_id: inscriptionId,
      inscription_number: Number.isFinite(inscriptionNumber) ? inscriptionNumber : null,
      sale_price_sats: btcFloatToSats(priceBtc),
      block_timestamp: Math.floor(timeMs / 1000),
      seller: typeof from === 'string' ? from : null,
      buyer: typeof to === 'string' ? to : null,
      raw_json: JSON.stringify({
        source: 'ord-net-history-backfill',
        txid: txid.toLowerCase(),
        inscriptionId,
        priceBtc,
        from: typeof from === 'string' ? from : null,
        to: typeof to === 'string' ? to : null,
        timeMs,
      }),
    });
  }

  // The next cursor is the last base64-encoded {"h":"...","s":"...","e":"..."}
  // string in the response. ord.net's pageData pool ends with that token.
  const cursorMatch = rawText.match(/"(eyJ[A-Za-z0-9+/=]+)"/g);
  let nextCursor = null;
  if (cursorMatch && cursorMatch.length > 0) {
    const last = cursorMatch[cursorMatch.length - 1].slice(1, -1);
    try {
      const decoded = JSON.parse(Buffer.from(last, 'base64').toString('utf8'));
      if (decoded && typeof decoded.h === 'string') nextCursor = { token: last, decoded };
    } catch {
      // not a valid cursor — leave null
    }
  }
  return { sales, nextCursor };
}

function btcFloatToSats(v) {
  // Input is a JS number (e.g. 0.328635). Convert by string round-trip to
  // avoid float drift on values like 0.1 (0.1 * 1e8 = 9999999.999...).
  // The ord.net pool serializes prices with up to 8 decimal places.
  const s = v.toFixed(8);
  const [whole, frac = ''] = s.split('.');
  const padded = (frac + '00000000').slice(0, 8);
  // BigInt math to avoid 2^53 overflow on huge sale values.
  const sats = BigInt(whole) * 100_000_000n + BigInt(padded);
  if (sats > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`sale price ${v} BTC exceeds safe integer range`);
  }
  return Number(sats);
}

// ---------------- main ----------------

async function main() {
  const db = new Database(DB_PATH, { readonly: ARGS.dryRun });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  // Mirror src/lib/db.ts prepared-statement shapes (the satflow incremental
  // path). Backfill never enqueues into notify_pending.
  const findEvent = db.prepare(`
    SELECT id, event_type
      FROM events
     WHERE inscription_id = @inscription_id AND txid = @txid
  `);
  const upgradeToSold = db.prepare(`
    UPDATE events
       SET event_type      = 'sold',
           marketplace     = NULL,
           sale_price_sats = @sale_price_sats,
           old_owner       = COALESCE(@old_owner, old_owner),
           new_owner       = COALESCE(@new_owner, new_owner),
           block_timestamp = COALESCE(block_timestamp, @block_timestamp),
           raw_json        = @raw_json
     WHERE inscription_id = @inscription_id
       AND txid           = @txid
       AND event_type     = 'transferred'
  `);
  const insertEvent = db.prepare(`
    INSERT INTO events (
      inscription_id, inscription_number, event_type, block_height, block_timestamp,
      new_satpoint, old_owner, new_owner, marketplace, sale_price_sats, txid, raw_json
    ) VALUES (
      @inscription_id, @inscription_number, 'sold', NULL, @block_timestamp,
      NULL, @old_owner, @new_owner, NULL, @sale_price_sats, @txid, @raw_json
    )
  `);
  const upsertInscriptionFromEvent = db.prepare(`
    INSERT INTO inscriptions (inscription_number, inscription_id, inscribe_at, first_event_at, last_event_at)
    VALUES (@inscription_number, @inscription_id, NULL, @block_timestamp, @block_timestamp)
    ON CONFLICT(inscription_number) DO UPDATE SET
      inscription_id = COALESCE(inscriptions.inscription_id, excluded.inscription_id),
      first_event_at = MIN(COALESCE(inscriptions.first_event_at, excluded.first_event_at), excluded.first_event_at),
      last_event_at  = MAX(COALESCE(inscriptions.last_event_at, 0), excluded.last_event_at)
  `);
  const setOwnerIfNewer = db.prepare(`
    UPDATE inscriptions
       SET current_owner = @new_owner
     WHERE inscription_number = @inscription_number
       AND @new_owner IS NOT NULL
       AND (last_movement_at IS NULL OR @block_timestamp >= last_movement_at)
  `);
  const bumpAggregatesSold = db.prepare(`
    UPDATE inscriptions SET
      sale_count        = sale_count + 1,
      total_volume_sats = total_volume_sats + COALESCE(@sale_price_sats, 0),
      highest_sale_sats = MAX(highest_sale_sats, COALESCE(@sale_price_sats, 0)),
      last_movement_at  = MAX(COALESCE(last_movement_at, 0), @block_timestamp)
    WHERE inscription_number = @inscription_number
  `);
  const unbumpTransferOnUpgrade = db.prepare(`
    UPDATE inscriptions SET
      transfer_count    = MAX(transfer_count - 1, 0),
      sale_count        = sale_count + 1,
      total_volume_sats = total_volume_sats + COALESCE(@sale_price_sats, 0),
      highest_sale_sats = MAX(highest_sale_sats, COALESCE(@sale_price_sats, 0))
    WHERE inscription_number = @inscription_number
  `);
  const lookupInscriptionNumber = db.prepare(`
    SELECT inscription_number FROM inscriptions WHERE inscription_id = @inscription_id
  `);

  const flushBatch = db.transaction(rows => {
    let upgraded = 0;
    let inserted = 0;
    let skippedSold = 0;
    let skippedUnknown = 0;
    for (const r of rows) {
      // We need an inscription_number for the events FK. ord.net ships one in
      // the row, but defensively fall back to looking it up by inscription_id
      // (the inscriptions table is seeded from images.json on first boot, so
      // every OMB inscription_id is known once the satflow seed runs).
      let inscriptionNumber = r.inscription_number;
      if (inscriptionNumber == null) {
        const row = lookupInscriptionNumber.get({ inscription_id: r.inscription_id });
        if (row) inscriptionNumber = row.inscription_number;
      }
      if (inscriptionNumber == null) {
        skippedUnknown++;
        continue;
      }

      const existing = findEvent.get({ inscription_id: r.inscription_id, txid: r.txid });
      if (existing) {
        if (existing.event_type === 'sold') {
          skippedSold++;
          continue;
        }
        // Upgrade transferred → sold
        const u = upgradeToSold.run({
          inscription_id: r.inscription_id,
          txid: r.txid,
          sale_price_sats: r.sale_price_sats,
          old_owner: r.seller,
          new_owner: r.buyer,
          block_timestamp: r.block_timestamp,
          raw_json: r.raw_json,
        });
        if (u.changes > 0) {
          upgraded++;
          unbumpTransferOnUpgrade.run({
            inscription_number: inscriptionNumber,
            sale_price_sats: r.sale_price_sats,
          });
        }
        continue;
      }

      // Standalone insert
      upsertInscriptionFromEvent.run({
        inscription_number: inscriptionNumber,
        inscription_id: r.inscription_id,
        block_timestamp: r.block_timestamp,
      });
      setOwnerIfNewer.run({
        inscription_number: inscriptionNumber,
        new_owner: r.buyer,
        block_timestamp: r.block_timestamp,
      });
      const ins = insertEvent.run({
        inscription_id: r.inscription_id,
        inscription_number: inscriptionNumber,
        block_timestamp: r.block_timestamp,
        old_owner: r.seller,
        new_owner: r.buyer,
        sale_price_sats: r.sale_price_sats,
        txid: r.txid,
        raw_json: r.raw_json,
      });
      if (ins.changes > 0) {
        inserted++;
        bumpAggregatesSold.run({
          inscription_number: inscriptionNumber,
          sale_price_sats: r.sale_price_sats,
          block_timestamp: r.block_timestamp,
        });
      }
    }
    return { upgraded, inserted, skippedSold, skippedUnknown };
  });

  // Build the starting cursor.
  let cursorParam = '';
  if (ARGS.fromHeight != null) {
    const tok = Buffer.from(JSON.stringify({ h: String(ARGS.fromHeight), s: '0', e: '0' }), 'utf8')
      .toString('base64')
      .replace(/=+$/, '');
    cursorParam = `?cursor=${tok}`;
    console.log(`[ord-net-backfill] starting at forged cursor h=${ARGS.fromHeight}`);
  } else {
    console.log('[ord-net-backfill] starting at newest page (no cursor)');
  }

  const baseUrl = `${ORDNET_BASE}/collection/${COLLECTION_SLUG}/sales/__data.json`;
  const startedAt = Date.now();
  let pageNum = 0;
  let prevToken = null;
  let zeroWriteStreak = 0;
  let stallRecoveries = 0;
  const MAX_STALL_RECOVERIES = 50;
  let totalSales = 0;
  let totalUpgraded = 0;
  let totalInserted = 0;
  let totalSkippedSold = 0;
  let totalSkippedUnknown = 0;

  console.log(
    `[ord-net-backfill] db=${DB_PATH} dryRun=${ARGS.dryRun} rps=${ARGS.rps} earlyExitStreak=${ARGS.earlyExitStreak}`
  );

  while (true) {
    pageNum++;
    if (ARGS.maxPages != null && pageNum > ARGS.maxPages) {
      console.log(`[ord-net-backfill] hit --max-pages=${ARGS.maxPages}`);
      break;
    }
    const url = `${baseUrl}${cursorParam}`;
    let raw;
    try {
      raw = await fetchJson(url);
    } catch (e) {
      console.error(`[ord-net-backfill] page ${pageNum} fetch failed:`, e.message);
      break;
    }
    const { sales, nextCursor } = extractSales(raw);
    totalSales += sales.length;

    let pageUpgraded = 0;
    let pageInserted = 0;
    let pageSkippedSold = 0;
    let pageSkippedUnknown = 0;
    if (sales.length > 0) {
      if (ARGS.dryRun) {
        // Dry run: count what WOULD happen against the read-only DB.
        for (const r of sales) {
          let inscriptionNumber = r.inscription_number;
          if (inscriptionNumber == null) {
            const row = lookupInscriptionNumber.get({ inscription_id: r.inscription_id });
            if (row) inscriptionNumber = row.inscription_number;
          }
          if (inscriptionNumber == null) {
            pageSkippedUnknown++;
            continue;
          }
          const existing = findEvent.get({ inscription_id: r.inscription_id, txid: r.txid });
          if (existing) {
            if (existing.event_type === 'sold') pageSkippedSold++;
            else pageUpgraded++;
          } else {
            pageInserted++;
          }
        }
      } else {
        const r = flushBatch.immediate(sales);
        pageUpgraded = r.upgraded;
        pageInserted = r.inserted;
        pageSkippedSold = r.skippedSold;
        pageSkippedUnknown = r.skippedUnknown;
      }
    }

    totalUpgraded += pageUpgraded;
    totalInserted += pageInserted;
    totalSkippedSold += pageSkippedSold;
    totalSkippedUnknown += pageSkippedUnknown;

    const writes = pageUpgraded + pageInserted;
    if (writes === 0) zeroWriteStreak++;
    else zeroWriteStreak = 0;

    const nextHeight = nextCursor ? parseInt(nextCursor.decoded.h, 10) : null;
    console.log(
      `[ord-net-backfill] page ${pageNum} sales=${sales.length} ` +
        `upgraded=${pageUpgraded} inserted=${pageInserted} ` +
        `skippedSold=${pageSkippedSold} skippedUnknown=${pageSkippedUnknown} ` +
        `nextH=${nextHeight ?? '<none>'} streak=${zeroWriteStreak}`
    );

    // Termination
    if (sales.length === 0) {
      console.log('[ord-net-backfill] page yielded zero sales — done');
      break;
    }
    if (!nextCursor) {
      console.log('[ord-net-backfill] no next cursor — done');
      break;
    }
    // ord.net's cursor occasionally stalls (returns the same token it just
    // accepted) even though more data exists below. When that happens, forge
    // a cursor at h-1 to step past the stall point. Cap recoveries so a
    // pathological feed can't loop forever.
    if (nextCursor.token === prevToken) {
      if (stallRecoveries >= MAX_STALL_RECOVERIES) {
        console.log(
          `[ord-net-backfill] cursor stalled at h=${nextHeight} after ${stallRecoveries} recoveries — done`
        );
        break;
      }
      stallRecoveries++;
      const forged = Buffer.from(
        JSON.stringify({ h: String(Math.max(0, nextHeight - 1)), s: '0', e: '0' }),
        'utf8'
      )
        .toString('base64')
        .replace(/=+$/, '');
      console.log(
        `[ord-net-backfill] cursor stalled at h=${nextHeight}; forging h=${nextHeight - 1} (recovery ${stallRecoveries}/${MAX_STALL_RECOVERIES})`
      );
      cursorParam = `?cursor=${forged}`;
      prevToken = forged;
      continue;
    }
    if (zeroWriteStreak >= ARGS.earlyExitStreak) {
      console.log(
        `[ord-net-backfill] ${zeroWriteStreak} consecutive zero-write pages — early exit`
      );
      break;
    }
    prevToken = nextCursor.token;
    cursorParam = `?cursor=${nextCursor.token}`;
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[ord-net-backfill] DONE in ${elapsed}s — ` +
      `pages=${pageNum} sales=${totalSales} upgraded=${totalUpgraded} ` +
      `inserted=${totalInserted} skippedSold=${totalSkippedSold} skippedUnknown=${totalSkippedUnknown}` +
      (ARGS.dryRun ? ' (DRY RUN — no writes)' : '')
  );
  db.close();
}

main().catch(e => {
  console.error('[ord-net-backfill] FATAL:', e);
  process.exit(1);
});
