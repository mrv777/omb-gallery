import { NextRequest, NextResponse } from 'next/server';
import { getDb, getStmts, walCheckpoint, type CollectionRow, type PollStateRow } from '@/lib/db';
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
  fetchListingsPage,
  setCallCounter,
  SatflowError,
  type NormalizedSale,
  type NormalizedListing,
} from '@/lib/satflow';
import { log } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Optional per-collection override for the Satflow API slug. The env var
// is named `..._COLLECTION_ID` for historical reasons; its value is a slug
// like "omb". When unset, the slug from the collection's manifest wins.
const SATFLOW_OMB_OVERRIDE = process.env.SATFLOW_OMB_COLLECTION_ID ?? null;

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

// Listings change frequently but the snapshot churn doesn't have to be
// captured at sales-tick cadence. Run a refresh at most every 15 min,
// regardless of how often the cron fires. Cuts ~67% of listing API calls.
const LISTINGS_MIN_INTERVAL_SEC = 15 * 60;
// Hard cap on pages walked per listings tick. With ~209 active OMB listings
// at pageSize=100, 5 pages is ample headroom for growth and a defensive
// brake if the API ever returns runaway data.
const LISTINGS_MAX_PAGES = 5;
// Soft alarm threshold for the monthly call budget. We don't BLOCK at this
// threshold — that could disable the indexer silently — but we surface it in
// the tick result so it shows up in the activity-page status bar.
const SATFLOW_MONTHLY_BUDGET = 100_000;
const SATFLOW_BUDGET_WARN_PCT = 0.8;
const SATFLOW_BUDGET_WINDOW_SEC = 30 * 24 * 60 * 60;

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
  skipped?:
    | 'concurrent'
    | 'budget'
    | 'not-configured'
    | 'interval-not-elapsed'
    | 'empty-resolution';
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

  // Hook the satflow client up to the persistent monthly call counter on
  // every request — cheap (idempotent setter), and keeps cold-start instances
  // wired up without a separate boot path.
  installSatflowCallCounter();

  const url = new URL(req.url);
  const mode = url.searchParams.get('mode') ?? 'auto';
  // Optional ?collection=<slug> to target a single collection. Default: all
  // enabled collections with a satflow_slug. (ord is collection-agnostic and
  // ignores this param.)
  const onlyCollection = url.searchParams.get('collection');

  const tickStartedAt = Date.now();
  log.info('poll', 'tick start', { mode, collection: onlyCollection ?? undefined });
  try {
    let result: TickResult | TickResult[];
    switch (mode) {
      case 'init-backfill':
        result = initBackfill(onlyCollection);
        break;
      case 'ord':
        result = await runOrdTick();
        break;
      case 'satflow':
        result = await iterateSatflowCollections(onlyCollection, {});
        break;
      case 'satflow-backfill':
        result = await iterateSatflowCollections(onlyCollection, { force: 'backfill' });
        break;
      case 'listings':
        result = await iterateListingsCollections(onlyCollection, { force: true });
        break;
      case 'auto':
      default: {
        const ord = await runOrdTick();
        const satflow = await iterateSatflowCollections(onlyCollection, {});
        const listings = await iterateListingsCollections(onlyCollection, { force: false });
        result = [ord, ...satflow, ...listings];
        break;
      }
    }
    walCheckpoint();
    log.info('poll', 'tick complete', {
      mode,
      dur_ms: Date.now() - tickStartedAt,
      streams: Array.isArray(result) ? result.length : 1,
    });
    return json(result, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('poll', 'tick failed', {
      mode,
      dur_ms: Date.now() - tickStartedAt,
      error: msg,
      stack: err instanceof Error ? err.stack : undefined,
    });
    return json({ error: msg }, 500);
  }
}

let callCounterInstalled = false;
function installSatflowCallCounter(): void {
  if (callCounterInstalled) return;
  callCounterInstalled = true;
  setCallCounter(() => {
    try {
      const stmts = getStmts();
      const budget = stmts.getSatflowCallBudget.get([]) as
        | { window_start: number; call_count: number }
        | undefined;
      const now = Math.floor(Date.now() / 1000);
      if (!budget || now - budget.window_start >= SATFLOW_BUDGET_WINDOW_SEC) {
        stmts.resetSatflowCallBudget.run([]);
      }
      stmts.bumpSatflowCallCount.run([]);
    } catch {
      // Counter writes must never break ingestion. Failures here mean the
      // budget reading drifts low — operationally tolerable.
    }
  });
}

