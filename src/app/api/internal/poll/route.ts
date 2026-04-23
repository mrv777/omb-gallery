import { NextRequest, NextResponse } from 'next/server';
import {
  getDb,
  getStmts,
  walCheckpoint,
  type PollStateRow,
} from '@/lib/db';
import {
  fetchActivityPage,
  fetchHoldersPage,
  BisError,
  type NormalizedEvent,
  type NormalizedHolder,
} from '@/lib/bis';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SLUG = process.env.BIS_OMB_SLUG ?? 'omb';
const PAGE_SIZE = 100;
const INCREMENTAL_MAX_PAGES = 3;
const BACKFILL_MAX_PAGES_PER_TICK = 8;
const BACKFILL_POLITENESS_MS = 500;
const TICK_WALLCLOCK_BUDGET_MS = 25_000;
const DAILY_CALL_LIMIT = 1000;
const DAILY_RESERVE_INCREMENTAL = 50;  // for incremental ticks (always reserved)
const DAILY_RESERVE_BACKFILL = 100;    // additional reserve for backfill (incremental + holders + safety)

type TickResult = {
  mode: string;
  inserted?: number;
  pages?: number;
  cursor?: string | null;
  skipped?: 'concurrent' | 'budget';
  error?: string;
  done?: boolean;
  holders?: number;
};

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
    let result: TickResult;
    switch (mode) {
      case 'init-backfill':
        result = initBackfill();
        break;
      case 'holders':
        result = await runHolders();
        break;
      case 'incremental':
        result = await runActivity({ force: 'incremental' });
        break;
      case 'backfill':
        result = await runActivity({ force: 'backfill' });
        break;
      case 'auto':
      default:
        result = await runActivity({});
        break;
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
  db.prepare(
    `UPDATE poll_state SET last_cursor = NULL, is_backfilling = 1 WHERE stream = 'activity'`
  ).run();
  return { mode: 'init-backfill', done: true };
}

// ---------------- mode: activity (auto / incremental / backfill) ----------------

async function runActivity(opts: {
  force?: 'incremental' | 'backfill';
}): Promise<TickResult> {
  const stmts = getStmts();

  // Acquire soft lock
  const lockRes = stmts.acquireLock.run('activity');
  if (lockRes.changes === 0) {
    return { mode: 'activity', skipped: 'concurrent' };
  }

  // Reset daily counter if UTC date changed
  resetDailyIfRolledOver('activity');

  const state = stmts.getPollState.get('activity') as PollStateRow;
  const backfilling = opts.force === 'backfill' || (opts.force !== 'incremental' && state.is_backfilling === 1);

  const dailyReserve = backfilling
    ? DAILY_RESERVE_INCREMENTAL + DAILY_RESERVE_BACKFILL
    : DAILY_RESERVE_INCREMENTAL;
  const remainingBudget = Math.max(0, DAILY_CALL_LIMIT - state.daily_call_count - dailyReserve);
  if (remainingBudget <= 0) {
    return { mode: backfilling ? 'backfill' : 'incremental', skipped: 'budget' };
  }

  const maxPages = Math.min(
    backfilling ? BACKFILL_MAX_PAGES_PER_TICK : INCREMENTAL_MAX_PAGES,
    remainingBudget
  );

  const startedAt = Date.now();
  let cursor = state.last_cursor;
  let pagesUsed = 0;
  let insertedTotal = 0;
  let drained = false;
  let errMsg: string | null = null;

  for (let i = 0; i < maxPages; i++) {
    if (Date.now() - startedAt > TICK_WALLCLOCK_BUDGET_MS) break;

    if (backfilling && i > 0) {
      await sleep(BACKFILL_POLITENESS_MS);
    }

    let page;
    try {
      page = await fetchActivityPage({
        slug: SLUG,
        cursor,
        count: PAGE_SIZE,
        apiKey: process.env.BIS_API_KEY,
      });
      pagesUsed++;
    } catch (err) {
      errMsg =
        err instanceof BisError
          ? `${err.message}${err.bodyExcerpt ? ' :: ' + err.bodyExcerpt.slice(0, 200) : ''}`
          : err instanceof Error
            ? err.message
            : String(err);
      // Don't advance cursor on error.
      break;
    }

    if (page.items.length === 0 && page.rawCount === 0) {
      drained = true;
      break;
    }

    const inserted = applyEventsTransaction(page.items);
    insertedTotal += inserted;

    // Advance cursor to the last new_satpoint of this page (even if all items were dupes —
    // the cursor would advance anyway since BiS returned them in ts/satpoint order).
    const lastItem = page.items[page.items.length - 1] ?? null;
    if (lastItem) cursor = lastItem.new_satpoint;

    // Persist cursor incrementally so a crash doesn't lose progress.
    getStmts().setPollResult.run({
      stream: 'activity',
      status: 'ok',
      event_count: insertedTotal,
      cursor,
    });

    if (page.rawCount < PAGE_SIZE) {
      drained = true;
      break;
    }
  }

  bumpDailyCallCount('activity', pagesUsed);

  if (errMsg) {
    getStmts().setPollResult.run({
      stream: 'activity',
      status: errMsg.slice(0, 500),
      event_count: insertedTotal,
      cursor: null, // don't overwrite
    });
  } else {
    getStmts().setPollResult.run({
      stream: 'activity',
      status: 'ok',
      event_count: insertedTotal,
      cursor: null, // already advanced inside the loop
    });
  }

  // If backfill drained, clear the flag.
  if (backfilling && drained && !errMsg) {
    getStmts().setBackfilling.run({ stream: 'activity', flag: 0 });
  }

  return {
    mode: backfilling ? 'backfill' : 'incremental',
    inserted: insertedTotal,
    pages: pagesUsed,
    cursor,
    done: drained,
    ...(errMsg ? { error: errMsg } : {}),
  };
}

