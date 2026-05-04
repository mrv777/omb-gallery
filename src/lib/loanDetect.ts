import 'server-only';

// Forward-tick loan detection. Mirrors the structural logic in
// scripts/backfill-loans.js but processes only NEW transferred events since
// the last cursor, so it fits inside the 5-min auto cron budget.
//
// What this catches that the once-shot backfill script doesn't (going
// forward): every new transferred event lands in the events table via the
// ord poll; this tick reclassifies any of them that turn out to be loan
// movements (default / origination / unlock) and synthesizes loan-repaid
// rows where a borrower→lender BTC tx can be traced from the unlock.
//
// What this does NOT do (deferred):
//   - Enqueue loan events for notification fan-out. The runtime fan-out
//     filter selects only ('transferred','sold','listed') event types, so a
//     loan-* row would never be delivered. To keep this scoped, we DELETE
//     the upgraded row's queue entry after upgrade so the queue doesn't
//     accumulate dead rows. Loan notifications are a follow-up.
//   - Run against any collection other than 'omb'. Loans are OMB-specific
//     today; the cursor row is keyed to ('loans','omb').

import { getDb } from './db';
import { log } from './log';
import {
  bitcoindConfigured,
  getBlockchainTip,
  getRawTxCached,
  type RawTx,
  type TxCache,
} from './bitcoind';

// Tick wallclock cap. The /api/internal/poll auto cron runs every 5min;
// loans is one of several streams in that tick, so it should complete fast
// in normal operation. Most ticks will process 0-50 events (≪1s); this cap
// protects against pathological catch-up after a long outage.
const TICK_WALLCLOCK_BUDGET_MS = 30_000;

// Cap on events processed per tick. Same protection as the wallclock budget;
// catch-up after a long outage spreads across multiple ticks instead of
// blowing one out. With a 5-min cron and ~50 normal events/tick, 500 gives
// 10× headroom.
const MAX_EVENTS_PER_TICK = 500;

// Repayment trace settings — same as the backfill script.
const REPAYMENT_TRACE_MAX_HOPS = 2;
const MAX_BRANCHING_PER_LEVEL = 4;

// Plausible timelock value bounds. Mirrors scripts/backfill-loans.js.
const TIMELOCK_TIMESTAMP_MIN = 1_672_531_200; // 2023-01-01 UTC
const TIMELOCK_TIMESTAMP_MAX = 1_893_456_000; // 2030-01-01 UTC
const TIMELOCK_BLOCKS_MIN = 144;
const TIMELOCK_BLOCKS_MAX = 5_000_000;

const DETECTOR_VERSION = 2;

// ---------------- script parsers ----------------
//
// Same parsers as scripts/backfill-loans.js — kept inline rather than
// imported because the script is CommonJS and lives outside src/. If we ever
// want one source of truth, hoist these into a shared module that both can
// import.

function extractTaprootScriptPath(
  vin: RawTx['vin'][number]
): { scriptHex: string; controlBlockHex: string } | null {
  if (!vin || !Array.isArray(vin.txinwitness)) return null;
  if (vin.txinwitness.length < 2) return null;
  const controlBlock = vin.txinwitness[vin.txinwitness.length - 1];
  if (typeof controlBlock !== 'string') return null;
  const firstByte = parseInt(controlBlock.slice(0, 2), 16);
  if (firstByte !== 0xc0 && firstByte !== 0xc1) return null;
  const cbBytes = controlBlock.length / 2;
  if (cbBytes < 33 || (cbBytes - 33) % 32 !== 0) return null;
  const scriptHex = vin.txinwitness[vin.txinwitness.length - 2];
  if (typeof scriptHex !== 'string') return null;
  return { scriptHex, controlBlockHex: controlBlock };
}

type LoanDefaultLeaf = {
  timelockBytes: string;
  timelockNumber: number;
  timelockKind: 'timestamp' | 'blocks';
  opcode: 'CLTV' | 'CSV';
  pubkeyHex: string;
};