// ---------------- collection iteration helpers ----------------

/**
 * Resolve which satflow-tracked collections this request should hit. With
 * `?collection=<slug>` we target one; otherwise every enabled collection
 * whose manifest carries a satflow_slug. Returned with the API slug
 * resolved (env override > manifest), so downstream code doesn't have to
 * know about the override path.
 */
function resolveSatflowCollections(
  only: string | null
): Array<{ slug: string; satflow_slug: string }> {
  const stmts = getStmts();
  const all = stmts.listEnabledCollections.all([]) as CollectionRow[];
  const filtered = only ? all.filter(c => c.slug === only) : all;
  const out: Array<{ slug: string; satflow_slug: string }> = [];
  for (const c of filtered) {
    const apiSlug =
      c.slug === 'omb' && SATFLOW_OMB_OVERRIDE ? SATFLOW_OMB_OVERRIDE : c.satflow_slug;
    if (!apiSlug) continue;
    out.push({ slug: c.slug, satflow_slug: apiSlug });
  }
  return out;
}

async function iterateSatflowCollections(
  only: string | null,
  opts: { force?: 'incremental' | 'backfill' }
): Promise<TickResult[]> {
  const cols = resolveSatflowCollections(only);
  if (cols.length === 0) return [{ mode: 'satflow', skipped: 'not-configured' }];
  const out: TickResult[] = [];
  for (const c of cols) {
    out.push(await runSatflowTick(c, opts));
  }
  return out;
}

async function iterateListingsCollections(
  only: string | null,
  opts: { force: boolean }
): Promise<TickResult[]> {
  const cols = resolveSatflowCollections(only);
  if (cols.length === 0) return [{ mode: 'listings', skipped: 'not-configured' }];
  const out: TickResult[] = [];
  for (const c of cols) {
    out.push(await runListingsTick(c, opts));
  }
  return out;
}

// ---------------- mode: init-backfill ----------------

function initBackfill(only: string | null): TickResult | TickResult[] {
  const cols = resolveSatflowCollections(only);
  if (cols.length === 0) return { mode: 'init-backfill', skipped: 'not-configured' };
  const db = getDb();
  // Reset to page 1 per collection — backfill walks `sortDirection=asc` so
  // page 1 is the oldest sale. New sales appended at the latest page don't
  // shift older pages we're walking through. Also zero the cross-tick
  // unresolved counter so the new walk starts clean.
  const stmt = db.prepare(
    `UPDATE poll_state
     SET last_cursor = 'page:1', is_backfilling = 1, backfill_unresolved_seen = 0
     WHERE stream = 'satflow' AND collection_slug = @collection`
  );
  const out: TickResult[] = [];
  for (const c of cols) {
    stmt.run({ collection: c.slug });
    out.push({ mode: 'init-backfill', collection: c.slug, done: true });
  }
  return out;
}

// ---------------- mode: ord ----------------