function applyEventsTransaction(items: NormalizedEvent[]): number {
  if (items.length === 0) return 0;
  const stmts = getStmts();
  const db = getDb();
  let inserted = 0;
  const tx = db.transaction(() => {
    for (const ev of items) {
      // Ensure inscriptions row exists (and learn inscription_id / first_event_at).
      stmts.upsertInscriptionFromEvent.run({
        inscription_number: ev.inscription_number,
        inscription_id: ev.inscription_id,
        inscribe_at: ev.event_type === 'inscribed' ? ev.block_timestamp : null,
        block_timestamp: ev.block_timestamp,
      });
      // Insert event; aggregates only bump if it was actually inserted.
      const r = stmts.insertEvent.run({
        inscription_id: ev.inscription_id,
        inscription_number: ev.inscription_number,
        event_type: ev.event_type,
        block_height: ev.block_height,
        block_timestamp: ev.block_timestamp,
        new_satpoint: ev.new_satpoint,
        old_owner: ev.old_owner,
        new_owner: ev.new_owner,
        marketplace: ev.marketplace,
        sale_price_sats: ev.sale_price_sats,
        txid: ev.txid,
        raw_json: ev.raw_json,
      });
      if (r.changes > 0) {
        inserted++;
        stmts.bumpInscriptionAggregates.run({
          inscription_number: ev.inscription_number,
          event_type: ev.event_type,
          sale_price_sats: ev.sale_price_sats,
          new_owner: ev.new_owner,
          block_timestamp: ev.block_timestamp,
        });
      }
    }
  });
  tx();
  return inserted;
}

// ---------------- mode: holders ----------------

async function runHolders(): Promise<TickResult> {
  const stmts = getStmts();
  const lockRes = stmts.acquireLock.run('holders');
  if (lockRes.changes === 0) {
    return { mode: 'holders', skipped: 'concurrent' };
  }

  resetDailyIfRolledOver('holders');
  const state = stmts.getPollState.get('holders') as PollStateRow;
  const remainingBudget = Math.max(0, DAILY_CALL_LIMIT - state.daily_call_count - DAILY_RESERVE_INCREMENTAL);
  if (remainingBudget <= 0) {
    return { mode: 'holders', skipped: 'budget' };
  }

  const startedAt = Date.now();
  const collected: NormalizedHolder[] = [];
  let offset = 0;
  let pagesUsed = 0;
  let errMsg: string | null = null;

  while (pagesUsed < remainingBudget) {
    if (Date.now() - startedAt > TICK_WALLCLOCK_BUDGET_MS) {
      errMsg = 'wallclock-budget exhausted before holders drained';
      break;
    }
    if (pagesUsed > 0) await sleep(BACKFILL_POLITENESS_MS);

    let page;
    try {
      page = await fetchHoldersPage({
        slug: SLUG,
        offset,
        count: PAGE_SIZE,
        apiKey: process.env.BIS_API_KEY,
      });
      pagesUsed++;
    } catch (err) {
      errMsg =
        err instanceof BisError
          ? `${err.message}${err.bodyExcerpt ? ' :: ' + err.bodyExcerpt.slice(0, 200) : ''}`
          : err instanceof Error
            ? err.message
            : String(err);
      break;
    }

    collected.push(...page.items);
    if (page.rawCount < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  bumpDailyCallCount('holders', pagesUsed);

  // Only commit a refresh if we got a non-empty result and no fatal error mid-stream.
  if (!errMsg && collected.length > 0) {
    const db = getDb();
    const tx = db.transaction(() => {
      stmts.deleteAllHolders.run([]);
      for (const h of collected) {
        stmts.insertHolder.run({
          wallet_addr: h.wallet_addr,
          inscription_count: h.inscription_count,
        });
      }
      // Backfill current_owner for inscriptions that never had one set,
      // using the latest event.new_owner. (BiS holders endpoint typically
      // doesn't return wallet→inscription mappings.)
      stmts.setCurrentOwnerFromLatestEvent.run([]);
    });
    tx();
  }

  stmts.setPollResult.run({
    stream: 'holders',
    status: errMsg ? errMsg.slice(0, 500) : 'ok',
    event_count: collected.length,
    cursor: null,
  });

  return {
    mode: 'holders',
    holders: collected.length,
    pages: pagesUsed,
    ...(errMsg ? { error: errMsg } : {}),
  };
}

// ---------------- helpers ----------------

function resetDailyIfRolledOver(stream: 'activity' | 'holders'): void {
  const stmts = getStmts();
  const today = utcDate();
  const state = stmts.getPollState.get(stream) as PollStateRow;
  if (state.daily_call_date !== today) {
    stmts.resetDailyCallCount.run({ stream, date: today });
  }
}

function bumpDailyCallCount(stream: 'activity' | 'holders', n: number): void {
  if (n <= 0) return;
  getStmts().bumpDailyCallCount.run({ stream, n, date: utcDate() });
}

function utcDate(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status });
}
