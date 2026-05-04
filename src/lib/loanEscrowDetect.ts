import 'server-only';

// Active loan escrow detector — high-precision only.
//
// Background: an earlier version used the loose fingerprint
// "vin[0]=P2TR + vout[0]=P2TR + n_out=4 + single-use destination + 30d
// window". That signature also matches Magisat-style marketplace sales
// (buyer + fee + seller payout + buyer change), so the table was
// dominated by false positives — verified empirically: 32/33 of the
// "loans" found that way had vout[1] going to the same recurring
// marketplace fee collector address rather than to the borrower.
//
// What we keep is the one shape we can verify with high confidence
// from the funding tx alone:
//
//   4-out borrower-self-funded loan
//     vin[0]:  P2TR (the OMB UTXO from the borrower)
//     vout[0]: P2TR (escrow — fresh single-use bc1p)
//     vout[1]: P2TR back to vin[0]'s address (principal returned to
//              the borrower at the same P2TR address it came from)
//     vout[1].value >= MIN_PRINCIPAL_SATS (real principal, not dust)
//
// What we explicitly do NOT try to detect (precision over recall):
//   - 2-in/2-out borrower-solo-lock (modern Liquidium pattern):
//     structurally indistinguishable from a plain cold-storage move
//     to a fresh P2TR. Without the eventual script-path spend (which
//     reveals the OP_CSV+pubkey leaf) we cannot tell them apart.
//   - Legacy 3PizFz9-lender 4-out shape: that issuer pattern is dead
//     in 2026; new loans don't take that form.
//
// As a result this detector under-counts active loans. The honest
// trade-off: we'd rather show fewer real loans than 30+ false sales.
// If we ever get a Liquidium API key, the right move is to populate
// active_loan_escrows from their /loans endpoint and retire the
// on-chain heuristic.
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
const MIN_PRINCIPAL_SATS = 100_000; // 0.001 BTC — exclude dust patterns.

/**
 * High-precision loan shape check: 4-out borrower-self-funded.
 *
 * The borrower's P2TR (vin[0]) hosts the OMB. The escrow goes to vout[0]
 * (P2TR, fresh). The loan principal returns to the *same* P2TR address
 * at vout[1]. Marketplace sales fail this last check because vout[1] is
 * a marketplace fee output, not the seller's address.
 */
function isLiquidiumLoanShape(tx: {
  vin: Array<{ prevout?: { scriptPubKey?: { type?: string; address?: string } } }>;
  vout: Array<{ scriptPubKey?: { type?: string; address?: string }; value?: number }>;
}): boolean {
  if (tx.vout.length !== 4) return false;
  if (tx.vin.length === 0) return false;

  const vin0 = tx.vin[0]?.prevout?.scriptPubKey;
  const vout0 = tx.vout[0]?.scriptPubKey;
  const vout1 = tx.vout[1];
  if (vin0?.type !== 'witness_v1_taproot') return false;
  if (vout0?.type !== 'witness_v1_taproot') return false;
  if (vout1?.scriptPubKey?.type !== 'witness_v1_taproot') return false;

  const borrower = vin0.address;
  const principalDest = vout1.scriptPubKey.address;
  if (!borrower || !principalDest || borrower !== principalDest) return false;

  // bitcoin-cli reports value in BTC as a float — convert to sats.
  const principalSats = Math.round(((vout1.value ?? 0) as number) * 1e8);
  if (principalSats < MIN_PRINCIPAL_SATS) return false;

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
