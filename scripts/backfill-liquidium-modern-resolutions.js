#!/usr/bin/env node
/*
 * Backfill modern Liquidium loan resolutions (repaid / defaulted / unlocked).
 *
 * Companion to backfill-liquidium-originations.js. After originations have
 * been promoted to 'loan-originated', this script walks each escrow address
 * forward and fingerprints the spend that closed the loan. Matches upgrade
 * the corresponding `transferred` row in place to one of:
 *
 *   - loan-repaid    (cooperative path — leaf is 270 hex chars, no OP_CSV)
 *   - loan-defaulted (CSV-gated lender claim — leaf contains b275)
 *   - loan-unlocked  (modern Liquidium internal pubkey but unrecognized leaf)
 *
 * Idempotent. Skips rows already classified as loan-*. Does NOT enqueue
 * notify_pending — historical retag must not page subscribers.
 *
 * Requires BITCOIN_RPC_URL and OMB_DB_PATH (default /data/app.db).
 * ONCHAIN_TAGGING.md §2.5.
 */

const Database = require('better-sqlite3');

const DB_PATH = process.env.OMB_DB_PATH || '/data/app.db';
const LIMIT = Number.parseInt(process.env.LIMIT || '0', 10);
const DRY_RUN = process.argv.includes('--dry-run');
const DETECTOR_VERSION = 3;

const LIQUIDIUM_MODERN_INTERNAL_PUBKEY =
  '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0';
const LIQUIDIUM_ACTIVATION_FEE_ADDR =
  'bc1papmpmu0xzfvw4x9qe4jstgxfnfy5q8zhh6xredjxd86ca74uph3s59se9u';

const { rpcUrl, rpcAuth } = (() => {
  const raw = process.env.BITCOIN_RPC_URL;
  if (!raw) return { rpcUrl: null, rpcAuth: null };
  try {
    const u = new URL(raw);
    const user = decodeURIComponent(u.username);
    const pass = decodeURIComponent(u.password);
    u.username = '';
    u.password = '';
    return {
      rpcUrl: u.toString(),
      rpcAuth: user || pass ? 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') : null,
    };
  } catch {
    return { rpcUrl: raw, rpcAuth: null };
  }
})();

if (!rpcUrl) {
  console.error('BITCOIN_RPC_URL is required');
  process.exit(1);
}

