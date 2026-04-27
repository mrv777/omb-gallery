import { NextRequest, NextResponse } from 'next/server';
import { getDb, getStmts, walCheckpoint, type PollStateRow } from '@/lib/db';
import {
  fetchBlockHeight,
  fetchBlockTimestamp,
  fetchInscriptionDetail,
  fetchInscriptionsBatch,
  fetchOutputConfirmations,
  txidFromOutput,
  OrdError,
  type OrdInscriptionState,
} from '@/lib/ord';
import {
  fetchSalesPage,
  SatflowError,
  type NormalizedSale,
} from '@/lib/satflow';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SATFLOW_COLLECTION_ID = process.env.SATFLOW_OMB_COLLECTION_ID ?? 'omb';

const ORD_BATCH_SIZE = 500;
const ORD_BOOTSTRAP_MAX_PER_TICK = 300;
const ORD_BOOTSTRAP_CONCURRENCY = 5;
const ORD_BOOTSTRAP_WAVE_DELAY_MS = 25;

// Per-tick concurrency for /output + /r/blockinfo enrichment lookups.
// Each detected transfer needs 2 sequential ord calls; wider parallelism
// drains the work fast but risks overloading ord on a catch-up burst.
const ORD_ENRICHMENT_CONCURRENCY = 8;

const SATFLOW_PAGE_SIZE = 100;
const SATFLOW_INCREMENTAL_MAX_PAGES = 3;
const SATFLOW_BACKFILL_MAX_PAGES_PER_TICK = 8;
const SATFLOW_BACKFILL_POLITENESS_MS = 500;

// Wallclock cap per tick. Bumped from 25s to 60s to absorb enrichment
// (2 extra ord calls per detected transfer). The acquireLock window in
// db.ts MUST stay ≥ this + safety margin or two ticks can run concurrently.
const TICK_WALLCLOCK_BUDGET_MS = 60_000;

// If ord reports a tip more than this many blocks below the highest we've
// previously seen, treat it as stale (re-indexing, cached reverse-proxy
// response, etc.) and refuse to write. 6 covers any practical reorg depth.
const ORD_REGRESSION_TOLERANCE = 6;

