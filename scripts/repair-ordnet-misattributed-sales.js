#!/usr/bin/env node
/* eslint-disable */
// Repair / re-attribute / delete spurious SOLD rows that
// `scripts/backfill-ordnet-sales.js` inserted from ord.net's __data.json feed
// when ord.net mis-attributed a sale's `inscriptionId`.
//
// Trigger row shape:
//   event_type='sold' AND json_extract(raw_json,'$.source')='ord-net-history-backfill'
//   AND block_height IS NULL
// (the standalone-insert branch always leaves block_height NULL, so this
// uniquely identifies rows that bypassed any chain check at insert time.)
//
// Per inscription with at least one suspect row:
//   1. Fetch ord's current satpoint for the inscription, then walk backward
//      via bitcoin-cli (verbosity=2, ord's first-input-first-sat rule) to
//      build the canonical set of txids that ever moved this inscription.
//      ord's /output endpoint reports `indexed: false` on spent UTXOs and
//      can't tell us "what was at this output", so we have to walk the sat
//      ourselves.
//   2. For each suspect row:
//      - 'match'       : row.txid is in the inscription's chain → real sale.
//                        Enrich the row in-place with chain-truth
//                        block_height + owners (from the matching hop).
//      - 'reattribute' : row.txid is NOT in this inscription's chain, but
//                        another suspect row's inscription chain DOES contain
//                        it (rare cross-row match). Rewrite + fix aggregates.
//      - 'delete'      : row.txid is not in any walked chain. Delete the row,
//                        decrement aggregates on the wrongly-tagged insc.
//      - 'unresolved'  : couldn't walk this inscription (e.g. genesis lookup
//                        failed). Skip and log.
//
// Required env (same as backfill-transfers.js):
//   BITCOIN_RPC_URL    e.g. http://user:pass@127.0.0.1:8332
//   ORD_BASE_URL       e.g. http://127.0.0.1:4000
// Optional env:
//   OMB_DB_PATH        default ./tmp/dev.db
//   REPAIR_LIMIT       debug: only process N rows
//   REPAIR_CONCURRENCY default 4 (chain lookups in flight)
//
// CLI flags:
//   --apply            actually write. Default is dry-run (read-only).
//   --only-event=<id>  process only events.id = <id> (debug).
//   --verbose          per-row decisions to stdout.

const path = require('node:path');
const Database = require('better-sqlite3');
const {
  RPC_URL,
  ORD_BASE,
  rpc,
  getHeader,
  fetchOrdInscription,
  walkInscription,
} = require('./lib/chain');

const DB_PATH = process.env.OMB_DB_PATH ?? path.resolve(__dirname, '..', 'tmp', 'dev.db');
const LIMIT = process.env.REPAIR_LIMIT ? parseInt(process.env.REPAIR_LIMIT, 10) : null;
const CONCURRENCY = parseInt(process.env.REPAIR_CONCURRENCY ?? '4', 10);