async function runOrdTick(): Promise<TickResult> {
  if (!process.env.ORD_BASE_URL) {
    return { mode: 'ord', skipped: 'not-configured' };
  }

  const stmts = getStmts();
  // ord uses a single ('ord','omb') bookkeeping row — one batch poll covers
  // every inscription regardless of collection (ord is collection-agnostic).
  const lockRes = stmts.acquireLock.run({ stream: 'ord', collection: 'omb' });
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
  const priorState = stmts.getPollState.get({
    stream: 'ord',
    collection: 'omb',
  }) as PollStateRow | undefined;
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
  const newKnownHeight = priorHeight != null ? Math.max(priorHeight, blockHeight) : blockHeight;

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
      // ord 404s the whole batch when ANY id in the chunk hasn't been
      // revealed in its index yet (typical during IBD). Skip this chunk
      // and rotate it to the back of the queue so the bad inscription
      // doesn't pin itself to the front and starve every other chunk.
      // Other error classes (5xx, network, malformed) keep the old
      // behavior of breaking out so we retry on the next tick.
      if (err instanceof OrdError && err.status === 404) {
        log.warn('poll/ord', 'batch 404 — skipping chunk', {
          chunk_size: chunk.length,
          first_id: chunk[0],
        });
        markChunkPolled(chunk);
        continue;
      }
      log.error('poll/ord', 'batch fetch failed', { chunk_size: chunk.length, error: errMsg });
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
    stmts.setKnownHeight.run({
      stream: 'ord',
      collection: 'omb',
      height: newKnownHeight,
    });
  }

  log.info('poll/ord', errMsg ? 'tick complete (with error)' : 'tick complete', {
    block_height: blockHeight,
    bootstrapped,
    checked,
    changed,
    inserted,
    initialized,
    dur_ms: Date.now() - startedAt,
    error: errMsg ?? undefined,
  });

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
      wave.map(row => fetchInscriptionDetail(row.inscription_number))
    );
    // Hold onto the first hard error so we still process every fulfilled
    // result in this wave before bailing — otherwise a single 5xx in the
    // middle would silently discard the inscriptions before it.
    let hardError: unknown = null;
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      const row = wave[j];
      if (r.status === 'rejected') {
        // 404 is expected for inscriptions ord doesn't know about yet
        // (very-recent mints, or mints past ord's current sync height).
        // Anything else is a real error — surface it once the wave's
        // successes have all been committed.
        if (r.reason instanceof OrdError && r.reason.status === 404) continue;
        if (hardError == null) hardError = r.reason;
        continue;
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
    if (hardError) throw hardError;
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
async function enrichTransfers(satpoints: string[], ordTip: number | null): Promise<EnrichmentMap> {
  const map: EnrichmentMap = new Map();
  if (satpoints.length === 0 || ordTip == null) return map;
  const unique = Array.from(new Set(satpoints));

  // Step 1: parallel /output lookups → confirmations → block_height
  const heights = new Map<string, number>();
  for (let i = 0; i < unique.length; i += ORD_ENRICHMENT_CONCURRENCY) {
    const wave = unique.slice(i, i + ORD_ENRICHMENT_CONCURRENCY);
    const results = await Promise.allSettled(wave.map(sp => fetchOutputConfirmations(sp)));
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
    const results = await Promise.allSettled(wave.map(h => fetchBlockTimestamp(h)));
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
    collection: 'omb',
    status,
    event_count: eventCount,
    cursor: null,
  });
}

// ---------------- mode: satflow ----------------