function parseLoanDefaultLeaf(scriptHex: string): LoanDefaultLeaf | null {
  if (typeof scriptHex !== 'string' || scriptHex.length < 76) return null;

  const opByte = parseInt(scriptHex.slice(0, 2), 16);
  let dataLen = 0;
  let dataStart = 2;
  if (opByte >= 0x01 && opByte <= 0x4b) {
    dataLen = opByte;
  } else if (opByte === 0x4c) {
    dataLen = parseInt(scriptHex.slice(2, 4), 16);
    dataStart = 4;
  } else if (opByte === 0x4d) {
    const lo = scriptHex.slice(2, 4);
    const hi = scriptHex.slice(4, 6);
    dataLen = parseInt(hi + lo, 16);
    dataStart = 6;
  } else {
    return null;
  }
  if (dataLen <= 0 || dataLen > 5) return null;
  const dataBytesEnd = dataStart + dataLen * 2;
  if (dataBytesEnd >= scriptHex.length) return null;

  const timelockBytes = scriptHex.slice(dataStart, dataBytesEnd);
  const opcodeBytes = scriptHex.slice(dataBytesEnd, dataBytesEnd + 4);
  let opcode: 'CLTV' | 'CSV';
  if (opcodeBytes === 'b175') opcode = 'CLTV';
  else if (opcodeBytes === 'b275') opcode = 'CSV';
  else return null;

  const pushOpOff = dataBytesEnd + 4;
  if (scriptHex.slice(pushOpOff, pushOpOff + 2) !== '20') return null;
  const pubkeyOff = pushOpOff + 2;
  const pubkeyHex = scriptHex.slice(pubkeyOff, pubkeyOff + 64);
  if (pubkeyHex.length !== 64) return null;
  const checksigOff = pubkeyOff + 64;
  if (scriptHex.slice(checksigOff, checksigOff + 2) !== 'ac') return null;
  if (checksigOff + 2 !== scriptHex.length) return null;

  let timelockNumber = 0;
  for (let i = 0; i < dataLen; i++) {
    const b = parseInt(timelockBytes.slice(i * 2, i * 2 + 2), 16);
    timelockNumber += b * Math.pow(2, i * 8);
  }
  let timelockKind: 'timestamp' | 'blocks';
  if (timelockNumber >= TIMELOCK_TIMESTAMP_MIN && timelockNumber <= TIMELOCK_TIMESTAMP_MAX) {
    timelockKind = 'timestamp';
  } else if (timelockNumber >= TIMELOCK_BLOCKS_MIN && timelockNumber <= TIMELOCK_BLOCKS_MAX) {
    timelockKind = 'blocks';
  } else {
    return null;
  }

  return { timelockBytes, timelockNumber, timelockKind, opcode, pubkeyHex };
}

function parseUnlockLeaf(scriptHex: string): { pubkeyHex: string } | null {
  if (typeof scriptHex !== 'string' || scriptHex.length !== 68) return null;
  if (scriptHex.slice(0, 2) !== '20') return null;
  const pubkeyHex = scriptHex.slice(2, 66);
  if (pubkeyHex.length !== 64) return null;
  if (scriptHex.slice(66, 68) !== 'ac') return null;
  return { pubkeyHex };
}

function btcToSats(v: number): number {
  return Math.round(v * 1e8);
}

function addressFromScriptPubKey(
  spk: { address?: string; addresses?: string[] } | undefined
): string | null {
  if (!spk) return null;
  if (typeof spk.address === 'string' && spk.address.length > 0) return spk.address;
  if (Array.isArray(spk.addresses) && typeof spk.addresses[0] === 'string') return spk.addresses[0];
  return null;
}

// ---------------- spend-side classification ----------------

type DefaultVerdict = {
  kind: 'default';
  escrowAddr: string;
  lender: string;
  timelock: { bytes: string; number: number; kind: 'timestamp' | 'blocks'; opcode: 'CLTV' | 'CSV' };
  prevoutTxid: string;
  prevoutVout: number;
  vinIndex: number;
  txid: string;
  blockTime: number | null;
};

type UnlockCandidate = {
  kind: 'unlock-candidate';
  escrowAddr: string;
  prevoutTxid: string;
  prevoutVout: number;
  vinIndex: number;
  pubkeyHex: string;
  txid: string;
  blockTime: number | null;
};

type SkipVerdict = { kind: 'skip'; reason: string };
type Verdict = DefaultVerdict | UnlockCandidate | SkipVerdict;