type TickResult = {
  mode: string;
  skipped?: 'concurrent' | 'budget' | 'not-configured';
  error?: string;
  done?: boolean;
} & Record<string, unknown>;

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization');
  const expected = process.env.INTERNAL_POLL_SECRET;
  if (!expected) {
    return json({ error: 'INTERNAL_POLL_SECRET not configured' }, 500);
  }
  if (auth !== `Bearer ${expected}`) {
    return json({ error: 'unauthorized' }, 401);
  }

  const url = new URL(req.url);
  const mode = url.searchParams.get('mode') ?? 'auto';

  try {
    let result: TickResult | TickResult[];
    switch (mode) {
      case 'init-backfill':
        result = initBackfill();
        break;
      case 'ord':
        result = await runOrdTick();
        break;
      case 'satflow':
        result = await runSatflowTick({});
        break;
      case 'satflow-backfill':
        result = await runSatflowTick({ force: 'backfill' });
        break;
      case 'auto':
      default: {
        const ord = await runOrdTick();
        const satflow = await runSatflowTick({});
        result = [ord, satflow];
        break;
      }
    }
    walCheckpoint();
    return json(result, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
}

// ---------------- mode: init-backfill ----------------

function initBackfill(): TickResult {
  const db = getDb();
  db.prepare(`UPDATE poll_state SET last_cursor = NULL, is_backfilling = 1 WHERE stream = 'satflow'`).run();
  return { mode: 'init-backfill', done: true };
}

// ---------------- mode: ord ----------------

async function runOrdTick(): Promise<TickResult> {
  if (!process.env.ORD_BASE_URL) {
    return { mode: 'ord', skipped: 'not-configured' };
  }

  const stmts = getStmts();
  const lockRes = stmts.acquireLock.run('ord');
  if (lockRes.changes === 0) {
    return { mode: 'ord', skipped: 'concurrent' };
  }

  const startedAt = Date.now();
  let bootstrapped = 0;
  let checked = 0;
  let changed = 0;
  let inserted = 0;
  let initialized = 0;
  let blockHeight: number | null = null;
  let errMsg: string | null = null;

  try {
    blockHeight = await fetchBlockHeight();
  } catch (err) {
    errMsg = errorMessage(err);
    setOrdResult(errMsg, 0);
    return { mode: 'ord', error: errMsg };
  }

  // Stale-index guard: if ord's reported tip has dropped meaningfully below
  // the highest height we've successfully ingested, ord is likely re-indexing
  // or a cached response is being served. Recording inscription state from a
  // stale view would emit phantom "transferred" events with stale satpoints —
  // and when ord catches up, those phantoms would compound with the real
  // transfers it then surfaces. Skip the entire tick (including bootstrap,
  // which also writes current_output) until ord recovers.
  const priorState = stmts.getPollState.get('ord') as PollStateRow | undefined;
  const priorHeight = priorState?.last_known_height ?? null;
  if (priorHeight != null && blockHeight < priorHeight - ORD_REGRESSION_TOLERANCE) {
    const reason = `ord index behind chain tip: at ${blockHeight}, was at ${priorHeight}`;
    setOrdResult(reason, 0);
    return {
      mode: 'ord',
      stale: true,
      blockHeight,
      lastKnownHeight: priorHeight,
      error: reason,
    };
  }
  const newKnownHeight =
    priorHeight != null ? Math.max(priorHeight, blockHeight) : blockHeight;

  // Bootstrap inscription_ids for any rows that only have a number (seeded from images.json).
  // Capped per tick to avoid blowing the wallclock on first run.
  try {
    bootstrapped = await bootstrapInscriptionIds();
  } catch (err) {
    errMsg = errorMessage(err);
    setOrdResult(errMsg, 0);
    return { mode: 'ord', error: errMsg, bootstrapped, blockHeight };
  }

  // Batch-poll current state for every inscription that has an ID.
  const rows = stmts.listInscriptionsForPoll.all([]) as Array<{
    inscription_number: number;
    inscription_id: string | null;
    current_output: string | null;
    current_owner: string | null;
  }>;
  const indexed = new Map<
    string,
    { inscription_number: number; current_output: string | null; current_owner: string | null }
  >();
  const idsToQuery: string[] = [];
  for (const r of rows) {
    if (!r.inscription_id) continue;
    indexed.set(r.inscription_id, {
      inscription_number: r.inscription_number,
      current_output: r.current_output,
      current_owner: r.current_owner,
    });
    idsToQuery.push(r.inscription_id);
  }

  for (let offset = 0; offset < idsToQuery.length; offset += ORD_BATCH_SIZE) {
    if (Date.now() - startedAt > TICK_WALLCLOCK_BUDGET_MS) break;
    const chunk = idsToQuery.slice(offset, offset + ORD_BATCH_SIZE);

    let states: OrdInscriptionState[];
    try {
      states = await fetchInscriptionsBatch(chunk);
    } catch (err) {
      errMsg = errorMessage(err);
      // Don't mark polled — fetch failed, retry next tick.
      break;
    }

    checked += states.length;

    // Identify transfer satpoints (output changed since last poll) so we
    // can enrich them with real on-chain block_height/block_timestamp
    // before writing events. ord's batch endpoint only ships the *current*
    // satpoint, not when the move happened; without enrichment every
    // event would carry the poll-time as its timestamp.
    const transferSatpoints = collectTransferSatpoints(states, indexed);
    const enrichmentMap = await enrichTransfers(transferSatpoints, blockHeight);

    const tickResult = applyOrdStates(states, indexed, blockHeight, enrichmentMap);
    changed += tickResult.changed;
    inserted += tickResult.inserted;
    initialized += tickResult.initialized;
    // Mark every ID we asked about — including ones ord didn't return —
    // so the round-robin order in listInscriptionsForPoll advances. A
    // consistently-missing ID would otherwise pin itself to the front
    // of the queue and starve the rest.
    markChunkPolled(chunk);
  }

  setOrdResult(errMsg ? errMsg.slice(0, 500) : 'ok', inserted);
  // Persist the high-water mark only when this tick wasn't entirely an error
  // (i.e. we actually observed ord state). On pure failure, leave priorHeight
  // intact so the next tick's stale check still has a reference point.
  if (checked > 0 || initialized > 0 || changed > 0 || !errMsg) {
    stmts.setKnownHeight.run({ stream: 'ord', height: newKnownHeight });
  }

  return {
    mode: 'ord',
    blockHeight,
    lastKnownHeight: newKnownHeight,
    bootstrapped,
    checked,
    changed,
    inserted,
    initialized,
    ...(errMsg ? { error: errMsg } : {}),
  };
}

async function bootstrapInscriptionIds(): Promise<number> {
  const stmts = getStmts();
  const missing = stmts.listInscriptionsMissingId.all({
    limit: ORD_BOOTSTRAP_MAX_PER_TICK,
  }) as Array<{ inscription_number: number }>;
  if (missing.length === 0) return 0;

  let bootstrapped = 0;
  const startedAt = Date.now();
  // Bootstrap in waves of N concurrent fetches: ord can serve them in
  // parallel, so this gives ~Nx the throughput of the previous sequential
  // loop without piling up requests faster than ord can keep up. Each
  // wave only commits the inscriptions it finished — partial-wave failures
  // (504, 429) just drop into the next tick.
  for (let i = 0; i < missing.length; i += ORD_BOOTSTRAP_CONCURRENCY) {
    if (Date.now() - startedAt > TICK_WALLCLOCK_BUDGET_MS / 2) break;
    const wave = missing.slice(i, i + ORD_BOOTSTRAP_CONCURRENCY);
    const results = await Promise.allSettled(
      wave.map((row) => fetchInscriptionDetail(row.inscription_number))
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      const row = wave[j];
      if (r.status === 'rejected') {
        // 404 is expected for inscriptions ord doesn't know about yet
        // (very-recent mints, or mints past ord's current sync height).
        // Anything else is a real error — surface it.
        if (r.reason instanceof OrdError && r.reason.status === 404) continue;
        throw r.reason;
      }
      const detail = r.value;
      if (!detail.inscription_id) continue;
      // Populate current_output + current_owner from the same call so the
      // first ?mode=ord tick after bootstrap doesn't risk missing a real
      // transfer via the initial-sync no-event guard in applyOrdStates.
      stmts.setInscriptionState.run({
        inscription_number: row.inscription_number,
        inscription_id: detail.inscription_id,
        current_output: detail.output,
        current_owner: detail.address,
      });
      // Populate inscribe_at from genesis timestamp if ord ships it. Without
      // this, inscriptions that have never moved have NULL inscribe_at and
      // detail pages can't compute "held since mint".
      if (detail.block_timestamp != null) {
        stmts.setInscriptionInscribeAt.run({
          inscription_number: row.inscription_number,
          inscribe_at: detail.block_timestamp,
        });
      }
      bootstrapped++;
    }
    await sleep(ORD_BOOTSTRAP_WAVE_DELAY_MS);
  }
  return bootstrapped;
}

type EnrichmentMap = Map<string, { block_height: number; block_timestamp: number }>;

function applyOrdStates(
  states: OrdInscriptionState[],
  indexed: Map<
    string,
    { inscription_number: number; current_output: string | null; current_owner: string | null }
  >,
  blockHeight: number | null,
  enrichmentMap: EnrichmentMap
): { changed: number; inserted: number; initialized: number } {
  if (states.length === 0) return { changed: 0, inserted: 0, initialized: 0 };
  const stmts = getStmts();
  const db = getDb();
  let changed = 0;
  let inserted = 0;
  let initialized = 0;
  const nowTs = Math.floor(Date.now() / 1000);

  const tx = db.transaction(() => {
    for (const s of states) {
      const known = indexed.get(s.inscription_id);
      if (!known) continue;

      const newOutput = s.output;
      const oldOutput = known.current_output;

      if (newOutput == null) continue;

      if (oldOutput == null) {
        // Initial sync: just record state, do NOT emit a transferred event.
        stmts.setInscriptionState.run({
          inscription_number: known.inscription_number,
          inscription_id: s.inscription_id,
          current_output: newOutput,
          current_owner: s.address,
        });
        initialized++;
        continue;
      }

      if (oldOutput === newOutput) continue;

      // Output changed → transfer happened.
      const txid = txidFromOutput(newOutput);
      if (!txid) {
        // Malformed output from ord — don't pollute events.txid with junk.
        // Still update current_output so we don't keep tripping on the same
        // value next tick.
        stmts.setInscriptionState.run({
          inscription_number: known.inscription_number,
          inscription_id: s.inscription_id,
          current_output: newOutput,
          current_owner: s.address,
        });
        continue;
      }
      changed++;
      // Prefer real on-chain block_height/timestamp from enrichment; fall
      // back to chain-tip + now-time only if enrichment failed (ord 404,
      // mempool tx with confirmations=0, network blip). Fallback events
      // can be detected via block_height === blockHeight and re-enriched
      // by a future ?mode=enrich pass if we ever add one.
      const enriched = enrichmentMap.get(newOutput);
      const ev = {
        inscription_id: s.inscription_id,
        inscription_number: known.inscription_number,
        event_type: 'transferred' as const,
        block_height: enriched?.block_height ?? blockHeight,
        block_timestamp: enriched?.block_timestamp ?? nowTs,
        new_satpoint: newOutput,
        old_owner: known.current_owner,
        new_owner: s.address,
        marketplace: null,
        sale_price_sats: null,
        txid,
        raw_json: JSON.stringify({
          source: 'ord',
          state: s,
          enriched: enriched ? true : false,
        }),
      };

      stmts.upsertInscriptionFromEvent.run({
        inscription_number: ev.inscription_number,
        inscription_id: ev.inscription_id,
        inscribe_at: null,
        block_timestamp: ev.block_timestamp,
      });

      const r = stmts.insertEvent.run(ev);
      if (r.changes > 0) {
        inserted++;
        stmts.bumpInscriptionAggregates.run({
          inscription_number: ev.inscription_number,
          event_type: ev.event_type,
          sale_price_sats: ev.sale_price_sats,
          block_timestamp: ev.block_timestamp,
        });
      }
      // Always update current state, even if event already existed (e.g. satflow
      // already inserted a 'sold' for this txid — we still need to track location).
      stmts.setInscriptionState.run({
        inscription_number: known.inscription_number,
        inscription_id: s.inscription_id,
        current_output: newOutput,
        current_owner: s.address,
      });
      indexed.set(s.inscription_id, {
        inscription_number: known.inscription_number,
        current_output: newOutput,
        current_owner: s.address,
      });
    }
  });
  tx();

  return { changed, inserted, initialized };
}

/**
 * Sync pre-pass: identify which `(state, indexed)` pairs represent a real
 * transfer that needs enrichment. Mirrors the diff logic in applyOrdStates
 * but writes nothing — we only need a list of satpoints to look up.
 */
function collectTransferSatpoints(
  states: OrdInscriptionState[],
  indexed: Map<
    string,
    { inscription_number: number; current_output: string | null; current_owner: string | null }
  >
): string[] {
  const out: string[] = [];
  for (const s of states) {
    const known = indexed.get(s.inscription_id);
    if (!known) continue;
    if (s.output == null) continue;
    if (known.current_output == null) continue; // initial sync, no event
    if (known.current_output === s.output) continue;
    if (!txidFromOutput(s.output)) continue;
    out.push(s.output);
  }
  return out;
}

/**
 * For each detected transfer satpoint, derive the on-chain block_height
 * (from `confirmations` on /output) and block_timestamp (from /r/blockinfo).
 * Two ord calls per unique satpoint; runs in parallel waves of N to keep
 * burst latency bounded without overloading ord.
 *
 * Failures (404, malformed, timeout, mempool tx with confirmations=0) are
 * silently dropped — the caller falls back to chain-tip + now-time so we
 * still emit the transfer event, just with imprecise time.
 */
async function enrichTransfers(
  satpoints: string[],
  ordTip: number | null
): Promise<EnrichmentMap> {
  const map: EnrichmentMap = new Map();
  if (satpoints.length === 0 || ordTip == null) return map;
  const unique = Array.from(new Set(satpoints));

  // Step 1: parallel /output lookups → confirmations → block_height
  const heights = new Map<string, number>();
  for (let i = 0; i < unique.length; i += ORD_ENRICHMENT_CONCURRENCY) {
    const wave = unique.slice(i, i + ORD_ENRICHMENT_CONCURRENCY);
    const results = await Promise.allSettled(
      wave.map((sp) => fetchOutputConfirmations(sp))
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status !== 'fulfilled' || r.value == null || r.value < 1) continue;
      const height = ordTip - r.value + 1;
      if (height < 1) continue;
      heights.set(wave[j], height);
    }
  }

  // Step 2: parallel /r/blockinfo lookups, deduped by height
  const uniqueHeights = Array.from(new Set(heights.values()));
  const heightToTs = new Map<number, number>();
  for (let i = 0; i < uniqueHeights.length; i += ORD_ENRICHMENT_CONCURRENCY) {
    const wave = uniqueHeights.slice(i, i + ORD_ENRICHMENT_CONCURRENCY);
    const results = await Promise.allSettled(wave.map((h) => fetchBlockTimestamp(h)));
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status !== 'fulfilled' || r.value == null) continue;
      heightToTs.set(wave[j], r.value);
    }
  }

  // Step 3: stitch them
  heights.forEach((height, sp) => {
    const ts = heightToTs.get(height);
    if (ts != null) map.set(sp, { block_height: height, block_timestamp: ts });
  });
  return map;
}