const ARGS = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = { apply: false, onlyEvent: null, verbose: false };
  for (const a of argv) {
    if (a === '--apply') out.apply = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a.startsWith('--only-event=')) out.onlyEvent = parseInt(a.slice(13), 10);
    else {
      console.error(`[repair] unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

if (!RPC_URL) {
  console.error('[repair] BITCOIN_RPC_URL is required');
  process.exit(1);
}
if (!ORD_BASE) {
  console.error('[repair] ORD_BASE_URL is required');
  process.exit(1);
}

// ---------------- main ----------------

async function main() {
  const db = new Database(DB_PATH, { readonly: !ARGS.apply });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  // Sanity: bitcoind + ord reachable.
  try {
    const info = await rpc('getblockchaininfo', []);
    console.log(`[repair] bitcoind ok: blocks=${info.blocks} chain=${info.chain}`);
  } catch (e) {
    console.error('[repair] bitcoind RPC failed:', e.message);
    process.exit(1);
  }

  // Build target list once. The window is bounded (~868 rows in prod) so we
  // can hold all candidates in memory and process with a small worker pool.
  const where = [
    "event_type = 'sold'",
    "json_extract(raw_json,'$.source') = 'ord-net-history-backfill'",
    'block_height IS NULL',
  ];
  const params = {};
  if (ARGS.onlyEvent != null) {
    where.push('id = @only');
    params.only = ARGS.onlyEvent;
  }
  let sql = `
    SELECT id, inscription_id, inscription_number, txid, old_owner, new_owner,
           sale_price_sats, block_timestamp, raw_json
      FROM events
     WHERE ${where.join(' AND ')}
     ORDER BY id
  `;
  if (LIMIT) sql += ` LIMIT ${LIMIT}`;
  const rows = db.prepare(sql).all(params);

  // Build the OMB inscription_id → inscription_number map once.
  const ombMap = new Map();
  for (const r of db.prepare('SELECT inscription_number, inscription_id FROM inscriptions WHERE inscription_id IS NOT NULL').iterate()) {
    ombMap.set(r.inscription_id, r.inscription_number);
  }

  console.log(
    `[repair] db=${DB_PATH} apply=${ARGS.apply} candidates=${rows.length} omb_known=${ombMap.size}`
  );

  // Prepared statements for the apply path. Skip prepare in dry-run since DB
  // is read-only there.
  const stmts = ARGS.apply ? prepareStmts(db) : null;

  const buckets = {
    match: [],
    reattribute: [],
    delete: [],
    ambiguous: [],
    unresolved: [],
  };

  // Walk each unique affected inscription ONCE, then index every suspect row.
  // The walk is the expensive step; per-row decisions are then a Map lookup.
  const uniqueInsc = new Map(); // inscription_id -> { inscription_number, rows: [], chain?: { hopsByTxid: Map } }
  for (const r of rows) {
    if (!uniqueInsc.has(r.inscription_id)) {
      uniqueInsc.set(r.inscription_id, {
        inscription_number: r.inscription_number,
        rows: [],
      });
    }
    uniqueInsc.get(r.inscription_id).rows.push(r);
  }
  console.log(`[repair] walking ${uniqueInsc.size} unique inscription chain(s)…`);

  const inscArr = [...uniqueInsc.entries()];
  let walkNext = 0;
  let walked = 0;
  const startedAt = Date.now();

  async function walkWorker() {
    while (walkNext < inscArr.length) {
      const i = walkNext++;
      const [inscription_id, info] = inscArr[i];
      info.chain = await walkInscriptionChain(inscription_id);
      walked++;
      if (walked % 25 === 0) {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`[repair] walked ${walked}/${inscArr.length} (${elapsed}s)`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, walkWorker));

  // Surface walk termination reasons. 'reached-genesis' / 'coinbase' are
  // expected (the walker hit either the inscription's genesis or the sat's
  // pre-inscription origin). 'max-hops' would indicate we under-budgeted and
  // the chain is longer than 500 hops — none observed for OMB so far, but
  // worth knowing if it ever surfaces.
  const walkReasons = Object.create(null);
  for (const [, info] of uniqueInsc) {
    const r = info.chain?.error ? `error:${info.chain.error.slice(0, 30)}` : (info.chain?.reason ?? 'unknown');
    walkReasons[r] = (walkReasons[r] ?? 0) + 1;
  }
  console.log(`[repair] walk reasons: ${Object.entries(walkReasons).map(([k, v]) => `${k}=${v}`).join(' ')}`);

  // Build a global txid → { inscription_id, hop } index across all walked
  // chains. Used to detect cross-inscription re-attribution candidates.
  const globalChainHits = new Map(); // txid -> [{ inscription_id, hop }]
  for (const [inscription_id, info] of uniqueInsc) {
    if (!info.chain || !info.chain.hopsByTxid) continue;
    for (const [txid, hop] of info.chain.hopsByTxid) {
      if (!globalChainHits.has(txid)) globalChainHits.set(txid, []);
      globalChainHits.get(txid).push({ inscription_id, hop });
    }
  }

  const decisions = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const info = uniqueInsc.get(r.inscription_id);
    if (!info.chain || info.chain.error) {
      decisions[i] = { bucket: 'unresolved', reason: info.chain?.error ?? 'no chain' };
      continue;
    }
    const ownHit = info.chain.hopsByTxid.get(r.txid);
    if (ownHit) {
      decisions[i] = {
        bucket: 'match',
        reason: `txid in own chain (hop ${ownHit.hopIdx})`,
        block_height: ownHit.block_height ?? null,
        block_timestamp: ownHit.blocktime ?? null,
        old_owner: ownHit.prevAddr ?? null,
        new_owner: ownHit.newAddr ?? null,
      };
      continue;
    }
    // Cross-inscription match (other OMB chain contains this txid).
    const cross = globalChainHits.get(r.txid);
    const crossOmb = cross
      ? cross.filter(c => c.inscription_id !== r.inscription_id)
      : [];
    if (crossOmb.length === 1) {
      const c = crossOmb[0];
      decisions[i] = {
        bucket: 'reattribute',
        reason: `txid found in chain of #${ombMap.get(c.inscription_id)}`,
        inscription_id: c.inscription_id,
        inscription_number: ombMap.get(c.inscription_id),
        block_height: c.hop.block_height ?? null,
        block_timestamp: c.hop.blocktime ?? null,
        old_owner: c.hop.prevAddr ?? null,
        new_owner: c.hop.newAddr ?? null,
      };
      continue;
    }
    if (crossOmb.length > 1) {
      decisions[i] = {
        bucket: 'ambiguous',
        reason: `txid in chains of ${crossOmb.length} other OMBs`,
      };
      continue;
    }
    decisions[i] = {
      bucket: 'delete',
      reason: 'txid not in any walked OMB chain',
    };
  }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const d = decisions[i];
    buckets[d.bucket].push({ row: r, decision: d });
    if (ARGS.verbose) {
      console.log(
        `[repair] event#${r.id} insc=#${r.inscription_number} txid=${r.txid.slice(0, 16)}… → ${d.bucket}` +
          (d.reason ? ` (${d.reason})` : '')
      );
    }
  }

  console.log(
    `\n[repair] BUCKETS  match=${buckets.match.length}  reattribute=${buckets.reattribute.length}  delete=${buckets.delete.length}  ambiguous=${buckets.ambiguous.length}  unresolved=${buckets.unresolved.length}\n`
  );

  // Always print ambiguous + unresolved so they're visible without --verbose.
  for (const { row, decision } of buckets.ambiguous) {
    console.log(`[repair] AMBIGUOUS event#${row.id} insc=#${row.inscription_number} txid=${row.txid} :: ${decision.reason}`);
  }
  for (const { row, decision } of buckets.unresolved) {
    console.log(`[repair] UNRESOLVED event#${row.id} insc=#${row.inscription_number} txid=${row.txid} :: ${decision.reason}`);
  }

  if (!ARGS.apply) {
    console.log('\n[repair] dry-run — pass --apply to write changes.');
    db.close();
    return;
  }

  // Apply phase: per-row mutations wrapped in BEGIN IMMEDIATE so each row's
  // event-update + aggregate-fix is atomic against the live diff-poll cron.
  let writes = { matchEnriched: 0, reattributed: 0, deleted: 0, errors: 0 };
  for (const { row, decision } of buckets.match) {
    try {
      const apply = db.transaction(() => applyMatch(stmts, row, decision));
      apply.immediate();
      writes.matchEnriched++;
    } catch (e) {
      writes.errors++;
      console.error(`[repair] match-apply failed event#${row.id}: ${e.message}`);
    }
  }
  for (const { row, decision } of buckets.reattribute) {
    try {
      const apply = db.transaction(() => applyReattribute(stmts, row, decision, ombMap));
      apply.immediate();
      writes.reattributed++;
    } catch (e) {
      writes.errors++;
      console.error(`[repair] reattribute-apply failed event#${row.id}: ${e.message}`);
    }
  }
  for (const { row, decision } of buckets.delete) {
    try {
      const apply = db.transaction(() => applyDelete(stmts, row, decision));
      apply.immediate();
      writes.deleted++;
    } catch (e) {
      writes.errors++;
      console.error(`[repair] delete-apply failed event#${row.id}: ${e.message}`);
    }
  }

  console.log(
    `[repair] WRITES  matchEnriched=${writes.matchEnriched}  reattributed=${writes.reattributed}  deleted=${writes.deleted}  errors=${writes.errors}`
  );
  db.close();
}