async function runSatflowTick(
  collection: { slug: string; satflow_slug: string },
  opts: { force?: 'incremental' | 'backfill' }
): Promise<TickResult> {
  const apiKey = process.env.SATFLOW_API_KEY ?? null;

  const stmts = getStmts();
  const lockRes = stmts.acquireLock.run({ stream: 'satflow', collection: collection.slug });
  if (lockRes.changes === 0) {
    return { mode: 'satflow', collection: collection.slug, skipped: 'concurrent' };
  }

  const state = stmts.getPollState.get({
    stream: 'satflow',
    collection: collection.slug,
  }) as PollStateRow;
  const backfilling =
    opts.force === 'backfill' || (opts.force !== 'incremental' && state.is_backfilling === 1);
  const maxPages = backfilling
    ? SATFLOW_BACKFILL_MAX_PAGES_PER_TICK
    : SATFLOW_INCREMENTAL_MAX_PAGES;
  // Cross-tick sticky counter: any unresolved sale seen during this backfill
  // walk (across multiple ticks) keeps us from declaring "done" until we
  // restart at page 1 and confirm everything resolves. Without this, an
  // unresolved sale on an early page is permanently skipped after the cursor
  // advances past it.
  const priorUnresolvedSeen = backfilling ? (state.backfill_unresolved_seen ?? 0) : 0;

  // Pagination model:
  //   incremental: walk page 1 → N with sortDirection=desc (newest first),
  //     stop when an entire page is duplicates of events already in DB
  //     (or we hit maxPages, or the API returns < pageSize items).
  //   backfill:    walk page N → N+1 with sortDirection=asc (oldest first),
  //     resume from `last_cursor='page:N'`. Asc ordering means newly-arrived
  //     sales land on the latest page and don't shift older pages we're
  //     still walking through.
  const sortDirection: 'asc' | 'desc' = backfilling ? 'asc' : 'desc';
  let nextPage = backfilling ? Math.max(1, parsePageFromCursor(state.last_cursor) ?? 1) : 1;

  // Build the inscription_id → inscription_number resolution map once per
  // tick. Sales whose inscription_id isn't in this map are skipped (counted
  // as `unresolved`); they'll be ingested on a later tick once the ord
  // bootstrap pass has populated their inscription_id in the inscriptions
  // table.
  const idToNumber = buildIdToNumberMap();

  const startedAt = Date.now();
  let upgraded = 0;
  let inserted = 0;
  let unresolved = 0;
  let pagesUsed = 0;
  let drained = false;
  let errMsg: string | null = null;
  let totalReported: number | null = null;
  let lastPageReached = nextPage - 1;

  for (let i = 0; i < maxPages; i++) {
    if (Date.now() - startedAt > TICK_WALLCLOCK_BUDGET_MS) break;
    if (i > 0 && backfilling) await sleep(SATFLOW_BACKFILL_POLITENESS_MS);

    let page;
    try {
      page = await fetchSalesPage({
        collectionSlug: collection.satflow_slug,
        page: nextPage,
        pageSize: SATFLOW_PAGE_SIZE,
        sortDirection,
        apiKey,
      });
      pagesUsed++;
      lastPageReached = nextPage;
      totalReported = page.total;
    } catch (err) {
      errMsg = errorMessage(err);
      break;
    }

    if (page.rawCount === 0) {
      drained = true;
      break;
    }

    const ap = applySalesTransaction(page.items, idToNumber);
    upgraded += ap.upgraded;
    inserted += ap.inserted;
    unresolved += ap.unresolved;

    // Incremental stop condition: an entire page yielded zero new writes
    // (every sale is already in events). Once that's true newer pages can
    // only repeat what we've seen, so further fetching is wasteful.
    if (!backfilling && ap.inserted === 0 && ap.upgraded === 0 && ap.unresolved === 0) {
      drained = true;
      break;
    }

    if (!page.hasMore) {
      drained = true;
      break;
    }

    nextPage++;
  }

  // Persist cursor + cross-tick unresolved counter:
  //   incremental: no cursor; counter not used.
  //   backfill mid-walk: park at next page; persist running unresolved total.
  //   backfill drained, ANY unresolved across this walk: reset to page 1 and
  //     zero the counter so the next pass (after ord catches up) re-walks the
  //     whole history. The flag stays set.
  //   backfill drained, all clean: park at last page; flag clears below.
  const totalUnresolvedSeen = backfilling ? priorUnresolvedSeen + unresolved : 0;
  const fullyClean = totalUnresolvedSeen === 0;
  let nextCursor: string | null;
  let nextUnresolvedSeen = totalUnresolvedSeen;
  if (!backfilling) {
    nextCursor = null;
  } else if (drained && !fullyClean) {
    nextCursor = 'page:1';
    nextUnresolvedSeen = 0;
  } else if (drained) {
    nextCursor = `page:${lastPageReached}`;
  } else {
    nextCursor = `page:${nextPage}`;
  }

  stmts.setPollResult.run({
    stream: 'satflow',
    collection: collection.slug,
    status: errMsg ? errMsg.slice(0, 500) : 'ok',
    event_count: inserted + upgraded,
    cursor: nextCursor,
  });

  if (backfilling) {
    stmts.setBackfillUnresolvedSeen.run({
      stream: 'satflow',
      collection: collection.slug,
      count: nextUnresolvedSeen,
    });
  }

  // Only clear the backfilling flag once we've drained AND every sale across
  // the whole walk resolved (not just this tick). Otherwise keep is_backfilling=1
  // so the next cron tick re-walks from page 1 and retries the unresolved tail.
  if (backfilling && drained && fullyClean && !errMsg) {
    stmts.setBackfilling.run({ stream: 'satflow', collection: collection.slug, flag: 0 });
  }

  log.info('poll/satflow', errMsg ? 'tick complete (with error)' : 'tick complete', {
    collection: collection.slug,
    backfilling,
    pages: pagesUsed,
    inserted,
    upgraded,
    unresolved,
    last_page: lastPageReached,
    drained,
    dur_ms: Date.now() - startedAt,
    error: errMsg ?? undefined,
  });

  return {
    mode: backfilling ? 'satflow-backfill' : 'satflow',
    collection: collection.slug,
    pages: pagesUsed,
    inserted,
    upgraded,
    unresolved,
    unresolvedSeenTotal: backfilling ? nextUnresolvedSeen : 0,
    lastPage: lastPageReached,
    total: totalReported,
    done: drained && fullyClean,
    ...(errMsg ? { error: errMsg } : {}),
  };
}

function parsePageFromCursor(cursor: string | null): number | null {
  if (!cursor) return null;
  const m = /^page:(\d+)$/.exec(cursor);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

function buildIdToNumberMap(): Map<string, number> {
  const stmts = getStmts();
  const rows = stmts.listInscriptionIdToNumber.all([]) as Array<{
    inscription_id: string;
    inscription_number: number;
  }>;
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.inscription_id, r.inscription_number);
  return map;
}