function classifySpendSide(tx: RawTx): Verdict {
  if (!tx || !Array.isArray(tx.vin) || !Array.isArray(tx.vout)) {
    return { kind: 'skip', reason: 'bad-tx' };
  }
  if (tx.vin.some((v) => v && v.coinbase)) {
    return { kind: 'skip', reason: 'coinbase' };
  }

  for (let i = 0; i < tx.vin.length; i++) {
    const vin = tx.vin[i];
    const sp = extractTaprootScriptPath(vin);
    if (!sp) continue;
    const leaf = parseLoanDefaultLeaf(sp.scriptHex);
    if (!leaf) continue;

    const escrowAddr = addressFromScriptPubKey(vin.prevout?.scriptPubKey);
    if (!escrowAddr) return { kind: 'skip', reason: 'no-escrow-addr' };

    const lenderCandidates = new Map<string, number>();
    for (let j = 0; j < tx.vin.length; j++) {
      if (j === i) continue;
      const v = tx.vin[j];
      const a = addressFromScriptPubKey(v.prevout?.scriptPubKey);
      if (!a) continue;
      const sats = btcToSats(v.prevout?.value ?? 0);
      lenderCandidates.set(a, (lenderCandidates.get(a) ?? 0) + sats);
    }
    let lender: string | null = null;
    let lenderSats = 0;
    lenderCandidates.forEach((sats, addr) => {
      if (sats > lenderSats) {
        lenderSats = sats;
        lender = addr;
      }
    });
    if (!lender) {
      let bestSats = 0;
      for (const o of tx.vout) {
        const a = addressFromScriptPubKey(o.scriptPubKey);
        if (!a) continue;
        const sats = btcToSats(o.value);
        if (sats > bestSats) {
          bestSats = sats;
          lender = a;
        }
      }
    }
    if (!lender) return { kind: 'skip', reason: 'no-lender' };

    return {
      kind: 'default',
      escrowAddr,
      lender,
      timelock: {
        bytes: leaf.timelockBytes,
        number: leaf.timelockNumber,
        kind: leaf.timelockKind,
        opcode: leaf.opcode,
      },
      prevoutTxid: vin.txid ?? '',
      prevoutVout: vin.vout ?? 0,
      vinIndex: i,
      txid: tx.txid,
      blockTime: tx.blocktime ?? null,
    };
  }

  for (let i = 0; i < tx.vin.length; i++) {
    const vin = tx.vin[i];
    const sp = extractTaprootScriptPath(vin);
    if (!sp) continue;
    if (parseLoanDefaultLeaf(sp.scriptHex)) continue;
    const unlock = parseUnlockLeaf(sp.scriptHex);
    if (!unlock) continue;
    const escrowAddr = addressFromScriptPubKey(vin.prevout?.scriptPubKey);
    if (!escrowAddr) continue;
    return {
      kind: 'unlock-candidate',
      escrowAddr,
      prevoutTxid: vin.txid ?? '',
      prevoutVout: vin.vout ?? 0,
      vinIndex: i,
      pubkeyHex: unlock.pubkeyHex,
      txid: tx.txid,
      blockTime: tx.blocktime ?? null,
    };
  }

  return { kind: 'skip', reason: 'no-loan-leaf' };
}

// ---------------- origination tracing ----------------

type Origination = {
  kind: 'origination';
  txid: string;
  escrowAddr: string;
  lender: string;
  borrower: string;
  loanAmountSats: number;
  blockTimestamp: number | null;
  escrowVout: number;
};