// ---------------- chain walk per inscription ----------------
//
// Returns { hopsByTxid: Map<txid, hop>, reason } or { error: string }.
async function walkInscriptionChain(inscription_id) {
  const insc = await fetchOrdInscription(inscription_id);
  if (!insc || !insc.satpoint) {
    return { error: `ord has no satpoint for ${inscription_id}` };
  }
  const { events, reason } = await walkInscription({
    inscription_id,
    satpoint: insc.satpoint,
    maxHops: 500,
  });
  // Resolve block heights for hops that had a blockhash. Header cache makes
  // repeated lookups cheap.
  const hopsByTxid = new Map();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    let block_height = null;
    if (e.blockhash) {
      try {
        const h = await getHeader(e.blockhash);
        block_height = h.height;
      } catch {
        /* leave null */
      }
    }
    hopsByTxid.set(e.txid, {
      hopIdx: i,
      prevAddr: e.prevAddr,
      newAddr: e.newAddr,
      blocktime: e.blocktime,
      block_height,
    });
  }
  return { hopsByTxid, reason };
}

// ---------------- apply: SQL ----------------

function prepareStmts(db) {
  return {
    // MATCH: just enrich the existing row. Don't bump aggregates (already
    // counted at original insert time).
    enrichMatch: db.prepare(`
      UPDATE events
         SET block_height    = COALESCE(@block_height, block_height),
             block_timestamp = COALESCE(@block_timestamp, block_timestamp),
             old_owner       = COALESCE(@old_owner, old_owner),
             new_owner       = COALESCE(@new_owner, new_owner),
             raw_json        = json_set(COALESCE(raw_json,'{}'),'$.repaired','enriched-from-chain')
       WHERE id = @id
    `),

    // REATTRIBUTE: rewrite inscription_id / inscription_number on the row.
    // The UNIQUE(inscription_id, txid) constraint means a re-run could collide
    // if the destination inscription already has a row at this txid — that
    // shouldn't happen here (the destination inscription was *missing* the
    // event entirely, that's why ord.net ended up with the wrong attribution),
    // but we use ON CONFLICT-style guard via a pre-check below.
    reattributeUpdate: db.prepare(`
      UPDATE events
         SET inscription_id     = @new_inscription_id,
             inscription_number = @new_inscription_number,
             block_height       = COALESCE(@block_height, block_height),
             block_timestamp    = COALESCE(@block_timestamp, block_timestamp),
             old_owner          = COALESCE(@old_owner, old_owner),
             new_owner          = COALESCE(@new_owner, new_owner),
             raw_json           = json_set(
                                    COALESCE(raw_json,'{}'),
                                    '$.repaired', 'reattributed-from-ordnet-misattribution',
                                    '$.original_inscription_id', @orig_inscription_id,
                                    '$.original_inscription_number', @orig_inscription_number
                                  )
       WHERE id = @id
    `),

    findExistingAtDest: db.prepare(`
      SELECT id FROM events WHERE inscription_id = @inscription_id AND txid = @txid
    `),

    // Decrement aggregates on the wrongly-tagged inscription. Same shape used
    // by both REATTRIBUTE (move counters off this insc) and DELETE.
    decrementSale: db.prepare(`
      UPDATE inscriptions
         SET sale_count        = MAX(sale_count - 1, 0),
             total_volume_sats = MAX(total_volume_sats - COALESCE(@sale_price_sats, 0), 0)
       WHERE inscription_number = @inscription_number
    `),
    // Increment aggregates on the right inscription (REATTRIBUTE only).
    incrementSale: db.prepare(`
      UPDATE inscriptions
         SET sale_count        = sale_count + 1,
             total_volume_sats = total_volume_sats + COALESCE(@sale_price_sats, 0)
       WHERE inscription_number = @inscription_number
    `),
    // Recompute highest_sale_sats from scratch (cleaner than tracking deltas).
    recomputeHighestSale: db.prepare(`
      UPDATE inscriptions
         SET highest_sale_sats = COALESCE((
               SELECT MAX(sale_price_sats) FROM events
                WHERE inscription_number = @inscription_number AND event_type = 'sold'
             ), 0)
       WHERE inscription_number = @inscription_number
    `),

    // DELETE: remove the row entirely.
    deleteEvent: db.prepare(`DELETE FROM events WHERE id = @id`),
  };
}

