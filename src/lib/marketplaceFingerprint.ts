// On-chain fingerprints for inferring marketplace from sale txs that
// arrived via the ord.net aggregator backfill (which doesn't disclose
// the originating marketplace, leaving `marketplace = NULL` in events).
//
// Each fingerprint is just a vout[1] fee-collector address that we've
// observed appearing repeatedly across OMB sale txs. If a sold-tagged
// event's funding tx puts vout[1] at one of these addresses, we infer
// the marketplace.
//
// These are inferred from on-chain pattern matching, not from any
// authoritative public registry. If a label here is wrong, fix the
// label (the address-to-marketplace mapping is what matters).

/**
 * Fee output observed in 57+ OMB sale txs over a single 30-day window
 * (2026-04 / 2026-05 sample). Always vout[1] of a 4-output tx where
 * vin[0] is the seller's P2TR. Fee values cluster ~8k–25k sats with a
 * mean ratio of ~0.7% of the seller payout — consistent with Magisat's
 * (Magic Eden Bitcoin) fee model.
 */
export const MAGISAT_FEE_ADDR =
  'bc1papmpmu0xzfvw4x9qe4jstgxfnfy5q8zhh6xredjxd86ca74uph3s59se9u';

type FeePosTx = {
  vout: Array<{ scriptPubKey?: { address?: string } }>;
};

/**
 * Returns the inferred marketplace key for a sale funding tx, or null
 * if no fingerprint matches. Pure shape lookup — caller owns whether
 * to write to the events table.
 */
export function inferMarketplaceFromTx(tx: FeePosTx): string | null {
  const vout1Addr = tx.vout[1]?.scriptPubKey?.address;
  if (vout1Addr === MAGISAT_FEE_ADDR) return 'magisat';
  return null;
}