async function traceOrigination(
  prevoutTxid: string,
  escrowAddr: string,
  cache: TxCache
): Promise<Origination | SkipVerdict> {
  let tx: RawTx;
  try {
    tx = await getRawTxCached(prevoutTxid, cache);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { kind: 'skip', reason: `orig-rpc-fail:${msg.slice(0, 80)}` };
  }
  if (!tx || !Array.isArray(tx.vin) || !Array.isArray(tx.vout)) {
    return { kind: 'skip', reason: 'bad-orig-tx' };
  }

  const escrowVout = tx.vout.findIndex(
    (o) => addressFromScriptPubKey(o.scriptPubKey) === escrowAddr
  );
  if (escrowVout < 0) return { kind: 'skip', reason: 'escrow-not-here' };

  const inputBy = new Map<string, number>();
  for (const vin of tx.vin) {
    const a = addressFromScriptPubKey(vin.prevout?.scriptPubKey);
    if (!a) continue;
    const sats = btcToSats(vin.prevout?.value ?? 0);
    inputBy.set(a, (inputBy.get(a) ?? 0) + sats);
  }
  const outputBy = new Map<string, number>();
  for (let i = 0; i < tx.vout.length; i++) {
    if (i === escrowVout) continue;
    const a = addressFromScriptPubKey(tx.vout[i].scriptPubKey);
    if (!a) continue;
    const sats = btcToSats(tx.vout[i].value);
    outputBy.set(a, (outputBy.get(a) ?? 0) + sats);
  }

  let lender: string | null = null;
  let lenderInputSats = 0;
  inputBy.forEach((sats, addr) => {
    if (sats > lenderInputSats) {
      lenderInputSats = sats;
      lender = addr;
    }
  });
  if (!lender) return { kind: 'skip', reason: 'no-lender-input' };

  let borrower: string | null = null;
  let borrowerOutputSats = 0;
  outputBy.forEach((sats, addr) => {
    if (addr === lender) return;
    if (addr === escrowAddr) return;
    if (sats > borrowerOutputSats) {
      borrowerOutputSats = sats;
      borrower = addr;
    }
  });
  if (!borrower) return { kind: 'skip', reason: 'no-borrower-output' };
  if (borrower === lender) return { kind: 'skip', reason: 'self-spend' };

  const borrowerInputSats = inputBy.get(borrower) ?? 0;
  const loanAmountSats = Math.max(0, borrowerOutputSats - borrowerInputSats);
  if (loanAmountSats <= 0) return { kind: 'skip', reason: 'no-loan-flow' };

  return {
    kind: 'origination',
    txid: tx.txid,
    escrowAddr,
    lender,
    borrower,
    loanAmountSats,
    blockTimestamp: tx.blocktime ?? null,
    escrowVout,
  };
}

// ---------------- repayment trace ----------------

async function traceRepayment(
  unlockTx: RawTx,
  escrowVinIndex: number,
  lenderAddr: string,
  originationBlock: number | null,
  cache: TxCache
): Promise<{ txid: string; blockTimestamp: number | null; paymentSats: number } | null> {
  const seedTxids: string[] = [];
  for (let i = 0; i < unlockTx.vin.length; i++) {
    if (i === escrowVinIndex) continue;
    const v = unlockTx.vin[i];
    if (typeof v?.txid !== 'string') continue;
    seedTxids.push(v.txid);
  }
  if (seedTxids.length === 0) return null;

  let frontier = seedTxids.slice(0, MAX_BRANCHING_PER_LEVEL);
  const seen = new Set<string>();

  for (let hop = 0; hop < REPAYMENT_TRACE_MAX_HOPS; hop++) {
    const next: string[] = [];
    for (const txid of frontier) {
      if (seen.has(txid)) continue;
      seen.add(txid);
      let tx: RawTx;
      try {
        tx = await getRawTxCached(txid, cache);
      } catch {
        continue;
      }
      if (!tx || !Array.isArray(tx.vout)) continue;
      if (originationBlock != null && tx.blocktime != null && tx.blocktime < originationBlock) {
        continue;
      }
      for (const o of tx.vout) {
        const a = addressFromScriptPubKey(o.scriptPubKey);
        if (a === lenderAddr) {
          return {
            txid: tx.txid,
            blockTimestamp: tx.blocktime ?? null,
            paymentSats: btcToSats(o.value),
          };
        }
      }
      if (Array.isArray(tx.vin)) {
        for (const v of tx.vin) {
          if (typeof v?.txid === 'string') next.push(v.txid);
        }
      }
    }
    frontier = next.slice(0, MAX_BRANCHING_PER_LEVEL);
    if (frontier.length === 0) break;
  }
  return null;
}

// ---------------- tick driver ----------------

type EscrowInfo = {
  lender: string;
  borrower: string;
  loanAmountSats: number;
  originationTxid: string;
  originationBlock: number | null;
  inscriptionNumber: number;
  inscriptionId: string;
};

type LoansCursor = { last_event_id: number };

