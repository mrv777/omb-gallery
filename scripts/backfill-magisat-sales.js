#!/usr/bin/env node
/* eslint-disable */
// One-shot Magisat sale backfill via their public activity API.
//
// Why: Magisat tags inscriptions by sat-rarity, not by collection — so we
// cannot ask their API for "all OMB sales" directly. Instead we walk the
// global PURCHASE / OFFER_PURCHASED feed (capped at ~6,500 rows in early
// 2026) and match each row's `buyerTxId` against our own `events.txid`.
// Every match IS an OMB Magisat sale — high confidence: it's the on-chain
// tx Magisat finalized the listing with, and our events table only contains
// OMB inscriptions.
//
// On match:
//   - if event_type='transferred' -> upgrade to 'sold', set marketplace='magisat',
//     fill sale_price_sats from snapshot, recompute aggregates.
//   - if event_type='sold' and marketplace IS NULL -> set marketplace='magisat'
//     (do not change sale_price_sats — keep whatever the existing source set).
//   - if event_type='sold' and marketplace='magisat' -> no-op (idempotent).
//   - if event_type='sold' and marketplace='satflow' (or other) -> warn + skip.
//     (Satflow is also a high-confidence first-party source; we don't want to
//     stomp it. If this happens it likely means our match is wrong.)
//
// Required env: OMB_DB_PATH (or default ./tmp/dev.db)
// Optional env: MAGISAT_BASE_URL (default https://api.magisat.io)
//
// CLI flags:
//   --dry-run            Don't write. Reports what would change.
//   --limit=N            Page size (default 50; magisat max 50).
//   --rps=R              Requests per second (default 4 — be polite).
//   --max-pages=N        Stop after N pages (default: walk to end).

const path = require('node:path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.OMB_DB_PATH ?? path.resolve(__dirname, '..', 'tmp', 'dev.db');
const BASE = (process.env.MAGISAT_BASE_URL ?? 'https://api.magisat.io').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT = 'omb-gallery-backfill/1.0 (https://ordinalmaxibiz.wiki)';

const ARGS = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = { dryRun: false, limit: 50, rps: 4, maxPages: null };
  for (const a of argv) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--limit=')) out.limit = parseInt(a.slice(8), 10);
    else if (a.startsWith('--rps=')) out.rps = parseFloat(a.slice(6));
    else if (a.startsWith('--max-pages=')) out.maxPages = parseInt(a.slice(12), 10);
    else {
      console.error(`[magisat-backfill] unknown arg: ${a}`);
      process.exit(1);
    }
  }
  if (!Number.isFinite(out.rps) || out.rps <= 0) {
    console.error('[magisat-backfill] --rps must be positive');
    process.exit(1);
  }
  if (out.limit < 1 || out.limit > 50) {
    console.error('[magisat-backfill] --limit must be 1..50 (magisat caps at 50)');
    process.exit(1);
  }
  return out;
}

