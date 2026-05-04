#!/usr/bin/env node
/* eslint-disable */
// One-shot repair: downgrade rows tagged by the v1 loan detector back to
// 'transferred' so the v2 backfill (scripts/backfill-loans.js) can reclassify
// them with the stricter guards + new event types (unlock/repaid).
//
// What v1 left behind on prod:
//   - 251 loan-originated + 251 loan-defaulted rows
//   - transfer_count was decremented for each upgrade
//   - loan_count / active_loan_count never bumped (v1 predates those columns)
//   - effective_owner never diverged from current_owner (v1 predates that column)
//   - 11 rows are likely false positives (atomic swaps / HTLCs the v2 parser
//     correctly rejects)
//
// What this script does:
//   1. Finds events with raw_json containing "detector_version":1 and
//      event_type IN ('loan-originated','loan-defaulted')
//   2. For each, sets event_type='transferred' and clears raw_json
//   3. For each affected inscription, restores transfer_count += <count of
//      reverted events for that inscription>
//
// What this DOES NOT touch:
//   - effective_owner (v1 didn't change it; nothing to revert)
//   - loan_count / active_loan_count (v1 didn't bump them; already 0)
//   - notify_pending (v1 backfill explicitly didn't enqueue; nothing to clean)
//
// Run BEFORE scripts/backfill-loans.js --write. Idempotent — second run is a
// no-op since the v1 rows no longer exist after first run.
//
// Required env:
//   OMB_DB_PATH   default ./tmp/dev.db
//
// CLI flags:
//   --dry-run     Default. Print what would change.
//   --write       Apply the changes.

const path = require('node:path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.OMB_DB_PATH ?? path.resolve(__dirname, '..', 'tmp', 'dev.db');
const ARGS = (() => {
  const out = { dryRun: true };
  for (const a of process.argv.slice(2)) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--write') out.dryRun = false;
    else {
      console.error(`[repair-v1-loans] unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return out;
})();

function main() {
  const db = new Database(DB_PATH, { readonly: ARGS.dryRun });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  console.log(`[repair-v1-loans] db=${DB_PATH} dryRun=${ARGS.dryRun}`);

  // detector_version is a JSON field. SQLite's json_extract works against
  // raw_json; we use that rather than LIKE to avoid false-positive matches
  // on raw_json values that happen to contain "detector_version":1 in some
  // unrelated context.
  const findSql = `
    SELECT id, inscription_id, inscription_number, event_type, txid
      FROM events
     WHERE event_type IN ('loan-originated','loan-defaulted','loan-unlocked','loan-repaid')
       AND json_extract(raw_json, '$.detector_version') = 1
  `;
  const rows = db.prepare(findSql).all();

  console.log(`[repair-v1-loans] found ${rows.length} v1-tagged rows to revert`);
  if (rows.length === 0) {
    console.log(`[repair-v1-loans] nothing to do`);
    db.close();
    return;
  }

  // Group by event_type for the summary.
  const byType = Object.create(null);
  const byInscription = new Map(); // inscription_number → count
  for (const r of rows) {
    byType[r.event_type] = (byType[r.event_type] ?? 0) + 1;
    byInscription.set(r.inscription_number, (byInscription.get(r.inscription_number) ?? 0) + 1);
  }
  console.log(`[repair-v1-loans] by event_type:`, byType);
  console.log(`[repair-v1-loans] affecting ${byInscription.size} distinct inscriptions`);

  // Sample the first 5 for human eyeball.
  console.log(`[repair-v1-loans] sample (first 5):`);
  for (const r of rows.slice(0, 5)) {
    console.log(
      `  id=${r.id} #${r.inscription_number} type=${r.event_type} txid=${r.txid.slice(0, 16)}…`
    );
  }

  if (ARGS.dryRun) {
    console.log(`[repair-v1-loans] dry-run — no writes`);
    db.close();
    return;
  }

  // Atomic: revert all events + restore transfer_counts in one transaction.
  const downgradeStmt = db.prepare(`
    UPDATE events
       SET event_type = 'transferred',
           raw_json   = NULL
     WHERE id = @id
  `);
  const restoreCountStmt = db.prepare(`
    UPDATE inscriptions
       SET transfer_count = transfer_count + @delta
     WHERE inscription_number = @inscription_number
  `);

  let downgraded = 0;
  let restored = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const u = downgradeStmt.run({ id: r.id });
      if (u.changes > 0) downgraded++;
    }
    byInscription.forEach((delta, inscription_number) => {
      const u = restoreCountStmt.run({ delta, inscription_number });
      if (u.changes > 0) restored++;
    });
  });
  tx.immediate();

  console.log(
    `[repair-v1-loans] done — downgraded=${downgraded} inscriptions-restored=${restored}`
  );

  db.close();
}

main();