function applySalesTransaction(
  sales: NormalizedSale[],
  idToNumber: Map<string, number>
): {
  upgraded: number;
  inserted: number;
  unresolved: number;
} {
  if (sales.length === 0) return { upgraded: 0, inserted: 0, unresolved: 0 };
  const stmts = getStmts();
  const db = getDb();
  let upgraded = 0;
  let inserted = 0;
  let unresolved = 0;

  const tx = db.transaction(() => {
    for (const sale of sales) {
      const inscription_number = idToNumber.get(sale.inscription_id);
      if (inscription_number == null) {
        // We don't know this inscription yet — ord bootstrap hasn't populated
        // its inscription_id in our table. Skip; a later tick will pick it up
        // once bootstrap catches up. (For OMB-only collectionSlug, every
        // inscription should eventually be known.)
        unresolved++;
        continue;
      }

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
        inscription_number,
        inscription_id: sale.inscription_id,
        inscribe_at: null,
        block_timestamp: sale.block_timestamp,
      });
      // Update current_owner from satflow's buyer ONLY if this sale is at
      // least as recent as anything we know about — otherwise an older
      // backfill row would stomp a more-recent state from ord. Must run
      // before bumpInscriptionAggregates (which advances last_movement_at).
      stmts.setInscriptionOwnerIfNewer.run({
        inscription_number,
        new_owner: sale.buyer,
        block_timestamp: sale.block_timestamp,
      });
      const r = stmts.insertEvent.run({
        inscription_id: sale.inscription_id,
        inscription_number,
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
          inscription_number,
          event_type: 'sold',
          sale_price_sats: sale.sale_price_sats,
          block_timestamp: sale.block_timestamp,
        });
      }
    }
  });
  tx();

  return { upgraded, inserted, unresolved };
}

// ---------------- mode: listings ----------------

