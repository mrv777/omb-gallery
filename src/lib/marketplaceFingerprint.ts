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

export type MarketplaceMatch =
  | {
      marketplace: 'magisat';
      shape: 'acp';
      /**
       * Indexes of inputs whose 65-byte schnorr signature carried the
       * SIGHASH_SINGLE | ANYONECANPAY (0x83) flag. Each such input N commits
       * to vout[N] under SIGHASH_SINGLE — that vout is the seller's payment
       * for input N. Caller chooses which input is the seller (typically by
       * matching `events.old_owner` against `vin[N].prevout.scriptPubKey.address`).
       */
      acpInputs: number[];
    }
  | {
      marketplace: 'magic-eden';
      shape: 'acp';
      acpInputs: number[];
      /** Index of the vout that paid the ME fee address. */
      feeVoutIdx: number;
    }
  | {
      marketplace: 'magic-eden';
      shape: 'cooperative';
      acpInputs: [];
      /** Index of the vout that paid the ME fee address. */
      feeVoutIdx: number;
    };

// Magisat's fixed P2SH fee output. See ONCHAIN_TAGGING.md §2.7 for the
// derivation (14/14 confirmed Magisat OMB sales contain this address;
// confirmed-not-Magisat examples do not).
const MAGISAT_FEE_ADDRS = new Set<string>(['3Ke21osfhEbEryUeqdwAuAY8VKxm5B9uB2']);

// Magic Eden's primary on-chain fee output (P2WPKH). See ONCHAIN_TAGGING.md
// §2.10. Recurs across 8 confirmed ME OMB sales spanning blocks 796440 →
// 886371 (~16 months); ~2.5% of seller payment. Mutual-exclusion checked
// against 3 Magisat fixtures. The secondary candidate `3P4Wq…` (P2SH, 2
// fixtures from spring 2024) is documented in §2.10 but NOT promoted to the
// live rule pending an explicit TN — those rows continue to fingerprint-miss
// at runtime and are picked up only when `3P4Wq…` is added here.
const MAGIC_EDEN_FEE_ADDRS = new Set<string>([
  'bc1qcq2uv5nk6hec6kvag3wyevp6574qmsm9scjxc2',
]);

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

function findFeeVoutIdx(tx: FingerprintTx, addrs: Set<string>): number {
  for (let i = 0; i < tx.vout.length; i++) {
    const a = tx.vout[i]?.scriptPubKey?.address;
    if (a && addrs.has(a)) return i;
  }
  return -1;
}

/**
 * Identify the marketplace (if any) that settled a tx. Returns null when no
 * rule matches. Callers extract sale price via `extractSalePriceSats`.
 */
export function detectMarketplace(tx: FingerprintTx): MarketplaceMatch | null {
  if (!tx?.vin?.length || !tx?.vout?.length) return null;

  // Magisat: fixed fee output + at least one ACP-signed input.
  const magisatFeeIdx = findFeeVoutIdx(tx, MAGISAT_FEE_ADDRS);
  if (magisatFeeIdx >= 0) {
    const acp = findAcpInputs(tx);
    if (acp.length > 0) {
      return { marketplace: 'magisat', shape: 'acp', acpInputs: acp };
    }
  }

  // Magic Eden: fixed fee output. Two on-chain shapes share the address —
  // (a) PSBT listing with ACP signature on the inscription input (modern
  // 4-in/7-out shape), (b) cooperative SIGHASH_ALL where both parties
  // co-sign atomically. We always tag, falling back to 'cooperative' when
  // there's no ACP signature.
  const meFeeIdx = findFeeVoutIdx(tx, MAGIC_EDEN_FEE_ADDRS);
  if (meFeeIdx >= 0) {
    const acp = findAcpInputs(tx);
    if (acp.length > 0) {
      return { marketplace: 'magic-eden', shape: 'acp', acpInputs: acp, feeVoutIdx: meFeeIdx };
    }
    return {
      marketplace: 'magic-eden',
      shape: 'cooperative',
      acpInputs: [],
      feeVoutIdx: meFeeIdx,
    };
  }

  return null;
}

/**
 * Extract the seller's BTC payment from a matched tx.
 *
 * - **Magisat / Magic Eden ACP shape:** SIGHASH_SINGLE commits input N's
 *   signature to output N. Sum `vout[N].value` for each ACP input N whose
 *   prevout address equals `sellerAddress`.
 * - **Magic Eden cooperative shape:** the fixed layout puts the seller
 *   payment at `vout[feeVoutIdx - 1]` across every fixture in §6.6; we use
 *   that directly. Defaults to null when the implied index points to the
 *   inscription destination (vout[0]) — that's the no-payment delivery-leg
 *   shape from #11273300, NOT a real sale and we shouldn't tag a price.
 *
 * Returns null when no payment can be extracted (caller should treat as
 * `marketplace=<x>, sale_price_sats=null` rather than misattributing).
 */
export function extractSalePriceSats(
  tx: FingerprintTx,
  match: MarketplaceMatch,
  sellerAddress: string
): number | null {
  if (match.shape === 'cooperative') {
    const idx = match.feeVoutIdx - 1;
    if (idx <= 0) return null;
    const v = tx.vout[idx];
    if (!v || typeof v.value !== 'number') return null;
    return Math.round(v.value * 1e8);
  }

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