// ---- HTTP + rate limit ----
const MIN_INTERVAL_MS = 1000 / ARGS.rps;
let nextSlotAt = 0;
async function waitForSlot() {
  const now = Date.now();
  const slot = Math.max(now, nextSlotAt);
  nextSlotAt = slot + MIN_INTERVAL_MS;
  if (slot > now) await new Promise(r => setTimeout(r, slot - now));
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
      if (attempt >= 4) throw new Error(`HTTP ${res.status} after ${attempt + 1} attempts`);
      const backoff = Math.min(60_000, 1000 * 2 ** attempt + Math.random() * 500);
      console.warn(`[magisat-backfill] HTTP ${res.status}; backing off ${Math.round(backoff)}ms`);
      await new Promise(r => setTimeout(r, backoff));
      return fetchJson(url, attempt + 1);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchPage(offset) {
  const url = `${BASE}/activity/global?type=PURCHASE%2COFFER_PURCHASED&isVirtual=true&isRune=false&isBrc20=false&limit=${ARGS.limit}&offset=${offset}`;
  const j = await fetchJson(url);
  return Array.isArray(j?.results) ? j.results : [];
}

// ---- DB ops ----
function openDb() {
  const db = new Database(DB_PATH, { readonly: ARGS.dryRun });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function main() {
  const db = openDb();
  // We do not insert rows — we only update existing events. Each magisat row
  // refers to a tx; if our diff-poll / chain-walk hasn't recorded a transfer
  // for that tx we have no inscription_number anchor, so we skip it.
  const findEvent = db.prepare(`
    SELECT id, inscription_number, inscription_id, event_type, marketplace,
           sale_price_sats, raw_json, block_timestamp
      FROM events
     WHERE txid = ?
  `);
  const upgradeToSoldWithMagisat = db.prepare(`
    UPDATE events SET
      event_type      = 'sold',
      marketplace     = 'magisat',
      sale_price_sats = COALESCE(@sale_price_sats, sale_price_sats),
      raw_json        = json_set(COALESCE(raw_json, '{}'), '$.magisat_backfill', json(@magisat_meta))
    WHERE id = @id
  `);
  const tagSoldMagisat = db.prepare(`
    UPDATE events SET
      marketplace = 'magisat',
      raw_json    = json_set(COALESCE(raw_json, '{}'), '$.magisat_backfill', json(@magisat_meta))
    WHERE id = @id
  `);
  const unbumpTransferOnUpgrade = db.prepare(`
    UPDATE inscriptions SET
      transfer_count    = MAX(transfer_count - 1, 0),
      sale_count        = sale_count + 1,
      total_volume_sats = total_volume_sats + COALESCE(@sale_price_sats, 0),
      highest_sale_sats = MAX(highest_sale_sats, COALESCE(@sale_price_sats, 0))
    WHERE inscription_number = @inscription_number
  `);

  const apply = db.transaction(rows => {
    let upgraded = 0,
      tagged = 0,
      noop = 0,
      collisions = 0,
      skippedNoEvent = 0;
    for (const r of rows) {
      const ev = findEvent.get(r.txid);
      if (!ev) {
        skippedNoEvent++;
        continue;
      }
      const meta = JSON.stringify({
        source: 'magisat-api-backfill',
        listing_id: r.listing_id,
        offer_id: r.offer_id,
        snapshot_price_sats: r.price,
        snapshot_type: r.type,
        seen_at: Math.floor(Date.now() / 1000),
      });
      if (ev.event_type === 'transferred') {
        upgradeToSoldWithMagisat.run({
          id: ev.id,
          sale_price_sats: r.price,
          magisat_meta: meta,
        });
        unbumpTransferOnUpgrade.run({
          inscription_number: ev.inscription_number,
          sale_price_sats: r.price,
        });
        upgraded++;
      } else if (ev.event_type === 'sold') {
        if (ev.marketplace === 'magisat') {
          noop++;
        } else if (ev.marketplace == null) {
          tagSoldMagisat.run({ id: ev.id, magisat_meta: meta });
          tagged++;
        } else {
          // Existing first-party source (e.g. satflow). Don't stomp it — but
          // do log because either our match is wrong or magisat double-listed.
          console.warn(
            `[magisat-backfill] collision on event_id=${ev.id} insc=${ev.inscription_number} ` +
              `existing marketplace=${ev.marketplace}; skipping (magisat price=${r.price})`
          );
          collisions++;
        }
      } else {
        skippedNoEvent++;
      }
    }
    return { upgraded, tagged, noop, collisions, skippedNoEvent };
  });

  return { db, findEvent, apply };
}

async function run() {
  const { db, findEvent, apply } = main();
  console.log(
    `[magisat-backfill] db=${DB_PATH} dryRun=${ARGS.dryRun} rps=${ARGS.rps} limit=${ARGS.limit}`
  );

  const startedAt = Date.now();
  let pageNum = 0;
  let scanned = 0;
  let emptyTx = 0;
  let totalUpgraded = 0;
  let totalTagged = 0;
  let totalNoop = 0;
  let totalCollisions = 0;
  let totalSkippedNoEvent = 0;

  for (let offset = 0; ; offset += ARGS.limit) {
    pageNum++;
    if (ARGS.maxPages != null && pageNum > ARGS.maxPages) {
      console.log(`[magisat-backfill] hit --max-pages=${ARGS.maxPages}`);
      break;
    }
    let results;
    try {
      results = await fetchPage(offset);
    } catch (e) {
      console.error(`[magisat-backfill] page ${pageNum} (offset=${offset}) failed:`, e.message);
      break;
    }
    if (results.length === 0) {
      console.log(`[magisat-backfill] empty page at offset=${offset} — done`);
      break;
    }

    // Build the candidate set for this page.
    const candidates = [];
    for (const row of results) {
      scanned++;
      const s = row?.data?.snapshot;
      if (!s) continue;
      const tx = s.buyerTxId;
      if (!tx) {
        emptyTx++;
        continue;
      }
      candidates.push({
        txid: tx,
        price: s.price != null ? Number(s.price) : null,
        listing_id: row.listingId ?? null,
        offer_id: row.offerId ?? null,
        type: row.type,
      });
    }

    let pageUpgraded = 0,
      pageTagged = 0,
      pageNoop = 0,
      pageCollisions = 0,
      pageSkipped = 0;
    if (candidates.length > 0) {
      if (ARGS.dryRun) {
        for (const c of candidates) {
          const ev = findEvent.get(c.txid);
          if (!ev) {
            pageSkipped++;
            continue;
          }
          if (ev.event_type === 'transferred') pageUpgraded++;
          else if (ev.event_type === 'sold') {
            if (ev.marketplace === 'magisat') pageNoop++;
            else if (ev.marketplace == null) pageTagged++;
            else pageCollisions++;
          } else pageSkipped++;
        }
      } else {
        const r = apply.immediate(candidates);
        pageUpgraded = r.upgraded;
        pageTagged = r.tagged;
        pageNoop = r.noop;
        pageCollisions = r.collisions;
        pageSkipped = r.skippedNoEvent;
      }
    }
    totalUpgraded += pageUpgraded;
    totalTagged += pageTagged;
    totalNoop += pageNoop;
    totalCollisions += pageCollisions;
    totalSkippedNoEvent += pageSkipped;

    if (pageNum % 10 === 0 || pageUpgraded + pageTagged > 0) {
      console.log(
        `[magisat-backfill] page=${pageNum} offset=${offset} cands=${candidates.length} ` +
          `upgraded=${pageUpgraded} tagged=${pageTagged} noop=${pageNoop} ` +
          `collisions=${pageCollisions} no-event=${pageSkipped}`
      );
    }

    if (results.length < ARGS.limit) {
      console.log(
        `[magisat-backfill] partial page (${results.length} < ${ARGS.limit}) — last page reached`
      );
      break;
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[magisat-backfill] DONE in ${elapsed}s — pages=${pageNum} scanned=${scanned} ` +
      `emptyBuyerTx=${emptyTx} upgraded=${totalUpgraded} tagged=${totalTagged} ` +
      `noop=${totalNoop} collisions=${totalCollisions} no-event=${totalSkippedNoEvent}` +
      (ARGS.dryRun ? ' (DRY RUN — no writes)' : '')
  );
  db.close();
}

run().catch(e => {
  console.error('[magisat-backfill] FATAL:', e);
  process.exit(1);
});
