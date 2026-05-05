#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
//
// One-shot cleanup of historical loan-* events that pre-date the Phase 4
// pubkey gate (DETECTOR_VERSION = 3, added 2026-05-04). See
// ONCHAIN_TAGGING.md §2.2 / §7.2.
//
// The live detector now filters every taproot script-path spend by control-
// block internal pubkey (must equal `9367…d27a` to qualify as a Liquidium
// loan resolution). Earlier detector versions did not — they accepted any
// OP_CSV+OP_DROP spend regardless of internal pubkey, which produced 3
// known false positives (2× pubkey `428a…`, 1× pubkey `2e8f…`) and may
// have produced others that escaped notice.
//
// Only `loan-defaulted` and `loan-unlocked` events have script-path
// witness data on their own `txid` — those are the spend txs whose witness
// reveals the internal pubkey. `loan-originated` (escrow funding tx, plain
// key-path) and `loan-repaid` (borrower → lender BTC payment tx, also no
// script-path) are derivative rows that get inserted by Phase 4 ONLY in
// response to a confirmed default/unlock. So:
//
//   1. Walk loan-defaulted + loan-unlocked rows with
//      raw_json.detector_version < 3 (or missing). Refetch each spend tx
//      and verify the control-block internal pubkey is Liquidium's.
//   2. For non-Liquidium spends: also pull the matching loan-originated
//      and loan-repaid rows by `raw_json.escrow_addr` (Phase 4 tags every
//      loan-* row in the chain with the same escrow_addr). Revert the
//      whole chain together — leaving an orphaned origination would
//      keep loan_count high and the lender wallet credited.
//   3. Revert each row to `transferred` + clear marketplace +
//      sale_price_sats, stamp raw_json.source = 'reverted-from-non-
//      liquidium-loan' with the prior event_type preserved.
//   4. Recompute per-inscription loan_count / active_loan_count /
//      effective_owner so leaderboards stay consistent.
//
// Required env:
//   BITCOIN_RPC_URL    e.g. http://user:<password>@127.0.0.1:8332
// Optional env:
//   OMB_DB_PATH        default ./tmp/dev.db
//   CONCURRENCY        default 4
//
// CLI flags:
//   --dry-run          Don't write to DB. Logs proposed reverts only.
//   --verbose          Per-row debug logs.
//
// Idempotent. Re-running upgrades the same rows once and is a no-op afterward
// (reverted rows are no longer event_type IN ('loan-...')).

const path = require('node:path');
const Database = require('better-sqlite3');

const LIQUIDIUM_INTERNAL_PUBKEY =
  '93674766caa3db9c0f63c4b74f302510c509d6d0ffac9d67214d8f03cb2ed27a';

const REQUEST_TIMEOUT_MS = 30_000;
const BATCH_SIZE = 200;

const { url: RPC_URL, authHeader: RPC_AUTH } = (() => {
  const raw = process.env.BITCOIN_RPC_URL;
  if (!raw) return { url: null, authHeader: null };
  try {
    const u = new URL(raw);
    const user = decodeURIComponent(u.username);
    const pass = decodeURIComponent(u.password);
    u.username = '';
    u.password = '';
    const authHeader =
      user || pass ? 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') : null;
    return { url: u.toString(), authHeader };
  } catch {
    return { url: raw, authHeader: null };
  }
})();
const DB_PATH = process.env.OMB_DB_PATH ?? path.resolve(__dirname, '..', 'tmp', 'dev.db');
const CONCURRENCY = parseInt(process.env.CONCURRENCY ?? '4', 10);