function readCursor(): LoansCursor {
  const db = getDb();
  const row = db
    .prepare(`SELECT last_cursor FROM poll_state WHERE stream='loans' AND collection_slug='omb'`)
    .get() as { last_cursor: string | null } | undefined;
  if (!row?.last_cursor) return { last_event_id: 0 };
  try {
    const parsed = JSON.parse(row.last_cursor) as Partial<LoansCursor>;
    if (typeof parsed.last_event_id === 'number') return { last_event_id: parsed.last_event_id };
  } catch {
    // fall through
  }
  return { last_event_id: 0 };
}

function writeCursor(cursor: LoansCursor, status: string, eventCount: number): void {
  const db = getDb();
  db.prepare(
    `UPDATE poll_state
       SET last_cursor      = @cursor,
           last_run_at      = @now,
           last_status      = @status,
           last_event_count = @count
     WHERE stream='loans' AND collection_slug='omb'`
  ).run({
    cursor: JSON.stringify(cursor),
    now: Math.floor(Date.now() / 1000),
    status,
    count: eventCount,
  });
}

export type LoanTickResult = {
  mode: 'loans';
  skipped?: 'not-configured';
  error?: string;
  scanned: number;
  defaults: number;
  originations: number;
  unlocks: number;
  repayments: number;
  cursor_advanced_to: number;
  budget_exhausted?: boolean;
};