async function runListingsTick(
  collection: { slug: string; satflow_slug: string },
  opts: { force: boolean }
): Promise<TickResult> {
  const apiKey = process.env.SATFLOW_API_KEY ?? null;

  const stmts = getStmts();

  // Cadence guard: skip if last successful run was within the interval and
  // we're not being explicitly forced (e.g. ?mode=listings).
  if (!opts.force) {
    const state = stmts.getPollState.get({
      stream: 'satflow_listings',
      collection: collection.slug,
    }) as PollStateRow | undefined;
    if (state?.last_run_at && state.last_status === 'ok') {
      const sinceLast = Math.floor(Date.now() / 1000) - state.last_run_at;
      if (sinceLast < LISTINGS_MIN_INTERVAL_SEC) {
        return {
          mode: 'listings',
          collection: collection.slug,
          skipped: 'interval-not-elapsed',
          wait_s: LISTINGS_MIN_INTERVAL_SEC - sinceLast,
        };
      }
    }
  }

  const lockRes = stmts.acquireLock.run({
    stream: 'satflow_listings',
    collection: collection.slug,
  });
  if (lockRes.changes === 0) {
    return { mode: 'listings', collection: collection.slug, skipped: 'concurrent' };
  }

  const idToNumber = buildIdToNumberMap();
  const startedAt = Date.now();
  let pagesUsed = 0;
  let totalReported = 0;
  let errMsg: string | null = null;

  // Phase 1: collect every active listing across all pages BEFORE touching
  // the DB. If any page fails, abort with the existing snapshot intact —
  // never replace good data with a partial fetch.
  const collected: NormalizedListing[] = [];
  for (let page = 1; page <= LISTINGS_MAX_PAGES; page++) {
    if (Date.now() - startedAt > TICK_WALLCLOCK_BUDGET_MS) {
      errMsg = `wallclock budget exceeded after ${pagesUsed} pages`;
      break;
    }

    let pageRes;
    try {
      pageRes = await fetchListingsPage({
        collectionSlug: collection.satflow_slug,
        page,
        pageSize: SATFLOW_PAGE_SIZE,
        apiKey,
      });
      pagesUsed++;
      totalReported = pageRes.total;
    } catch (err) {
      errMsg = errorMessage(err);
      break;
    }

    collected.push(...pageRes.items);
    if (!pageRes.hasMore) break;
  }

  if (errMsg) {
    stmts.setPollResult.run({
      stream: 'satflow_listings',
      collection: collection.slug,
      status: errMsg.slice(0, 500),
      event_count: 0,
      cursor: null,
    });
    log.warn('poll/listings', 'tick failed', {
      collection: collection.slug,
      pages: pagesUsed,
      dur_ms: Date.now() - startedAt,
      error: errMsg,
    });
    return { mode: 'listings', collection: collection.slug, pages: pagesUsed, error: errMsg };
  }

  // Phase 2: dedupe by inscription_id (lowest price wins). Same inscription
  // can technically be listed by two different sellers; the cheaper one is
  // what a buyer would actually take, so that's the one to store.
  const byInscriptionId = new Map<string, NormalizedListing>();
  for (const item of collected) {
    const existing = byInscriptionId.get(item.inscription_id);
    if (!existing || item.price_sats < existing.price_sats) {
      byInscriptionId.set(item.inscription_id, item);
    }
  }

  // Phase 3: resolve to inscription_number; bucket unresolved.
  const ready: Array<NormalizedListing & { inscription_number: number }> = [];
  let unresolved = 0;
  for (const item of Array.from(byInscriptionId.values())) {
    const num = idToNumber.get(item.inscription_id);
    if (num == null) {
      unresolved++;
      continue;
    }
    ready.push({ ...item, inscription_number: num });
  }

  // Defensive: if we got data back but resolved ZERO of it, ord hasn't
  // bootstrapped yet. Don't blow away the existing snapshot — keep stale
  // data and try again next tick.
  if (ready.length === 0 && unresolved > 0) {
    stmts.setPollResult.run({
      stream: 'satflow_listings',
      collection: collection.slug,
      status: 'ok-skipped-empty-resolution',
      event_count: 0,
      cursor: null,
    });
    return {
      mode: 'listings',
      collection: collection.slug,
      pages: pagesUsed,
      total: totalReported,
      collected: collected.length,
      unresolved,
      written: 0,
      skipped: 'empty-resolution',
    };
  }

  // Phase 4: snapshot-replace inside one transaction. Readers see either the
  // pre-tick snapshot or the post-tick snapshot, never a partial mid-write
  // view. With ~209 active listings, this is well under 10ms.
  const refreshedAt = Math.floor(Date.now() / 1000);
  const tx = getDb().transaction(() => {
    for (const item of ready) {
      stmts.upsertActiveListing.run({
        inscription_number: item.inscription_number,
        inscription_id: item.inscription_id,
        satflow_id: item.satflow_id,
        price_sats: item.price_sats,
        seller: item.seller,
        marketplace: 'satflow',
        listed_at: item.listed_at,
        refreshed_at: refreshedAt,
      });
    }
    // Anything not refreshed this tick (in this collection) is no longer
    // active on Satflow. Scoped to the current collection so other
    // collections' rows aren't affected.
    stmts.deleteStaleListings.run({ cutoff: refreshedAt, collection: collection.slug });
  });
  tx();

  // Surface budget warning in the response so the activity status bar can
  // show it. Soft-fail-only: never blocks tick execution.
  const budget = stmts.getSatflowCallBudget.get([]) as
    | { window_start: number; call_count: number }
    | undefined;
  const budgetPct = budget ? budget.call_count / SATFLOW_MONTHLY_BUDGET : 0;
  const budgetWarning =
    budgetPct >= SATFLOW_BUDGET_WARN_PCT
      ? `monthly call budget at ${(budgetPct * 100).toFixed(0)}%`
      : undefined;

  const writtenCount = stmts.countActiveListings.get([]) as { n: number } | undefined;

  stmts.setPollResult.run({
    stream: 'satflow_listings',
    collection: collection.slug,
    status: 'ok',
    event_count: ready.length,
    cursor: null,
  });

  log.info('poll/listings', 'tick complete', {
    collection: collection.slug,
    pages: pagesUsed,
    written: ready.length,
    unresolved,
    total_reported: totalReported,
    dur_ms: Date.now() - startedAt,
  });

  return {
    mode: 'listings',
    collection: collection.slug,
    pages: pagesUsed,
    total: totalReported,
    collected: collected.length,
    written: ready.length,
    deduped: collected.length - byInscriptionId.size,
    unresolved,
    active_in_db: writtenCount?.n ?? null,
    ...(budgetWarning ? { warning: budgetWarning } : {}),
  };
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
  return new Promise(r => setTimeout(r, ms));
}

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status });
}