function markChunkPolled(ids: string[]): void {
  if (ids.length === 0) return;
  const stmts = getStmts();
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const tx = db.transaction(() => {
    for (const id of ids) {
      stmts.markInscriptionPolled.run({ now, inscription_id: id });
    }
  });
  tx();
}

function setOrdResult(status: string, eventCount: number): void {
  getStmts().setPollResult.run({
    stream: 'ord',
    status,
    event_count: eventCount,
    cursor: null,
  });
}

// ---------------- mode: satflow ----------------

async function runSatflowTick(opts: { force?: 'incremental' | 'backfill' }): Promise<TickResult> {
  const apiKey = process.env.SATFLOW_API_KEY ?? null;
  if (!process.env.SATFLOW_OMB_COLLECTION_ID) {
    return { mode: 'satflow', skipped: 'not-configured' };
  }

  const stmts = getStmts();
  const lockRes = stmts.acquireLock.run('satflow');
  if (lockRes.changes === 0) {
    return { mode: 'satflow', skipped: 'concurrent' };
  }

  const state = stmts.getPollState.get('satflow') as PollStateRow;
  const backfilling =
    opts.force === 'backfill' || (opts.force !== 'incremental' && state.is_backfilling === 1);
  const maxPages = backfilling ? SATFLOW_BACKFILL_MAX_PAGES_PER_TICK : SATFLOW_INCREMENTAL_MAX_PAGES;

  const startedAt = Date.now();
  // A `ts:<n>` last_cursor is our own sentinel from a prior tick where Satflow
  // didn't expose nextCursor — translate it back to `since` regardless of mode
  // so we never round-trip the sentinel to Satflow as ?cursor=.
  let cursor: string | null = null;
  let since: number | null = null;
  if (state.last_cursor?.startsWith('ts:')) {
    since = parseSinceFromCursor(state.last_cursor);
  } else if (backfilling) {
    cursor = state.last_cursor;
  }
  let upgraded = 0;
  let inserted = 0;
  let pagesUsed = 0;
  let drained = false;
  let errMsg: string | null = null;
  let oldestSeen: number | null = null;
  let newestSeen: number | null = null;

  for (let i = 0; i < maxPages; i++) {
    if (Date.now() - startedAt > TICK_WALLCLOCK_BUDGET_MS) break;
    if (i > 0 && backfilling) await sleep(SATFLOW_BACKFILL_POLITENESS_MS);

    let page;
    try {
      page = await fetchSalesPage({
        collectionId: SATFLOW_COLLECTION_ID,
        since,
        cursor,
        count: SATFLOW_PAGE_SIZE,
        apiKey,
      });
      pagesUsed++;
    } catch (err) {
      errMsg = errorMessage(err);
      break;
    }

    if (page.items.length === 0) {
      drained = true;
      break;
    }

    const ap = applySalesTransaction(page.items);
    upgraded += ap.upgraded;
    inserted += ap.inserted;

    for (const it of page.items) {
      if (oldestSeen == null || it.block_timestamp < oldestSeen) oldestSeen = it.block_timestamp;
      if (newestSeen == null || it.block_timestamp > newestSeen) newestSeen = it.block_timestamp;
    }

    if (page.nextCursor) {
      cursor = page.nextCursor;
    } else if (backfilling && page.oldestTimestamp != null) {
      // Cursor not exposed by API: page backwards by oldest-timestamp seen.
      since = page.oldestTimestamp - 1;
      cursor = `ts:${since}`;
    } else {
      drained = true;
      break;
    }

    if (page.rawCount < SATFLOW_PAGE_SIZE) {
      drained = true;
      break;
    }
  }

  // Persist cursor: backfill resumes where it left off; incremental remembers the
  // newest timestamp we saw so the next tick can ask for `since` that.
  let nextCursor = cursor;
  if (!backfilling && newestSeen != null) {
    nextCursor = `ts:${newestSeen}`;
  }

  stmts.setPollResult.run({
    stream: 'satflow',
    status: errMsg ? errMsg.slice(0, 500) : 'ok',
    event_count: inserted + upgraded,
    cursor: nextCursor ?? null,
  });

  if (backfilling && drained && !errMsg) {
    stmts.setBackfilling.run({ stream: 'satflow', flag: 0 });
  }

  return {
    mode: backfilling ? 'satflow-backfill' : 'satflow',
    pages: pagesUsed,
    inserted,
    upgraded,
    oldest: oldestSeen,
    newest: newestSeen,
    done: drained,
    ...(errMsg ? { error: errMsg } : {}),
  };
}

