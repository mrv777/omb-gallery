import 'server-only';

import { getDb, getStmts } from './db';
import { bitcoindConfigured, getRawTransaction } from './bitcoind';
import { detectMarketplace, extractSalePriceSats } from './marketplaceFingerprint';
import { log } from './log';

const PER_TICK_LIMIT = 200;
const RPC_CONCURRENCY = 8;

const STREAM = 'ord_net_fp';
const COLLECTION = 'omb';

type TickResult = {
  mode: 'ord-net-fp';
  scanned: number;
  matched: number;
  upgraded: number;
  rpc_failures: number;
  cursor_advanced: boolean;
  duration_ms: number;
  skipped?: 'not-configured' | 'concurrent';
  error?: string;
};

/**
 * Live ord.net sale detector. Sibling of `runMagicEdenFingerprintTick` —
 * walks `transferred` events the ord poll has just written and applies the
 * §2.11 fingerprint from ONCHAIN_TAGGING.md. On match the row is upgraded in
 * place to `sold` with `marketplace='ord-net'`.
 *
 * On first run after deploy, cursor is bootstrapped to the current
 * MAX(events.id) so we don't replay the entire backlog. The historical
 * sweep is the `scripts/backfill-ord-net-fingerprint.js` job.
 */
export async function runOrdNetFingerprintTick(opts: { live: boolean }): Promise<TickResult> {
  const startedAt = Date.now();
  const result: TickResult = {
    mode: 'ord-net-fp',
    scanned: 0,
    matched: 0,
    upgraded: 0,
    rpc_failures: 0,
    cursor_advanced: false,
    duration_ms: 0,
  };

  if (!bitcoindConfigured()) {
    return { ...result, skipped: 'not-configured', duration_ms: Date.now() - startedAt };
  }

  const db = getDb();
  const stmts = getStmts();

  const stateRow = db
    .prepare(`SELECT last_cursor FROM poll_state WHERE stream = ? AND collection_slug = ?`)
    .get(STREAM, COLLECTION) as { last_cursor: string | null } | undefined;

  let cursor: number;
  if (!stateRow) {
    log.warn('poll/ord-net-fp', 'poll_state row missing — aborting', { stream: STREAM });
    return { ...result, error: 'poll-state-row-missing', duration_ms: Date.now() - startedAt };
  }
  if (stateRow.last_cursor == null) {
    const max = db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM events`).get() as {
      m: number;
    };
    cursor = Math.max(0, max.m);
    db.prepare(
      `UPDATE poll_state
          SET last_cursor = @c, last_run_at = unixepoch(), last_status = 'bootstrapped'
        WHERE stream = @s AND collection_slug = @col`
    ).run({ c: String(cursor), s: STREAM, col: COLLECTION });
    log.warn('poll/ord-net-fp', 'cursor bootstrapped — historical sweep REQUIRED', {
      cursor,
      action: 'run scripts/backfill-ord-net-fingerprint.js once on this DB',
      docs: 'DEPLOYMENT.md → Post-deploy checklist',
    });
    return {
      ...result,
      cursor_advanced: true,
      duration_ms: Date.now() - startedAt,
    };
  }
  cursor = parseInt(stateRow.last_cursor, 10);
  if (!Number.isFinite(cursor)) cursor = 0;

  const candidates = db
    .prepare(
      `SELECT id, txid, old_owner, inscription_number
         FROM events
        WHERE id > @cursor
          AND event_type = 'transferred'
          AND marketplace IS NULL
        ORDER BY id ASC
        LIMIT @lim`
    )
    .all({ cursor, lim: PER_TICK_LIMIT }) as Array<{
    id: number;
    txid: string;
    old_owner: string | null;
    inscription_number: number;
  }>;

  if (candidates.length === 0) {
    const max = db.prepare(`SELECT COALESCE(MAX(id), @c) AS m FROM events`).get({ c: cursor }) as {
      m: number;
    };
    if (max.m > cursor) {
      db.prepare(
        `UPDATE poll_state
            SET last_cursor = @c, last_run_at = unixepoch(), last_status = 'idle'
          WHERE stream = @s AND collection_slug = @col`
      ).run({ c: String(max.m), s: STREAM, col: COLLECTION });
      result.cursor_advanced = true;
    }
    result.duration_ms = Date.now() - startedAt;
    return result;
  }

  // Bulk-buy safety net — same rationale as the ME sibling: if the rows of
  // a multi-inscription tx split across multiple ticks, null the price.
  const bulkTxids = (() => {
    if (candidates.length === 0) return new Set<string>();
    const placeholders = candidates.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT txid FROM events
          WHERE txid IN (${placeholders})
          GROUP BY txid HAVING COUNT(*) > 1`
      )
      .all(candidates.map(c => c.txid)) as Array<{ txid: string }>;
    return new Set(rows.map(r => r.txid));
  })();

  type Probe = {
    cand: (typeof candidates)[number];
    marketplace: 'ord-net' | null;
    salePriceSats: number | null;
    rpcFail: boolean;
  };
  const probes: Probe[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < candidates.length) {
      const idx = next++;
      const c = candidates[idx];
      let tx;
      try {
        tx = await getRawTransaction(c.txid);
      } catch (e) {
        probes[idx] = { cand: c, marketplace: null, salePriceSats: null, rpcFail: true };
        log.warn('poll/ord-net-fp', 'rpc failed', {
          inscription_number: c.inscription_number,
          txid: c.txid,
          error: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      const match = detectMarketplace(tx);
      if (!match || match.marketplace !== 'ord-net') {
        probes[idx] = { cand: c, marketplace: null, salePriceSats: null, rpcFail: false };
        continue;
      }
      let price = c.old_owner ? extractSalePriceSats(tx, match, c.old_owner) : null;
      if (bulkTxids.has(c.txid)) price = null;
      // Cooperative shape with no extractable seller payment: refuse to
      // tag (mirrors ME §6.5 / §7.7 — the no-payment delivery-leg case).
      // ord.net is cooperative-only, so this gate is the price floor.
      if (price == null) {
        probes[idx] = { cand: c, marketplace: null, salePriceSats: null, rpcFail: false };
        continue;
      }
      probes[idx] = {
        cand: c,
        marketplace: match.marketplace,
        salePriceSats: price,
        rpcFail: false,
      };
    }
  }
  await Promise.all(Array.from({ length: RPC_CONCURRENCY }, () => worker()));

  result.scanned = candidates.length;
  for (const p of probes) {
    if (!p) continue;
    if (p.rpcFail) {
      result.rpc_failures++;
    } else if (p.marketplace === 'ord-net') {
      result.matched++;
    }
  }

  const upgrades = probes.filter(p => p && p.marketplace === 'ord-net');
  if (upgrades.length > 0) {
    const annotateRawJson = db.prepare(
      `UPDATE events
          SET raw_json = json_set(COALESCE(raw_json, '{}'), '$.ord_net_fp', json(@meta))
        WHERE id = @id`
    );
    const apply = db.transaction(() => {
      for (const p of upgrades) {
        const meta = JSON.stringify({
          source: 'onchain-ord-net-fp',
          extracted_price_sats: p.salePriceSats,
          matched_at: Math.floor(Date.now() / 1000),
        });
        const r = stmts.upgradeEventToSoldById.run({
          id: p.cand.id,
          marketplace: 'ord-net',
          sale_price_sats: p.salePriceSats,
          raw_json: null,
        });
        if (r.changes > 0) {
          annotateRawJson.run({ id: p.cand.id, meta });
          result.upgraded++;
          stmts.unbumpTransferOnUpgrade.run({
            inscription_number: p.cand.inscription_number,
            sale_price_sats: p.salePriceSats ?? 0,
          });
          if (opts.live) stmts.enqueueNotify.run(p.cand.id);
        }
      }
    });
    apply();
  }

  // Advance cursor only past the contiguous prefix of successfully probed
  // rows. See magisatFingerprintTick.ts for the rationale.
  const firstFailIdx = probes.findIndex(p => p && p.rpcFail);
  const advanceToIdx = firstFailIdx === -1 ? candidates.length - 1 : firstFailIdx - 1;
  if (advanceToIdx >= 0) {
    const c = candidates[advanceToIdx].id;
    db.prepare(
      `UPDATE poll_state
          SET last_cursor       = @c,
              last_run_at       = unixepoch(),
              last_status       = @status,
              last_event_count  = @upgraded
        WHERE stream = @s AND collection_slug = @col`
    ).run({
      c: String(c),
      status: result.upgraded > 0 ? 'upgrades' : 'idle',
      upgraded: result.upgraded,
      s: STREAM,
      col: COLLECTION,
    });
    result.cursor_advanced = true;
  } else {
    db.prepare(
      `UPDATE poll_state
          SET last_run_at      = unixepoch(),
              last_status      = 'rpc-fail-hold'
        WHERE stream = @s AND collection_slug = @col`
    ).run({ s: STREAM, col: COLLECTION });
  }
  const newCursor = advanceToIdx >= 0 ? candidates[advanceToIdx].id : cursor;
  result.duration_ms = Date.now() - startedAt;

  if (result.upgraded > 0 || result.rpc_failures > 0) {
    log.info('poll/ord-net-fp', 'tick complete', {
      scanned: result.scanned,
      matched: result.matched,
      upgraded: result.upgraded,
      rpc_failures: result.rpc_failures,
      cursor: newCursor,
      duration_ms: result.duration_ms,
    });
  }
  return result;
}