function applyMatch(stmts, row, d) {
  stmts.enrichMatch.run({
    id: row.id,
    block_height: d.block_height,
    block_timestamp: d.block_timestamp,
    old_owner: d.old_owner,
    new_owner: d.new_owner,
  });
}

function applyReattribute(stmts, row, d, ombMap) {
  // Guard: if the destination inscription already has a row at this txid,
  // we'd violate UNIQUE(inscription_id, txid). Treat as a delete instead so
  // we don't create a phantom and we still drop the misattributed row.
  const collision = stmts.findExistingAtDest.get({
    inscription_id: d.inscription_id,
    txid: row.txid,
  });
  if (collision) {
    // Drop this row outright; the destination inscription already has a
    // canonical event at this txid (likely from ord-history-backfill or a
    // live ord tick).
    applyDelete(stmts, row, { reason: `collision with existing event#${collision.id} at destination` });
    return;
  }
  stmts.reattributeUpdate.run({
    id: row.id,
    new_inscription_id: d.inscription_id,
    new_inscription_number: d.inscription_number,
    block_height: d.block_height,
    block_timestamp: d.block_timestamp,
    old_owner: d.old_owner,
    new_owner: d.new_owner,
    orig_inscription_id: row.inscription_id,
    orig_inscription_number: row.inscription_number,
  });
  // Move sale counters off the wrong inscription, onto the right one.
  stmts.decrementSale.run({
    inscription_number: row.inscription_number,
    sale_price_sats: row.sale_price_sats,
  });
  stmts.incrementSale.run({
    inscription_number: d.inscription_number,
    sale_price_sats: row.sale_price_sats,
  });
  stmts.recomputeHighestSale.run({ inscription_number: row.inscription_number });
  stmts.recomputeHighestSale.run({ inscription_number: d.inscription_number });
}

function applyDelete(stmts, row, _d) {
  stmts.deleteEvent.run({ id: row.id });
  stmts.decrementSale.run({
    inscription_number: row.inscription_number,
    sale_price_sats: row.sale_price_sats,
  });
  stmts.recomputeHighestSale.run({ inscription_number: row.inscription_number });
}

// ---------------- entry ----------------

main().catch(e => {
  console.error('[repair] fatal:', e);
  process.exit(1);
});
