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
// What this script does:
//   1. Finds every event row of type loan-originated / loan-defaulted /
//      loan-unlocked / loan-repaid whose raw_json.detector_version != 3
//      (or is missing, i.e. older row). These are the "needs reverification"
//      rows.
//   2. For each, fetches the spend tx via bitcoind RPC and re-extracts the
//      taproot script-path control block.
//   3. If the internal pubkey != `9367…d27a`, reverts the row to
//      `transferred` + clears marketplace + sale_price_sats, stamps
//      raw_json.source = 'reverted-from-non-liquidium-loan'.
//   4. Recomputes per-inscription `loan_count` / `active_loan_count` /
//      `effective_owner` for every affected inscription so leaderboards stay
//      consistent.
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
  // A loan resolution spends the escrow output via script-path. The escrow
  // is the input whose prevout = old_owner. If we can't identify it, fall
  // back to "any vin with a script-path control block" — Liquidium spends
  // are always script-path, so the answer is invariant: if NONE of the
  // script-path vins have the Liquidium pubkey, this isn't Liquidium.
  let sawLiquidiumPubkey = false;
  let sawAnyScriptPath = false;
  for (const vin of tx.vin ?? []) {
    const pk = internalPubkeyFromVin(vin);
    if (pk == null) continue;
    sawAnyScriptPath = true;
    if (pk === LIQUIDIUM_INTERNAL_PUBKEY) {
      sawLiquidiumPubkey = true;
      break;
    }
  }
  if (!sawAnyScriptPath) {
    // No script-path spend at all — definitely not a loan resolution.
    return { row, isLiquidium: false, error: null };
  }
  return { row, isLiquidium: sawLiquidiumPubkey, error: null };
}

async function main() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Pull every loan-* event whose detector_version is < 3 or missing. v3 is
  // the marker added to rows tagged AFTER the pubkey gate landed; older rows
  // need reverification.
  const candidates = db
    .prepare(
      `SELECT id, txid, inscription_number, event_type,
              json_extract(raw_json, '$.detector_version') AS detector_version
         FROM events
        WHERE event_type IN ('loan-originated','loan-defaulted','loan-unlocked','loan-repaid')
          AND (
            json_extract(raw_json, '$.detector_version') IS NULL
            OR CAST(json_extract(raw_json, '$.detector_version') AS INTEGER) < 3
          )
        ORDER BY id ASC`
    )
    .all();

  if (candidates.length === 0) {
    console.log('[cleanup-loans] no candidates with detector_version < 3 — nothing to do');
    return;
  }
  console.log(
    `[cleanup-loans] ${candidates.length} candidate loan-* event(s) with detector_version < 3`
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
    `[cleanup-loans] ${reverts.length} non-Liquidium row(s) to revert; ${errors.length} RPC error(s)`
  );

  if (ARGS.dryRun || reverts.length === 0) {
    if (ARGS.dryRun) console.log('[cleanup-loans] dry-run, no writes');
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
  const affected = new Set(reverts.map(r => r.inscription_number));

  const apply = db.transaction(() => {
    for (const row of reverts) {
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
    `[cleanup-loans] reverted ${reverts.length} row(s); recomputed ${affected.size} inscription aggregate(s)`
  );
}

main().catch(e => {
  console.error('[cleanup-loans] failed:', e);
  process.exit(1);
});
