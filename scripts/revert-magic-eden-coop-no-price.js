#!/usr/bin/env node
/* eslint-disable */
// One-shot revert for `sold` rows the Magic Eden cooperative-shape tagger
// upgraded with no extractable seller payment.
//
// Background. The §2.10 cooperative-shape match in src/lib/marketplaceFingerprint.ts
// keys on (a) presence of an ME fee output and (b) absence of an ACP signature.
// extractSalePriceSats then reads vout[feeVoutIdx-1] as the seller payment, with
// gates that null the price when:
//   - feeVoutIdx-1 == 0 (would point at the inscription destination)
//   - the vout is postage-sized
//   - >=2 postage outputs precede the fee (bulk-buy)
//
// In every observed null-price cooperative case so far, the tx ALSO has no
// other output that pays the seller — the layout is just (inscription dests,
// ME fee, change to spender). That's the no-payment delivery-leg shape
// (#11273300, ONCHAIN_TAGGING.md §6.5): the inscription moves through ME
// infrastructure (e.g. a tool that funds gas through ME's fee endpoint, or an
// accept-offer flow whose BTC moved in a sibling tx) but no actual sale
// happens in this tx. The previous code still flipped event_type='sold' and
// tagged marketplace='magic-eden', which is wrong on both counts.
//
// This script reverts those rows. Selection criterion (idempotent):
//   event_type = 'sold'
//   AND marketplace = 'magic-eden'
//   AND sale_price_sats IS NULL
//   AND raw_json.magic_eden_fp.shape = 'cooperative'
//
// We deliberately do NOT touch:
//   - cooperative rows where sale_price_sats IS NOT NULL: a different path
//     (ord-net, satflow) provided a trusted price, so it's a real sale and
//     the ME tag is just a marketplace annotation on top.
//   - ACP-shape rows with null price: ACP's per-input SIGHASH_SINGLE binds
//     the fee address cryptographically to a real listing PSBT — different
//     failure mode (DB old_owner doesn't match on-chain seller).
//
// Per-row actions:
//   1. Build new raw_json: prior_source='onchain-magic-eden-fp',
//      prior_magic_eden_fp=<old object>, reverted_at, revert_reason.
//   2. UPDATE events: event_type='transferred', marketplace=NULL, raw_json.
//      (sale_price_sats was already NULL.)
//   3. Adjust inscriptions: sale_count--, transfer_count++. No volume math
//      needed since price was NULL. highest_sale_sats unaffected.
//   4. Drop any matching notify_pending entry (defensive — sales-only subs
//      shouldn't have alerted on a price-less sold flip but we don't want
//      a stale row pointing at an event that's no longer sold).
//
// Required env: OMB_DB_PATH.
//
// CLI flags:
//   --apply           Without this, runs in dry-run mode (no DB writes).
//   --verbose         Per-row decision logs.

const path = require('node:path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.OMB_DB_PATH ?? path.resolve(__dirname, '..', 'tmp', 'dev.db');
const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');

async function main() {
  const db = new Database(DB_PATH, { readonly: !APPLY });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  const candidates = db
    .prepare(
      `SELECT id, inscription_number, txid, sale_price_sats, raw_json
         FROM events
        WHERE event_type = 'sold'
          AND marketplace = 'magic-eden'
          AND sale_price_sats IS NULL
          AND json_extract(raw_json, '$.magic_eden_fp.shape') = 'cooperative'
        ORDER BY id`
    )
    .all();

  console.log(`[revert-me-coop] db=${DB_PATH} apply=${APPLY} candidates=${candidates.length}`);

  if (candidates.length === 0) {
    db.close();
    return;
  }

  if (VERBOSE) {
    for (const ev of candidates.slice(0, 20)) {
      console.log(`  #${ev.inscription_number} id=${ev.id} tx=${ev.txid.slice(0, 12)}…`);
    }
    if (candidates.length > 20) console.log(`  … ${candidates.length - 20} more`);
  }

  if (!APPLY) {
    console.log('[revert-me-coop] DRY RUN — pass --apply to commit reverts');
    db.close();
    return;
  }

  const updateEvent = db.prepare(`
    UPDATE events
       SET event_type  = 'transferred',
           marketplace = NULL,
           raw_json    = @raw_json
     WHERE id          = @id
       AND event_type  = 'sold'
       AND marketplace = 'magic-eden'
       AND sale_price_sats IS NULL
  `);
  const adjustInscr = db.prepare(`
    UPDATE inscriptions
       SET transfer_count = transfer_count + 1,
           sale_count     = MAX(sale_count - 1, 0)
     WHERE inscription_number = @num
  `);
  const dropNotify = db.prepare(`DELETE FROM notify_pending WHERE event_id = @id`);

  const now = Math.floor(Date.now() / 1000);
  let reverted = 0;
  let notifyDropped = 0;

  const txn = db.transaction(rows => {
    for (const ev of rows) {
      const prev = JSON.parse(ev.raw_json || '{}');
      const newRaw = JSON.stringify({
        source: 'reverted-from-magic-eden-fp',
        prior_source: prev.source ?? null,
        prior_magic_eden_fp: prev.magic_eden_fp ?? null,
        // Preserve any other top-level fields the original row carried (state,
        // enriched, etc. from the ord poll path) so timeline reconstruction
        // remains possible.
        prior_state: prev.state ?? null,
        prior_enriched: prev.enriched ?? null,
        prior_txid: prev.txid ?? null,
        prior_inscriptionId: prev.inscriptionId ?? null,
        prior_priceBtc: prev.priceBtc ?? null,
        prior_from: prev.from ?? null,
        prior_to: prev.to ?? null,
        prior_timeMs: prev.timeMs ?? null,
        reverted_at: now,
        revert_reason: 'me-coop:no-extractable-payment',
      });
      const r = updateEvent.run({ id: ev.id, raw_json: newRaw });
      if (r.changes > 0) {
        adjustInscr.run({ num: ev.inscription_number });
        const d = dropNotify.run({ id: ev.id });
        notifyDropped += d.changes;
        reverted++;
      }
    }
  });

  txn.immediate(candidates);
  console.log(
    `[revert-me-coop] APPLIED: reverted ${reverted}/${candidates.length} rows; ` +
      `dropped ${notifyDropped} notify_pending entries`
  );

  db.close();
}

main().catch(e => {
  console.error('[revert-me-coop] FATAL:', e);
  process.exit(1);
});
