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

// Magic Eden on-chain fee outputs. See ONCHAIN_TAGGING.md §2.10.
//
// `bc1qcq2uv5n…m9scjxc2` (P2WPKH) — primary. 8 user-confirmed ME OMB sales
// spanning blocks 796440 → 886371 (~16 months); ~2.5% of seller payment.
//
// `3P4WqXDb…vtQ` (P2SH) — secondary, promoted 2026-05-05. 2 user-confirmed
// ME TPs anchor it; on-chain probe found 2,163 candidate txs that carry it,
// all matching ME PSBT shapes (4-in/7-out ACP or 2-in/4-out cooperative),
// concentrated in a tight Dec 2023 → May 2024 window (textbook signature of
// a rotated-out fee address). Zero co-occurrence with the primary ME fee
// or with the 283 Satflow + 21 Magisat tagged fixtures in our corpus —
// strong mutual-exclusion across all known marketplaces. Promoted on shape
// + time-concentration + mutual-exclusion evidence; no direct UI
// verification possible (ME UI deprecated).
const MAGIC_EDEN_FEE_ADDRS = new Set<string>([
  'bc1qcq2uv5nk6hec6kvag3wyevp6574qmsm9scjxc2',
  '3P4WqXDbSLRhzo2H6MT6YFbvBKBDPLbVtQ',
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

// Heuristics for the cooperative-shape extractor.
//
// POSTAGE_THRESHOLD_SATS: any output ≤ this value is treated as inscription
// postage, not a payment. OMB inscriptions move with 600 / 900 / 999 / 10_000
// / 12_000 sat dust outputs in our corpus. 12_000 is chosen as the line.
//
// MIN_PAYMENT_SATS: seller payments below this floor are rejected as
// implausible. Real OMB sales have always been ≫ 0.0005 BTC; under-floor
// reads almost always indicate the extractor landed on a postage output.
const POSTAGE_THRESHOLD_SATS = 12_000;
const MIN_PAYMENT_SATS = 50_000;

/**
 * Extract the seller's BTC payment from a matched tx.
 *
 * - **Magisat / Magic Eden ACP shape:** SIGHASH_SINGLE commits input N's
 *   signature to output N. Sum `vout[N].value` for each ACP input N whose
 *   prevout address equals `sellerAddress`. ACP is per-input-correct even in
 *   bulk buys, so no extra gating is needed.
 * - **Magic Eden cooperative shape:** the per-fixture layout in §6.6 puts
 *   the seller payment at `vout[feeVoutIdx - 1]` for single-inscription
 *   sales. Multi-inscription bulk buys break that rule — the fee can sit
 *   between dest outputs and seller payments, so `vout[feeVoutIdx-1]` lands
 *   on a postage output (returns 999/900) or aggregates multiple sales
 *   (returns the combined price). Two structural gates keep us safe:
 *
 *     1. **Postage-output gate:** if `vout[feeVoutIdx-1].value` is ≤ the
 *        postage threshold or below the minimum-payment floor, return null.
 *     2. **Bulk-buy gate:** count outputs in `vout[0..feeVoutIdx-1]` that
 *        look like inscription postage (value ≤ POSTAGE_THRESHOLD_SATS). If
 *        ≥2, the tx is a multi-inscription bulk buy and we can't safely
 *        attribute the per-inscription seller payment from on-chain
 *        structure alone — return null.
 *
 *   Returning null lets the caller still tag the marketplace; downstream
 *   queries for sale price simply skip rows where `sale_price_sats IS NULL`.
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
    const sats = Math.round(v.value * 1e8);

    // Postage-output gate.
    if (sats < MIN_PAYMENT_SATS) return null;

    // Bulk-buy gate: count postage-sized outputs that precede the fee.
    let postageCount = 0;
    for (let i = 0; i < match.feeVoutIdx; i++) {
      const vi = tx.vout[i];
      if (!vi || typeof vi.value !== 'number') continue;
      if (Math.round(vi.value * 1e8) <= POSTAGE_THRESHOLD_SATS) postageCount++;
    }
    if (postageCount >= 2) return null;

    return sats;
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
