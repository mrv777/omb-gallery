#!/usr/bin/env node
// Repair `inscriptions.current_owner` rows that are stale relative to the
// events log.
//
// Background: before commit 2c6e316d (April 27 17:19 UTC), the satflow
// standalone-insert path wrote a `sold` event but did NOT update
// `inscriptions.current_owner`. Any sale that landed via that path while
// ord was behind chain tip left `current_owner` pointing at the previous
// (pre-sale) chain owner. The fix is in place going forward, but rows
// inserted before that commit need a one-shot repair.
//
// Truth is the events log: for any inscription, `current_owner` should
// equal the new_owner of the latest non-listed event. This script finds
// mismatches and (with --apply) reconciles them in a single transaction.
//
// Idempotent. Safe to re-run. Honors any in-flight ord/satflow polling
// (BEGIN IMMEDIATE waits its turn). Aggregate output only — never dumps
// addresses or txids beyond a small inscription-level summary.
//
// Usage:
//   node scripts/repair-stale-current-owner.mjs            # dry run
//   node scripts/repair-stale-current-owner.mjs --apply    # commit changes
//
//   SSH_HOST=ubuntu@51.195.63.213 (default)
//   DB_PATH=/var/lib/coolify-omb-data/app.db (default)

import { spawnSync } from 'node:child_process';

const SSH_HOST = process.env.SSH_HOST ?? 'ubuntu@51.195.63.213';
const DB_PATH = process.env.DB_PATH ?? '/var/lib/coolify-omb-data/app.db';
const APPLY = process.argv.includes('--apply');

function ssh(sql) {
  const r = spawnSync('ssh', [SSH_HOST, `sudo sqlite3 -separator '|' ${DB_PATH}`], {
    input: sql,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error('ssh/sqlite failed:', r.stderr);
    process.exit(1);
  }
  return r.stdout.trim();
}

// Target only the precise pre-fix bug: a satflow `sold` event whose
// block_timestamp is the inscription's `last_movement_at` (i.e. it's the
// most recent thing that touched the row, per `bumpInscriptionAggregates`)
// but whose new_owner doesn't match `current_owner` (i.e.
// `setInscriptionOwnerIfNewer` never ran for it).
//
// Why not "latest event by (block_timestamp, id)" generically: events
// from `ord-history-backfill` get higher event IDs than `ord` live events
// for the same block, so an ID-based tiebreaker spuriously identifies
// backfill events as "latest" when the chain order is the opposite. Using
// `last_movement_at` as the gate filters that out — backfill events for
// older blocks don't push last_movement_at past a newer live event.
const FIND_MISMATCHES_SQL = `
SELECT
  i.inscription_number,
  i.collection_slug,
  COALESCE(i.current_owner, ''),
  e.new_owner,
  e.block_timestamp,
  e.event_type,
  COALESCE(e.marketplace, '')
FROM inscriptions i
JOIN events e
  ON  e.inscription_number = i.inscription_number
  AND e.event_type         = 'sold'
  AND e.marketplace        = 'satflow'
  AND e.new_owner         IS NOT NULL
  AND e.block_timestamp    = COALESCE(i.last_movement_at, 0)
WHERE COALESCE(i.current_owner, '') != e.new_owner
ORDER BY i.inscription_number;
`;

const mismatches = ssh(FIND_MISMATCHES_SQL);

if (!mismatches) {
  console.log('=== no stale current_owner rows ===');
  console.log('events log is fully reconciled with inscriptions.current_owner');
  process.exit(0);
}

const rows = mismatches.split('\n').map(line => {
  const [insc, slug, cur, latest, ts, etype, mkt] = line.split('|');
  return {
    inscription_number: parseInt(insc, 10),
    collection_slug: slug,
    current_owner: cur,
    latest_owner: latest,
    block_timestamp: parseInt(ts, 10),
    event_type: etype,
    marketplace: mkt,
  };
});

console.log(`=== found ${rows.length} stale current_owner row(s) ===`);
console.log('inscription | slug   | event_type | marketplace | latest_event_at');
for (const r of rows.slice(0, 20)) {
  console.log(
    `#${String(r.inscription_number).padEnd(10)} | ${r.collection_slug.padEnd(6)} | ${r.event_type.padEnd(10)} | ${r.marketplace.padEnd(11)} | ${new Date(r.block_timestamp * 1000).toISOString()}`
  );
}
if (rows.length > 20) console.log(`  …and ${rows.length - 20} more`);

// Group by event_type + marketplace so we can characterise the cause.
const buckets = new Map();
for (const r of rows) {
  const key = `${r.event_type}/${r.marketplace || '(none)'}`;
  buckets.set(key, (buckets.get(key) ?? 0) + 1);
}
console.log();
console.log('=== breakdown by latest event type ===');
for (const [k, v] of buckets) console.log(`  ${k}: ${v}`);

if (!APPLY) {
  console.log();
  console.log('(dry run — pass --apply to execute the repair)');
  process.exit(0);
}

// Apply: single UPDATE inside an IMMEDIATE transaction so it serializes
// cleanly with the live ord/satflow cron.
const APPLY_SQL = `
BEGIN IMMEDIATE;
UPDATE inscriptions AS i
SET current_owner = (
  SELECT e.new_owner FROM events e
  WHERE e.inscription_number = i.inscription_number
    AND e.event_type         = 'sold'
    AND e.marketplace        = 'satflow'
    AND e.new_owner         IS NOT NULL
    AND e.block_timestamp    = COALESCE(i.last_movement_at, 0)
  ORDER BY e.id DESC
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1 FROM events e
  WHERE e.inscription_number = i.inscription_number
    AND e.event_type         = 'sold'
    AND e.marketplace        = 'satflow'
    AND e.new_owner         IS NOT NULL
    AND e.block_timestamp    = COALESCE(i.last_movement_at, 0)
    AND e.new_owner         != COALESCE(i.current_owner, '')
);
SELECT changes();
COMMIT;
`;

console.log();
console.log('=== applying repair ===');
const result = ssh(APPLY_SQL);
console.log(`rows updated: ${result}`);