const ARGS = (() => {
  const out = { dryRun: false, verbose: false };
  for (const a of process.argv.slice(2)) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--verbose') out.verbose = true;
    else {
      console.error(`[cleanup-loans] unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return out;
})();

if (!RPC_URL) {
  console.error('[cleanup-loans] BITCOIN_RPC_URL is required');
  process.exit(1);
}

let rpcId = 0;
async function rpc(method, params = []) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = { 'content-type': 'application/json' };
    if (RPC_AUTH) headers['authorization'] = RPC_AUTH;
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '1.0', id: ++rpcId, method, params }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`rpc ${method} HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const j = await res.json();
    if (j.error) throw new Error(`rpc ${method} error: ${JSON.stringify(j.error)}`);
    return j.result;
  } finally {
    clearTimeout(t);
  }
}

// Returns the control block's internal pubkey hex (lowercased) if vin is a
// taproot script-path spend; null if vin is key-path or non-taproot.
function internalPubkeyFromVin(vin) {
  if (!vin || !Array.isArray(vin.txinwitness)) return null;
  if (vin.txinwitness.length < 2) return null;
  const controlBlock = vin.txinwitness[vin.txinwitness.length - 1];
  if (typeof controlBlock !== 'string' || controlBlock.length < 66) return null;
  const firstByte = parseInt(controlBlock.slice(0, 2), 16);
  if (firstByte !== 0xc0 && firstByte !== 0xc1) return null;
  return controlBlock.slice(2, 66).toLowerCase();
}

async function checkRow(row) {
  let tx;
  try {
    tx = await rpc('getrawtransaction', [row.txid, 2]);
  } catch (e) {
    return { row, isLiquidium: null, error: e.message };
  }
  // A loan resolution (default/unlock) spends the escrow output via
  // script-path. Walk every vin; if at least one has the Liquidium pubkey
  // in its control block, this is a Liquidium spend.
  for (const vin of tx.vin ?? []) {
    const pk = internalPubkeyFromVin(vin);
    if (pk == null) continue;
    if (pk === LIQUIDIUM_INTERNAL_PUBKEY) return { row, isLiquidium: true, error: null };
  }
  // No vin had a Liquidium control block — either there's no script-path
  // at all (definitely not a loan resolution) or the pubkey doesn't match
  // (some other escrow service mis-tagged as Liquidium). Either way: revert.
  return { row, isLiquidium: false, error: null };
}

async function main() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Only loan-defaulted + loan-unlocked events have script-path witness
  // data on their own txid. loan-originated (escrow funding) and
  // loan-repaid (borrower→lender BTC) txs are not script-path spends — we
  // pull those in a second pass via raw_json.escrow_addr after the spend
  // events are flagged.
  const candidates = db
    .prepare(
      `SELECT id, txid, inscription_number, event_type,
              json_extract(raw_json, '$.escrow_addr')      AS escrow_addr,
              json_extract(raw_json, '$.detector_version') AS detector_version
         FROM events
        WHERE event_type IN ('loan-defaulted','loan-unlocked')
          AND (
            json_extract(raw_json, '$.detector_version') IS NULL
            OR CAST(json_extract(raw_json, '$.detector_version') AS INTEGER) < 3
          )
        ORDER BY id ASC`
    )
    .all();

  if (candidates.length === 0) {
    console.log(
      '[cleanup-loans] no loan-defaulted/loan-unlocked candidates with detector_version < 3 — nothing to do'
    );
    return;
  }
  console.log(
    `[cleanup-loans] ${candidates.length} loan-defaulted/loan-unlocked candidate(s) to verify on chain`
  );

  // Bounded-concurrency worker.
  const reverts = [];
  const errors = [];
  let next = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (next < candidates.length) {
      const row = candidates[next++];
      const r = await checkRow(row);
      if (r.error) {
        errors.push(r);
        if (ARGS.verbose) {
          console.error(
            `[cleanup-loans] rpc error on event#${row.id} (txid=${row.txid}):`,
            r.error
          );
        }
        continue;
      }
      if (!r.isLiquidium) {
        reverts.push(row);
        if (ARGS.verbose) {
          console.log(
            `[cleanup-loans] reverting event#${row.id} (txid=${row.txid}, type=${row.event_type}, inscription=${row.inscription_number}) — non-Liquidium control block`
          );
        }
      }
    }
  });
  await Promise.all(workers);

  console.log(
    `[cleanup-loans] ${reverts.length} non-Liquidium spend row(s); ${errors.length} RPC error(s)`
  );

  // Pull associated loan-originated + loan-repaid rows for each non-
  // Liquidium escrow_addr. These were inserted by the same buggy detector
  // pass and must come along for the revert.
  const associated = [];
  if (reverts.length > 0) {
    const escrows = Array.from(new Set(reverts.map(r => r.escrow_addr).filter(Boolean)));
    if (escrows.length > 0) {
      const placeholders = escrows.map(() => '?').join(',');
      const assoc = db
        .prepare(
          `SELECT id, txid, inscription_number, event_type
             FROM events
            WHERE event_type IN ('loan-originated','loan-repaid')
              AND json_extract(raw_json, '$.escrow_addr') IN (${placeholders})`
        )
        .all(...escrows);
      associated.push(...assoc);
    }
  }
  console.log(
    `[cleanup-loans] ${associated.length} associated loan-originated/loan-repaid row(s) tied to those escrows`
  );

  if (ARGS.verbose) {
    for (const a of associated) {
      console.log(
        `[cleanup-loans] (associated) reverting event#${a.id} (txid=${a.txid}, type=${a.event_type}, inscription=${a.inscription_number})`
      );
    }
  }

  const allReverts = [...reverts, ...associated];

  if (ARGS.dryRun || allReverts.length === 0) {
    if (ARGS.dryRun) console.log(`[cleanup-loans] dry-run, no writes (${allReverts.length} total)`);
    return;
  }

  // Apply reverts in a transaction so the aggregate recompute sees a
  // consistent snapshot.
  const revertOne = db.prepare(
    `UPDATE events
        SET event_type      = 'transferred',
            marketplace     = NULL,
            sale_price_sats = NULL,
            raw_json        = json_set(
              COALESCE(raw_json, '{}'),
              '$.source',         'reverted-from-non-liquidium-loan',
              '$.reverted_at',    unixepoch(),
              '$.prior_event_type', @event_type,
              '$.prior_source',   COALESCE(json_extract(raw_json, '$.source'), 'onchain-loan-heuristic')
            )
      WHERE id = @id`
  );

  // Inscriptions whose aggregates need recomputing = the ones we touched.
  const affected = new Set(allReverts.map(r => r.inscription_number));

  const apply = db.transaction(() => {
    for (const row of allReverts) {
      revertOne.run({ id: row.id, event_type: row.event_type });
    }
    // Recompute loan_count / active_loan_count / effective_owner for the
    // affected inscriptions. loan_count = total loan-originated events;
    // active_loan_count = loan-originated rows whose escrow has not been
    // resolved (no later loan-defaulted/loan-unlocked/loan-repaid for the
    // same inscription); effective_owner falls back to current_owner when
    // active_loan_count drops to 0.
    const placeholders = Array.from(affected).map(() => '?').join(',');
    db.prepare(
      `UPDATE inscriptions
          SET loan_count = (
                SELECT COUNT(*) FROM events e
                 WHERE e.inscription_number = inscriptions.inscription_number
                   AND e.event_type = 'loan-originated'
              ),
              active_loan_count = (
                SELECT COUNT(*) FROM events e
                 WHERE e.inscription_number = inscriptions.inscription_number
                   AND e.event_type = 'loan-originated'
                   AND NOT EXISTS (
                     SELECT 1 FROM events r
                      WHERE r.inscription_number = e.inscription_number
                        AND r.id > e.id
                        AND r.event_type IN ('loan-defaulted','loan-unlocked','loan-repaid')
                   )
              )
        WHERE inscription_number IN (${placeholders})`
    ).run(...Array.from(affected));
    // Reset effective_owner to current_owner where active_loan_count is now 0.
    // The Phase 4 detector only diverges effective_owner from current_owner
    // while a loan is open; if there are no open loans, effective_owner must
    // mirror chain truth.
    db.prepare(
      `UPDATE inscriptions
          SET effective_owner = current_owner
        WHERE inscription_number IN (${placeholders})
          AND active_loan_count = 0`
    ).run(...Array.from(affected));
  });
  apply();

  console.log(
    `[cleanup-loans] reverted ${allReverts.length} row(s) (${reverts.length} spend + ${associated.length} associated); recomputed ${affected.size} inscription aggregate(s)`
  );
}

main().catch(e => {
  console.error('[cleanup-loans] failed:', e);
  process.exit(1);
});
