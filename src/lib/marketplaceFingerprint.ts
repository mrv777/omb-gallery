// Marketplace identification from raw bitcoin tx data.
//
// This is the SOLE source of marketplace tagging for non-legacy `sold` rows.
// Each rule below must satisfy ONCHAIN_TAGGING.md §1: chain-fingerprint tier
// requires ≥3 confirmed true positives and ≥1 confirmed true negative,
// documented in §6 of that file.
//
// Adding a new marketplace:
//   1. Collect ≥3 TP fixtures + ≥1 TN. Add them to scripts/known-transactions.json.
//   2. Update ONCHAIN_TAGGING.md §6.
//   3. Add a rule below.
//   4. Cite the doc in the commit message.

/** Minimal shape we accept — covers both bitcoind verbose=2 RPC and the
 * subset we serialize from mempool.space probes. */
export type FingerprintTx = {
  vin: Array<{
    prevout?: {
      scriptPubKey?: { address?: string; type?: string };
      // bitcoind verbose=2 also includes value (BTC) on prevout
      value?: number;
    };
    // bitcoind RPC names this `txinwitness`; we accept either.
    txinwitness?: string[];
    witness?: string[];
  }>;
  vout: Array<{
    scriptPubKey?: { address?: string; type?: string };
    value?: number;
  }>;
};

export type MarketplaceMatch = {
  marketplace: 'magisat';
  /**
   * Indexes of inputs whose 65-byte schnorr signature carried the
   * SIGHASH_SINGLE | ANYONECANPAY (0x83) flag. Each such input N commits to
   * vout[N] under SIGHASH_SINGLE — that vout is the seller's payment for
   * input N. Caller chooses which input is the seller (typically by matching
   * `events.old_owner` against `vin[N].prevout.scriptPubKey.address`).
   */
  acpInputs: number[];
};

// Magisat's fixed P2SH fee output. See ONCHAIN_TAGGING.md §2.7 for the
// derivation (14/14 confirmed Magisat OMB sales contain this address;
// confirmed-not-Magisat examples do not).
const MAGISAT_FEE_ADDRS = new Set<string>(['3Ke21osfhEbEryUeqdwAuAY8VKxm5B9uB2']);

/** Return the input indexes whose schnorr signature carries SIGHASH 0x83. */
function findAcpInputs(tx: FingerprintTx): number[] {
  const out: number[] = [];
  for (let i = 0; i < tx.vin.length; i++) {
    const w = tx.vin[i]?.txinwitness ?? tx.vin[i]?.witness ?? [];
    if (!w || w.length === 0) continue;
    // Schnorr sig with explicit sighash byte = 65 bytes = 130 hex chars,
    // last byte = 0x83 = SIGHASH_SINGLE | SIGHASH_ANYONECANPAY.
    const first = w[0];
    if (typeof first === 'string' && first.length === 130 && first.endsWith('83')) {
      out.push(i);
    }
  }
  return out;
}

/**
 * Identify the marketplace (if any) that settled a tx. Returns null when no
 * rule matches. Callers must extract sale price from `acpInputs` per the
 * SIGHASH_SINGLE rule above (or use the helper below).
 */
export function detectMarketplace(tx: FingerprintTx): MarketplaceMatch | null {
  if (!tx?.vin?.length || !tx?.vout?.length) return null;

  // Magisat: fixed fee output + at least one ACP-signed input.
  const hasMagisatFee = tx.vout.some(v => {
    const a = v?.scriptPubKey?.address;
    return !!a && MAGISAT_FEE_ADDRS.has(a);
  });
  if (hasMagisatFee) {
    const acp = findAcpInputs(tx);
    if (acp.length > 0) {
      return { marketplace: 'magisat', acpInputs: acp };
    }
  }

  return null;
}

/**
 * Given a marketplace match and the seller's address, return the sale price
 * in sats (sum of vout[N].value for each ACP input N whose prevout address
 * equals `sellerAddress`). Returns null when no ACP input maps to the seller
 * (caller should treat as `marketplace=magisat, sale_price_sats=null` rather
 * than misattributing).
 */
export function extractSalePriceSats(
  tx: FingerprintTx,
  match: MarketplaceMatch,
  sellerAddress: string
): number | null {
  let totalBtc = 0;
  let matched = 0;
  for (const idx of match.acpInputs) {
    const vin = tx.vin[idx];
    if (!vin) continue;
    const prevAddr = vin.prevout?.scriptPubKey?.address;
    if (prevAddr !== sellerAddress) continue;
    const vout = tx.vout[idx];
    if (!vout || typeof vout.value !== 'number') continue;
    totalBtc += vout.value;
    matched++;
  }
  if (matched === 0) return null;
  return Math.round(totalBtc * 1e8);
}