let rpcId = 0;
async function rpc(method, params = []) {
  const headers = { 'content-type': 'application/json' };
  if (rpcAuth) headers.authorization = rpcAuth;
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '1.0', id: ++rpcId, method, params }),
  });
  if (!res.ok)
    throw new Error(`rpc ${method} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  if (j.error) throw new Error(`rpc ${method} error: ${JSON.stringify(j.error)}`);
  return j.result;
}

function addr(o) {
  return (
    o?.address ??
    o?.scriptpubkey_address ??
    o?.scriptPubKey?.address ??
    o?.scriptPubKey?.addresses?.[0] ??
    null
  );
}
function typ(o) {
  return o?.type ?? o?.scriptpubkey_type ?? o?.scriptPubKey?.type ?? null;
}
function isP2tr(t) {
  return t === 'v1_p2tr' || t === 'witness_v1_taproot';
}

function classifyResolution(tx) {
  if (!Array.isArray(tx?.vin) || !Array.isArray(tx?.vout) || tx.vin.length === 0) return null;
  const vin0 = tx.vin[0];
  const witness = vin0?.txinwitness ?? vin0?.witness ?? [];
  if (witness.length < 2) return null;
  if (!isP2tr(typ(vin0?.prevout))) return null;
  const escrow = addr(vin0?.prevout);
  if (!escrow) return null;

  const cb = witness[witness.length - 1];
  const leaf = witness[witness.length - 2];
  if (typeof cb !== 'string' || typeof leaf !== 'string') return null;
  if (cb.length < 66) return null;
  const cbBytes = cb.length / 2;
  if ((cbBytes - 33) % 32 !== 0) return null;
  const firstByte = parseInt(cb.slice(0, 2), 16);
  if (firstByte !== 0xc0 && firstByte !== 0xc1) return null;
  if (cb.slice(2, 66).toLowerCase() !== LIQUIDIUM_MODERN_INTERNAL_PUBKEY) return null;

  const leafLower = leaf.toLowerCase();
  let resolution;
  if (leafLower.includes('b275')) {
    resolution = 'defaulted';
  } else if (
    leaf.length === 270 &&
    leaf.slice(0, 2) === '20' &&
    leaf.slice(66, 68) === 'ad' &&
    leaf.slice(68, 70) === '20' &&
    leaf.slice(134, 136) === 'ad' &&
    leaf.slice(136, 138) === '42' &&
    tx.vout.some(v => addr(v) === LIQUIDIUM_ACTIVATION_FEE_ADDR)
  ) {
    resolution = 'repaid';
  } else {
    resolution = 'unlocked';
  }

  return {
    resolution,
    escrowAddress: escrow,
    destinationAddress: addr(tx.vout[0]),
    leafScriptHex: leafLower,
  };
}

const db = new Database(DB_PATH);
db.pragma('busy_timeout = 5000');

// Find every transferred row that came out of a modern-loan escrow but hasn't
// been reclassified yet. Joining on origination → escrow → exit-event picks up
// only rows we have a good reason to inspect (no full chain scan).
//
// Ordering trap: `events.id` is NOT chronological for rows inserted by
// scripts/backfill-transfers.js — that script walks each inscription's chain
// backward from the current satpoint, so older events get higher ids than
// newer ones. Joining on `e.id > m.orig_id` would silently miss every
// pre-backfill resolution. Use block_timestamp/block_height instead.
const rows = db
  .prepare(
    `
    WITH modern_origs AS (
      SELECT inscription_number,
             new_owner       AS escrow_addr,
             id              AS orig_id,
             block_timestamp AS orig_ts,
             block_height    AS orig_height
        FROM events
       WHERE event_type = 'loan-originated'
         AND json_extract(raw_json, '$.source') IN
             ('liquidium-modern-origination-fingerprint','known-liquidium-origination-fixture')
    )
    SELECT DISTINCT e.id, e.inscription_id, e.inscription_number, e.txid,
                    e.event_type, e.old_owner, e.new_owner
      FROM events e
      JOIN modern_origs m
        ON m.inscription_number = e.inscription_number
       AND e.old_owner = m.escrow_addr
       AND (
         (e.block_height IS NOT NULL AND m.orig_height IS NOT NULL AND e.block_height > m.orig_height)
         OR (e.block_height IS NULL OR m.orig_height IS NULL)
            AND e.block_timestamp >= m.orig_ts
       )
     WHERE e.event_type = 'transferred'
     ORDER BY e.id ASC
     ${LIMIT > 0 ? 'LIMIT @limit' : ''}
  `
  )
  .all({ limit: LIMIT });

const stmts = {
  upgradeRepaid: db.prepare(`
    UPDATE events SET event_type='loan-repaid', raw_json=@raw_json
     WHERE id=@id AND event_type='transferred'
  `),
  upgradeDefaulted: db.prepare(`
    UPDATE events SET event_type='loan-defaulted', raw_json=@raw_json
     WHERE id=@id AND event_type='transferred'
  `),
  upgradeUnlocked: db.prepare(`
    UPDATE events SET event_type='loan-unlocked', raw_json=@raw_json
     WHERE id=@id AND event_type='transferred'
  `),
  onResolution: db.prepare(`
    UPDATE inscriptions SET
      transfer_count    = MAX(transfer_count - 1, 0),
      active_loan_count = MAX(active_loan_count - 1, 0),
      effective_owner   = current_owner
    WHERE inscription_number = @inscription_number
  `),
  dequeueNotify: db.prepare(`DELETE FROM notify_pending WHERE event_id = @id`),
};

const apply = db.transaction(item => {
  const raw_json = JSON.stringify({
    source: 'liquidium-modern-resolution-fingerprint',
    confidence: 'high',
    loan_type: item.match.resolution,
    escrow_addr: item.match.escrowAddress,
    destination_addr: item.match.destinationAddress,
    leaf_script_hex: item.match.leafScriptHex,
    detector_version: DETECTOR_VERSION,
  });
  const upgrade =
    item.match.resolution === 'repaid'
      ? stmts.upgradeRepaid
      : item.match.resolution === 'defaulted'
        ? stmts.upgradeDefaulted
        : stmts.upgradeUnlocked;
  const r = upgrade.run({ id: item.row.id, raw_json });
  if (r.changes === 0) return false;
  stmts.onResolution.run({ inscription_number: item.row.inscription_number });
  stmts.dequeueNotify.run({ id: item.row.id });
  return true;
});

async function main() {
  const stats = { checked: 0, matched: 0, changed: 0, repaid: 0, defaulted: 0, unlocked: 0 };
  const failures = [];

  for (const row of rows) {
    stats.checked++;
    let tx;
    try {
      tx = await rpc('getrawtransaction', [row.txid, 2]);
    } catch (e) {
      failures.push({ txid: row.txid, error: e.message });
      continue;
    }
    const match = classifyResolution(tx);
    if (!match) continue;
    stats.matched++;
    stats[match.resolution]++;
    if (!DRY_RUN && apply.immediate({ row, match })) stats.changed++;
  }

  // Two repair passes against drift between aggregate counters and the
  // events table. Both are idempotent and recompute from events as the
  // ground truth.
  //
  // (1) active_loan_count: the live `runLoanTick` clamps decrements at 0
  //     (`MAX(active_loan_count - 1, 0)`). If a resolution event arrives
  //     before its corresponding origination has been tagged, the decrement
  //     no-ops, and a later origination backfill will bump active_loan_count
  //     past the true value. The collision is rare but real (observed once
  //     on the 2026-05-05 relaxed-rule rollout: a default tx confirmed
  //     between deploy and origination backfill). Recompute from events:
  //     active = (origs) - (defaulted + unlocked + modern_repaid). Legacy
  //     onchain-loan-heuristic emits both unlock + repaid per loan; only
  //     unlock decrements active_loan_count, so legacy repaid is excluded.
  //
  // (2) effective_owner: each resolution UPDATE during the loop above
  //     sets effective_owner = current_owner. If a resolution gets a
  //     higher event_id than a chronologically-earlier open origination
  //     (typical when this backfill runs after the origination backfill),
  //     the resolution's UPDATE clobbers the origination's
  //     effective_owner = borrower. Repair restores borrower for active
  //     loans, then current_owner for closed loans.
  let activeLoanCountFixes = 0;
  let effectiveOwnerFixes = 0;
  if (!DRY_RUN) {
    const repairCount = db.prepare(`
      WITH counts AS (
        SELECT inscription_number,
               SUM(CASE WHEN event_type = 'loan-originated' THEN 1 ELSE 0 END) AS o,
               SUM(CASE WHEN event_type IN ('loan-defaulted','loan-unlocked') THEN 1 ELSE 0 END)
             + SUM(CASE WHEN event_type = 'loan-repaid'
                         AND json_extract(raw_json,'$.source')='liquidium-modern-resolution-fingerprint'
                        THEN 1 ELSE 0 END) AS r
          FROM events WHERE event_type LIKE 'loan-%' GROUP BY inscription_number
      )
      UPDATE inscriptions
         SET active_loan_count = MAX(
           (SELECT o - r FROM counts WHERE counts.inscription_number = inscriptions.inscription_number),
           0
         )
       WHERE inscription_number IN (SELECT inscription_number FROM counts)
         AND active_loan_count != MAX(
           (SELECT o - r FROM counts WHERE counts.inscription_number = inscriptions.inscription_number),
           0
         )
    `).run();
    activeLoanCountFixes = repairCount.changes;

    // After active_loan_count is correct, repair effective_owner. For
    // active loans → borrower of latest origination. For closed → current_owner.
    const repairBorrower = db.prepare(`
      WITH latest_open_orig AS (
        SELECT inscription_number,
               json_extract(raw_json,'$.borrower_addr') AS borrower,
               ROW_NUMBER() OVER (PARTITION BY inscription_number
                                  ORDER BY block_timestamp DESC, id DESC) AS rn,
               event_type
          FROM events
         WHERE event_type LIKE 'loan-%'
      )
      UPDATE inscriptions
         SET effective_owner = (
           SELECT borrower FROM latest_open_orig
            WHERE latest_open_orig.inscription_number = inscriptions.inscription_number
              AND rn = 1 AND event_type = 'loan-originated' AND borrower IS NOT NULL
         )
       WHERE active_loan_count > 0
         AND inscription_number IN (
           SELECT inscription_number FROM latest_open_orig
            WHERE rn = 1 AND event_type = 'loan-originated' AND borrower IS NOT NULL
         )
         AND effective_owner != (
           SELECT borrower FROM latest_open_orig
            WHERE latest_open_orig.inscription_number = inscriptions.inscription_number
              AND rn = 1 AND event_type = 'loan-originated' AND borrower IS NOT NULL
         )
    `).run();
    const repairClosed = db.prepare(`
      UPDATE inscriptions
         SET effective_owner = current_owner
       WHERE active_loan_count = 0
         AND effective_owner != current_owner
         AND loan_count > 0
    `).run();
    effectiveOwnerFixes = repairBorrower.changes + repairClosed.changes;
  }

  console.log(
    JSON.stringify(
      {
        dry_run: DRY_RUN,
        ...stats,
        active_loan_count_fixes: activeLoanCountFixes,
        effective_owner_fixes: effectiveOwnerFixes,
        failures: failures.slice(0, 10),
      },
      null,
      2
    )
  );
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