function parseSinceFromCursor(cursor: string | null): number | null {
  if (!cursor) return null;
  const m = /^ts:(\d+)$/.exec(cursor);
  return m ? parseInt(m[1], 10) : null;
}

function applySalesTransaction(sales: NormalizedSale[]): {
  upgraded: number;
  inserted: number;
} {
  if (sales.length === 0) return { upgraded: 0, inserted: 0 };
  const stmts = getStmts();
  const db = getDb();
  let upgraded = 0;
  let inserted = 0;

  const tx = db.transaction(() => {
    for (const sale of sales) {
      const existing = stmts.findEventByInscriptionAndTxid.get({
        inscription_id: sale.inscription_id,
        txid: sale.txid,
      }) as { id: number; event_type: string; inscription_number: number } | undefined;

      if (existing) {
        if (existing.event_type === 'sold') continue;
        // Upgrade transferred → sold; rebalance aggregates.
        const r = stmts.upgradeEventToSold.run({
          inscription_id: sale.inscription_id,
          txid: sale.txid,
          marketplace: sale.marketplace,
          sale_price_sats: sale.sale_price_sats,
          old_owner: sale.seller,
          new_owner: sale.buyer,
          // Pass through Satflow's on-chain timing so a transfer event written
          // with poll-time fallback gets corrected on upgrade. Null values are
          // COALESCEd in the SQL, so this never clobbers existing on-chain values.
          block_height: sale.block_height,
          block_timestamp: sale.block_timestamp,
          raw_json: sale.raw_json,
        });
        if (r.changes > 0) {
          upgraded++;
          stmts.unbumpTransferOnUpgrade.run({
            inscription_number: existing.inscription_number,
            sale_price_sats: sale.sale_price_sats,
          });
        }
        continue;
      }

      // Standalone insert: ord hasn't seen the transfer yet (or won't).
      stmts.upsertInscriptionFromEvent.run({
        inscription_number: sale.inscription_number,
        inscription_id: sale.inscription_id,
        inscribe_at: null,
        block_timestamp: sale.block_timestamp,
      });
      const r = stmts.insertEvent.run({
        inscription_id: sale.inscription_id,
        inscription_number: sale.inscription_number,
        event_type: 'sold',
        block_height: sale.block_height,
        block_timestamp: sale.block_timestamp,
        new_satpoint: null,
        old_owner: sale.seller,
        new_owner: sale.buyer,
        marketplace: sale.marketplace,
        sale_price_sats: sale.sale_price_sats,
        txid: sale.txid,
        raw_json: sale.raw_json,
      });
      if (r.changes > 0) {
        inserted++;
        stmts.bumpInscriptionAggregates.run({
          inscription_number: sale.inscription_number,
          event_type: 'sold',
          sale_price_sats: sale.sale_price_sats,
          block_timestamp: sale.block_timestamp,
        });
      }
    }
  });
  tx();

  return { upgraded, inserted };
}

// ---------------- helpers ----------------

function errorMessage(err: unknown): string {
  if (err instanceof OrdError || err instanceof SatflowError) {
    return `${err.message}${err.bodyExcerpt ? ' :: ' + err.bodyExcerpt.slice(0, 200) : ''}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status });
}
