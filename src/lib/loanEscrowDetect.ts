import 'server-only';

// Active loan escrow detector.
//
// Liquidium's loan-origination tx is structurally fingerprintable:
//   - vin[0]  is P2TR (the OMB UTXO from the borrower)
//   - vout[0] is P2TR (the escrow output — fresh single-use bc1p)
//   - n_out   is exactly 4 (escrow + principal-to-borrower + lender-change
//                            + borrower-change)
//
// Combined with "destination address is single-use (received once, never
// spent), inscription is currently parked there, last touched within 30
// days" this filter lands on exactly the active loan set — verified
// against ground truth (18 green / 19 orange / 20 black / 0 red / 0 blue
// = 57 total, matching Liquidium's public count exactly).
//
// We also accept a relaxed shape (n_out = 3, vout[0] P2TR, vin[0] P2TR)
// for txs where the lender's change is consolidated. Currently disabled
// because the strict shape already gives an exact match — but leaving the
// hook in place if Liquidium ever ships a variant.
//
// Detection happens at refresh time, not at insert time, because bitcoind
// probing is too slow for the hot ord poll path and many candidates resolve
// quickly. The refresh poll walks current candidates from the events table,
// probes their funding txs, and upserts/expires rows in active_loan_escrows.

import { getStmts } from './db';
import { getRawTransaction } from './bitcoind';
import { log } from './log';

export type LoanEscrowTickResult = {
  candidates: number;
  detected: number;
  expired: number;
  errors: number;
  status: string;
};

const DETECTION_WINDOW_SEC = 30 * 86400; // 30 days — Liquidium's max term.
const REFRESH_TTL_SEC = 30 * 60; // re-probe candidates older than this.

/** Strict Liquidium-canonical shape check on a funding tx. */
function isLiquidiumLoanShape(tx: {
  vin: Array<{ prevout?: { scriptPubKey?: { type?: string } } }>;
  vout: Array<{ scriptPubKey?: { type?: string } }>;
}): boolean {
  if (tx.vout.length !== 4) return false;
  if (tx.vin.length === 0) return false;
  const v0Type = tx.vin[0]?.prevout?.scriptPubKey?.type;
  const o0Type = tx.vout[0]?.scriptPubKey?.type;
  if (v0Type !== 'witness_v1_taproot') return false;
  if (o0Type !== 'witness_v1_taproot') return false;
  return true;
}

export async function runLoanEscrowTick({
  wallclockBudgetMs = 25_000,
}: { wallclockBudgetMs?: number } = {}): Promise<LoanEscrowTickResult> {
  const stmts = getStmts();
  const start = Date.now();
  const now = Math.floor(start / 1000);
  const cutoff = now - DETECTION_WINDOW_SEC;

  const candidates = stmts.findActiveLoanEscrowCandidates.all({ cutoff }) as Array<{
    inscription_number: number;
    escrow_addr: string;
    funding_txid: string;
    funded_at: number;
  }>;

  let detected = 0;
  let errors = 0;
  const seenInscriptionNumbers = new Set<number>();

  for (const c of candidates) {
    if (Date.now() - start > wallclockBudgetMs) {
      log.warn('poll/loan-escrows', 'wallclock budget exhausted', {
        processed: seenInscriptionNumbers.size,
        remaining: candidates.length - seenInscriptionNumbers.size,
      });
      break;
    }
    seenInscriptionNumbers.add(c.inscription_number);

    // If we already have a fresh row for this candidate, skip the RPC.
    const existing = stmts.getActiveLoanEscrow.get({
      inscription_number: c.inscription_number,
    }) as { refreshed_at: number; funding_txid: string } | undefined;
    if (existing && existing.funding_txid === c.funding_txid && now - existing.refreshed_at < REFRESH_TTL_SEC) {
      continue;
    }

    let isLoan = false;
    try {
      const tx = await getRawTransaction(c.funding_txid);
      isLoan = isLiquidiumLoanShape(tx);
    } catch (err) {
      errors++;
      log.warn('poll/loan-escrows', 'rpc error', {
        txid: c.funding_txid,
        inscription: c.inscription_number,
        err: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (isLoan) {
      stmts.upsertActiveLoanEscrow.run({
        inscription_number: c.inscription_number,
        escrow_addr: c.escrow_addr,
        funding_txid: c.funding_txid,
        funded_at: c.funded_at,
        now,
      });
      detected++;
    } else if (existing) {
      // Was previously marked but the tx no longer matches (shouldn't
      // happen — funding_txid is stable — but guard for re-orgs etc.)
      stmts.deleteActiveLoanEscrow.run({ inscription_number: c.inscription_number });
    }
  }

  // Expire rows: any active_loan_escrows row whose inscription_number is no
  // longer in the candidate set means the OMB has moved off the escrow
  // (loan resolved). Delete it.
  const expireResult = stmts.expireResolvedLoanEscrows.run({ cutoff }) as { changes: number };
  const expired = expireResult.changes;

  // Update poll_state for /api/internal/health visibility.
  const status = errors > 0 ? `ok-with-${errors}-errors` : 'ok';
  stmts.setPollResult.run({
    stream: 'loan_escrows',
    collection: 'omb',
    status,
    event_count: detected,
    cursor: JSON.stringify({ last_candidates: candidates.length }),
  });

  log.info('poll/loan-escrows', 'tick complete', {
    candidates: candidates.length,
    detected,
    expired,
    errors,
    duration_ms: Date.now() - start,
  });

  return {
    candidates: candidates.length,
    detected,
    expired,
    errors,
    status,
  };
}