export async function runLoanTick(
  opts: { maxEvents?: number; wallclockBudgetMs?: number } = {}
): Promise<LoanTickResult> {
  if (!bitcoindConfigured()) {
    return {
      mode: 'loans',
      skipped: 'not-configured',
      scanned: 0,
      defaults: 0,
      originations: 0,
      unlocks: 0,
      repayments: 0,
      cursor_advanced_to: 0,
    };
  }

  const cap = Math.min(opts.maxEvents ?? MAX_EVENTS_PER_TICK, MAX_EVENTS_PER_TICK);
  const budgetMs = opts.wallclockBudgetMs ?? TICK_WALLCLOCK_BUDGET_MS;
  const startedAt = Date.now();
  const overBudget = (): boolean => Date.now() - startedAt > budgetMs;

  // Probe bitcoind so we fail fast if unreachable, before doing any DB work.
  try {
    await getBlockchainTip();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error('poll/loans', 'bitcoind probe failed', { error: msg });
    writeCursor(readCursor(), `bitcoind-fail:${msg.slice(0, 80)}`, 0);
    return {
      mode: 'loans',
      error: msg,
      scanned: 0,
      defaults: 0,
      originations: 0,
      unlocks: 0,
      repayments: 0,
      cursor_advanced_to: readCursor().last_event_id,
    };
  }

  const cursor = readCursor();
  const db = getDb();

  // Pull new transferred events (id > cursor) up to the cap. Also include
  // already-classified loan-* rows whose id is past the cursor — they
  // shouldn't exist in normal operation (live writers only insert
  // 'transferred'), but if a backfill ran mid-tick we want to advance the
  // cursor past them rather than skipping.
  const targets = db
    .prepare(
      `SELECT id, inscription_id, inscription_number, txid, old_owner, new_owner,
              event_type, block_timestamp
         FROM events
        WHERE id > @cursor
          AND event_type IN ('transferred','loan-originated','loan-defaulted','loan-unlocked')
          AND old_owner != COALESCE(new_owner, '')
        ORDER BY id ASC
        LIMIT @cap`
    )
    .all({ cursor: cursor.last_event_id, cap }) as Array<{
    id: number;
    inscription_id: string;
    inscription_number: number;
    txid: string;
    old_owner: string | null;
    new_owner: string | null;
    event_type: string;
    block_timestamp: number;
  }>;

  if (targets.length === 0) {
    writeCursor(cursor, 'idle', 0);
    return {
      mode: 'loans',
      scanned: 0,
      defaults: 0,
      originations: 0,
      unlocks: 0,
      repayments: 0,
      cursor_advanced_to: cursor.last_event_id,
    };
  }

  // Dedupe by txid for classification — multi-inscription txs share a
  // classification but should write per-event upgrades.
  const txToEvents = new Map<string, typeof targets>();
  for (const t of targets) {
    const list = txToEvents.get(t.txid) ?? [];
    list.push(t);
    txToEvents.set(t.txid, list);
  }
  const uniqueTxids = Array.from(txToEvents.keys());

  const cache: TxCache = new Map();
  const defaults: Array<{ verdict: DefaultVerdict; events: typeof targets }> = [];
  const unlockCandidates: Array<{ verdict: UnlockCandidate; events: typeof targets }> = [];
  let scanned = 0;
  let highestProcessedId = cursor.last_event_id;

  // Phase 1: classify (sequential — bitcoind is local, ~1ms per call).
  for (const txid of uniqueTxids) {
    if (overBudget()) {
      log.warn('poll/loans', 'budget exhausted in classify', { processed: scanned });
      break;
    }
    try {
      const tx = await getRawTxCached(txid, cache);
      const verdict = classifySpendSide(tx);
      const events = txToEvents.get(txid)!;
      if (verdict.kind === 'default') {
        defaults.push({ verdict, events });
      } else if (verdict.kind === 'unlock-candidate') {
        unlockCandidates.push({ verdict, events });
      }
      // Advance the high-water mark only for txs we successfully classified
      // (skip + matched both count). RPC errors leave the cursor where it
      // was so the next tick retries.
      for (const ev of events) {
        if (ev.id > highestProcessedId) highestProcessedId = ev.id;
      }
      scanned++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn('poll/loans', 'classify failed', { txid: txid.slice(0, 16), error: msg });
      // Don't advance cursor past this event — retry next tick.
      break;
    }
  }

  // Phase 2: trace originations (defaults + unlock-candidates).
  const escrowMap = new Map<string, EscrowInfo>();
  const originations: Array<{
    origination: Origination & { inscriptionNumber: number; inscriptionId: string };
    source: 'default' | 'unlock';
  }> = [];
  const unlocks: Array<{ verdict: UnlockCandidate; events: typeof targets; escrowInfo: EscrowInfo }> = [];

  for (const d of defaults) {
    if (overBudget()) break;
    const orig = await traceOrigination(d.verdict.prevoutTxid, d.verdict.escrowAddr, cache);
    if (orig.kind !== 'origination') continue;
    const ev = d.events[0];
    const enriched = {
      ...orig,
      inscriptionNumber: ev.inscription_number,
      inscriptionId: ev.inscription_id,
    };
    originations.push({ origination: enriched, source: 'default' });
    escrowMap.set(orig.escrowAddr, {
      lender: orig.lender,
      borrower: orig.borrower,
      loanAmountSats: orig.loanAmountSats,
      originationTxid: orig.txid,
      originationBlock: orig.blockTimestamp,
      inscriptionNumber: enriched.inscriptionNumber,
      inscriptionId: enriched.inscriptionId,
    });
  }

  for (const uc of unlockCandidates) {
    if (overBudget()) break;
    let escrowInfo = escrowMap.get(uc.verdict.escrowAddr);
    if (!escrowInfo) {
      const orig = await traceOrigination(uc.verdict.prevoutTxid, uc.verdict.escrowAddr, cache);
      if (orig.kind !== 'origination') continue;
      const ev = uc.events[0];
      const enriched = {
        ...orig,
        inscriptionNumber: ev.inscription_number,
        inscriptionId: ev.inscription_id,
      };
      escrowInfo = {
        lender: orig.lender,
        borrower: orig.borrower,
        loanAmountSats: orig.loanAmountSats,
        originationTxid: orig.txid,
        originationBlock: orig.blockTimestamp,
        inscriptionNumber: enriched.inscriptionNumber,
        inscriptionId: enriched.inscriptionId,
      };
      escrowMap.set(orig.escrowAddr, escrowInfo);
      originations.push({ origination: enriched, source: 'unlock' });
    }
    unlocks.push({ verdict: uc.verdict, events: uc.events, escrowInfo });
  }

  // Phase 3: trace repayments for each unlock (best-effort).
  const repayments: Array<{
    unlockEntry: typeof unlocks[number];
    repayment: { txid: string; blockTimestamp: number | null; paymentSats: number };
  }> = [];
  for (const u of unlocks) {
    if (overBudget()) break;
    try {
      const tx = await getRawTxCached(u.verdict.txid, cache);
      const r = await traceRepayment(
        tx,
        u.verdict.vinIndex,
        u.escrowInfo.lender,
        u.escrowInfo.originationBlock,
        cache
      );
      if (r) repayments.push({ unlockEntry: u, repayment: r });
    } catch {
      // skip
    }
  }

  // ---- Write phase: one transaction for the whole tick. ----

  const stmts = {
    upgradeToDefault: db.prepare(`
      UPDATE events
         SET event_type = 'loan-defaulted',
             raw_json   = @raw_json
       WHERE inscription_id = @inscription_id
         AND txid           = @txid
         AND event_type     = 'transferred'
    `),
    upgradeToOrigination: db.prepare(`
      UPDATE events
         SET event_type = 'loan-originated',
             raw_json   = @raw_json
       WHERE inscription_id = @inscription_id
         AND txid           = @txid
         AND event_type     IN ('transferred','sold')
    `),
    upgradeToUnlock: db.prepare(`
      UPDATE events
         SET event_type = 'loan-unlocked',
             raw_json   = @raw_json
       WHERE inscription_id = @inscription_id
         AND txid           = @txid
         AND event_type     = 'transferred'
    `),
    insertRepaid: db.prepare(`
      INSERT OR IGNORE INTO events
        (inscription_id, inscription_number, event_type, block_timestamp,
         txid, old_owner, new_owner, raw_json)
      VALUES
        (@inscription_id, @inscription_number, 'loan-repaid', @block_timestamp,
         @txid, @borrower, @lender, @raw_json)
    `),
    onOrigination: db.prepare(`
      UPDATE inscriptions SET
        transfer_count    = MAX(transfer_count - 1, 0),
        loan_count        = loan_count + 1,
        active_loan_count = active_loan_count + 1,
        effective_owner   = @borrower
      WHERE inscription_number = @inscription_number
    `),
    onDefault: db.prepare(`
      UPDATE inscriptions SET
        transfer_count    = MAX(transfer_count - 1, 0),
        active_loan_count = MAX(active_loan_count - 1, 0),
        effective_owner   = @lender
      WHERE inscription_number = @inscription_number
    `),
    onUnlock: db.prepare(`
      UPDATE inscriptions SET
        transfer_count    = MAX(transfer_count - 1, 0),
        active_loan_count = MAX(active_loan_count - 1, 0),
        effective_owner   = current_owner
      WHERE inscription_number = @inscription_number
    `),
    // The notify queue's fan-out filter only selects 'transferred','sold','listed';
    // a row whose type we just upgraded to loan-* would otherwise sit in the
    // queue forever. Drop it explicitly so the queue stays bounded. When
    // loan-event notifications are wired in a follow-up, this will become
    // a re-enqueue instead.
    dequeueNotify: db.prepare(`DELETE FROM notify_pending WHERE event_id = @id`),
  };

  const writeStats = { defaults: 0, originations: 0, unlocks: 0, repayments: 0 };
  const writeAll = db.transaction(() => {
    // Originations FIRST so active_loan_count is bumped before any
    // default/unlock decrements it. Otherwise the MAX(x-1, 0) clamp would
    // eat the decrement (0→0) for inscriptions whose origination event is
    // processed in the same tick, leaving active_loan_count stuck at 1.
    for (const o of originations) {
      const orig = o.origination;
      const raw = JSON.stringify({
        source: 'onchain-loan-heuristic',
        confidence: 'high',
        loan_type: 'origination',
        escrow_addr: orig.escrowAddr,
        lender_addr: orig.lender,
        borrower_addr: orig.borrower,
        loan_amount_sats: orig.loanAmountSats,
        detector_version: DETECTOR_VERSION,
      });
      const u = stmts.upgradeToOrigination.run({
        inscription_id: orig.inscriptionId,
        txid: orig.txid,
        raw_json: raw,
      });
      if (u.changes > 0) {
        stmts.onOrigination.run({
          inscription_number: orig.inscriptionNumber,
          borrower: orig.borrower,
        });
        // Look up the upgraded event's id so we can dequeue from notify_pending.
        const evRow = db
          .prepare(`SELECT id FROM events WHERE inscription_id=@inscription_id AND txid=@txid`)
          .get({ inscription_id: orig.inscriptionId, txid: orig.txid }) as
          | { id: number }
          | undefined;
        if (evRow) stmts.dequeueNotify.run({ id: evRow.id });
        writeStats.originations++;
      }
    }

    for (const d of defaults) {
      const v = d.verdict;
      // borrower_addr is known when origination tracing succeeded for this
      // escrow earlier in this tick — including it on the default row lets
      // /holder/[borrower] surface "your loan defaulted" without a JOIN-walk
      // back to the origination event.
      const escrowInfo = escrowMap.get(v.escrowAddr);
      const raw = JSON.stringify({
        source: 'onchain-loan-heuristic',
        confidence: 'high',
        loan_type: 'default',
        escrow_addr: v.escrowAddr,
        lender_addr: v.lender,
        borrower_addr: escrowInfo?.borrower ?? null,
        timelock_value: v.timelock.number,
        timelock_kind: v.timelock.kind,
        timelock_opcode: v.timelock.opcode,
        prevout_txid: v.prevoutTxid,
        prevout_vout: v.prevoutVout,
        detector_version: DETECTOR_VERSION,
      });
      for (const ev of d.events) {
        const u = stmts.upgradeToDefault.run({
          inscription_id: ev.inscription_id,
          txid: ev.txid,
          raw_json: raw,
        });
        if (u.changes > 0) {
          stmts.onDefault.run({ inscription_number: ev.inscription_number, lender: v.lender });
          stmts.dequeueNotify.run({ id: ev.id });
          writeStats.defaults++;
        }
      }
    }

    for (const u of unlocks) {
      const info = u.escrowInfo;
      const raw = JSON.stringify({
        source: 'onchain-loan-heuristic',
        confidence: 'high',
        loan_type: 'unlock',
        escrow_addr: u.verdict.escrowAddr,
        lender_addr: info.lender,
        borrower_addr: info.borrower,
        loan_amount_sats: info.loanAmountSats,
        origination_txid: info.originationTxid,
        detector_version: DETECTOR_VERSION,
      });
      for (const ev of u.events) {
        const r = stmts.upgradeToUnlock.run({
          inscription_id: ev.inscription_id,
          txid: ev.txid,
          raw_json: raw,
        });
        if (r.changes > 0) {
          stmts.onUnlock.run({ inscription_number: ev.inscription_number });
          stmts.dequeueNotify.run({ id: ev.id });
          writeStats.unlocks++;
        }
      }
    }

    for (const r of repayments) {
      const info = r.unlockEntry.escrowInfo;
      const raw = JSON.stringify({
        source: 'onchain-loan-heuristic',
        confidence: 'medium',
        loan_type: 'repayment',
        escrow_addr: r.unlockEntry.verdict.escrowAddr,
        lender_addr: info.lender,
        borrower_addr: info.borrower,
        loan_amount_sats: info.loanAmountSats,
        payment_sats: r.repayment.paymentSats,
        unlock_txid: r.unlockEntry.verdict.txid,
        detector_version: DETECTOR_VERSION,
      });
      const ins = stmts.insertRepaid.run({
        inscription_id: info.inscriptionId,
        inscription_number: info.inscriptionNumber,
        block_timestamp: r.repayment.blockTimestamp ?? r.unlockEntry.verdict.blockTime,
        txid: r.repayment.txid,
        borrower: info.borrower,
        lender: info.lender,
        raw_json: raw,
      });
      if (ins.changes > 0) writeStats.repayments++;
    }
  });
  writeAll.immediate();

  const newCursor: LoansCursor = { last_event_id: highestProcessedId };
  writeCursor(newCursor, 'ok', scanned);

  const dur = Date.now() - startedAt;
  const budgetExhausted = dur > budgetMs;
  if (writeStats.defaults + writeStats.originations + writeStats.unlocks + writeStats.repayments > 0) {
    log.info('poll/loans', 'tick complete', {
      scanned,
      defaults: writeStats.defaults,
      originations: writeStats.originations,
      unlocks: writeStats.unlocks,
      repayments: writeStats.repayments,
      cursor: highestProcessedId,
      dur_ms: dur,
    });
  }

  return {
    mode: 'loans',
    scanned,
    defaults: writeStats.defaults,
    originations: writeStats.originations,
    unlocks: writeStats.unlocks,
    repayments: writeStats.repayments,
    cursor_advanced_to: highestProcessedId,
    ...(budgetExhausted ? { budget_exhausted: true } : {}),
  };
}
