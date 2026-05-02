#!/usr/bin/env node
/* eslint-disable */
// Delete the spurious second 'sold' (or 'transferred') row that the satflow
// apply path used to write for 2-tx escrow-style settlements.
//
// Background: Satflow's `/v1/activity/sales` returns ask-orderType fills with
// THREE on-chain txids — `prepareTx` (buyer prefunds), `fillTx` (real sale,
// seller is paid, inscription parks at a marketplace escrow output), and
// `transferTx` (escrow forwards the inscription to the buyer's display
// address). ord's diff-poll observes both UTXO moves and writes two
// `transferred` rows; the satflow apply path then upgrades whichever it
// matches first. The other transferred row drifted to 'sold' via a
// combination of in-place merges + secondary movement matches across re-polls,
// resulting in two `sold` rows for the same logical sale: one with stored
// txid=fillTx (canonical), one with stored txid=transferTx (the escrow→buyer
// forwarding hop, which is settlement plumbing, not a separate sale).
//
// This script identifies the second-tx rows by matching
//   stored events.txid = json_extract(raw_json, '$.transferTx')
// with the `$.transferTx` field actually populated and distinct from `$.fillTx`.
// For each such row it:
//   1. Verifies a sibling row exists at (inscription_id, txid=fillTx). If not,
//      skip (don't drop the only sold row for this sale).
//   2. Deletes the row. notify_pending CASCADE removes any queued alert.
//   3. If the deleted row was 'sold': decrement sale_count + total_volume_sats,
//      then recompute highest_sale_sats from MAX(events.sale_price_sats).
//      If 'transferred': decrement transfer_count.
//
// Idempotent + re-runnable: a second pass finds nothing to do because the
// duplicate rows are gone.
//
// Required env:
//   OMB_DB_PATH  default ./tmp/dev.db
//
// CLI flags:
//   --apply              actually write. Default is dry-run (read-only).
//   --verbose            per-row decisions to stdout.

const path = require('node:path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.OMB_DB_PATH ?? path.resolve(__dirname, '..', 'tmp', 'dev.db');

const ARGS = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = { apply: false, verbose: false };
  for (const a of argv) {
    if (a === '--apply') out.apply = true;
    else if (a === '--verbose') out.verbose = true;
    else {
      console.error(`[repair] unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

function main() {
  const db = new Database(DB_PATH, { readonly: !ARGS.apply });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  // Find every dupe candidate: sold/transferred row whose stored txid equals
  // its raw_json.transferTx, with a non-empty + distinct fillTx in the same
  // raw_json (skip records that don't have a 2-tx settlement).
  const candidates = db
    .prepare(
      `
      SELECT id, inscription_id, inscription_number, txid, event_type, sale_price_sats,
             json_extract(raw_json, '$.fillTx')     AS sf_fill_tx,
             json_extract(raw_json, '$.transferTx') AS sf_transfer_tx
        FROM events
       WHERE event_type IN ('sold','transferred')
         AND marketplace = 'satflow'
         AND json_extract(raw_json, '$.transferTx') IS NOT NULL
         AND json_extract(raw_json, '$.transferTx') <> ''
         AND json_extract(raw_json, '$.fillTx')     IS NOT NULL
         AND json_extract(raw_json, '$.fillTx')     <> ''
         AND lower(txid) = lower(json_extract(raw_json, '$.transferTx'))
         AND lower(json_extract(raw_json, '$.fillTx')) <> lower(json_extract(raw_json, '$.transferTx'))
       ORDER BY id
    `
    )
    .all();

  console.log(`[repair] candidate transferTx-rows: ${candidates.length}`);

  const findSibling = db.prepare(`
    SELECT id, event_type FROM events
     WHERE inscription_id = @inscription_id
       AND lower(txid) = lower(@fill_txid)
       AND id <> @self_id
  `);
  const deleteEvent = db.prepare(`DELETE FROM events WHERE id = @id`);
  const decrementSale = db.prepare(`
    UPDATE inscriptions
       SET sale_count        = MAX(sale_count - 1, 0),
           total_volume_sats = MAX(total_volume_sats - COALESCE(@sale_price_sats, 0), 0)
     WHERE inscription_number = @inscription_number
  `);
  const decrementTransfer = db.prepare(`
    UPDATE inscriptions
       SET transfer_count = MAX(transfer_count - 1, 0)
     WHERE inscription_number = @inscription_number
  `);
  const recomputeHighest = db.prepare(`
    UPDATE inscriptions
       SET highest_sale_sats = COALESCE((
             SELECT MAX(sale_price_sats) FROM events
              WHERE inscription_number = @inscription_number AND event_type = 'sold'
           ), 0)
     WHERE inscription_number = @inscription_number
  `);

  const stats = { delete: 0, skip_no_sibling: 0, errors: 0 };

  // Per-inscription transactions so a single failure doesn't poison a long run
  // and so each is independently visible to live-poll readers.
  const inscriptionsTouched = new Set();
  for (const row of candidates) {
    const sibling = findSibling.get({
      inscription_id: row.inscription_id,
      fill_txid: row.sf_fill_tx,
      self_id: row.id,
    });
    if (!sibling) {
      stats.skip_no_sibling++;
      if (ARGS.verbose) {
        console.log(
          `[repair] SKIP id=${row.id} insc#${row.inscription_number} txid=${row.txid.slice(0, 16)} (no sibling at fillTx=${row.sf_fill_tx.slice(0, 16)})`
        );
      }
      continue;
    }
    if (ARGS.verbose) {
      console.log(
        `[repair] DELETE id=${row.id} insc#${row.inscription_number} type=${row.event_type} txid=${row.txid.slice(0, 16)} (sibling=${sibling.id} at fillTx=${row.sf_fill_tx.slice(0, 16)})`
      );
    }
    if (!ARGS.apply) {
      stats.delete++;
      continue;
    }

    const tx = db.transaction(() => {
      deleteEvent.run({ id: row.id });
      if (row.event_type === 'sold') {
        decrementSale.run({
          inscription_number: row.inscription_number,
          sale_price_sats: row.sale_price_sats,
        });
        recomputeHighest.run({ inscription_number: row.inscription_number });
      } else {
        decrementTransfer.run({ inscription_number: row.inscription_number });
      }
    });
    try {
      tx();
      stats.delete++;
      inscriptionsTouched.add(row.inscription_number);
    } catch (e) {
      stats.errors++;
      console.error(`[repair] ERROR id=${row.id}: ${e.message}`);
    }
  }

  console.log(
    `[repair] ${ARGS.apply ? 'APPLIED' : 'DRY-RUN'}: deleted=${stats.delete} skipped(no-sibling)=${stats.skip_no_sibling} errors=${stats.errors} inscriptions_touched=${inscriptionsTouched.size}`
  );
  if (!ARGS.apply) {
    console.log('[repair] re-run with --apply to persist changes');
  }
}

main();
