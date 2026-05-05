// Liquidium modern instant-loan resolution fingerprint.
//
// Companion to liquidiumOriginationFingerprint.ts — that file detects the
// origination tx (escrow created); this one detects the spend that closes the
// loan. Two resolution paths share a single tap-tree internal pubkey.
//
// ONCHAIN_TAGGING.md §2.5.

export type ResolutionFingerprintTx = {
  vin: Array<{
    prevout?: {
      scriptPubKey?: { address?: string; type?: string };
      scriptpubkey_address?: string;
      scriptpubkey_type?: string;
      value?: number;
    };
    txinwitness?: string[];
    witness?: string[];
  }>;
  vout: Array<{
    scriptPubKey?: { address?: string; type?: string };
    scriptpubkey_address?: string;
    scriptpubkey_type?: string;
    value?: number;
  }>;
};

export type LiquidiumResolutionKind = 'repaid' | 'defaulted' | 'unlocked';

export type LiquidiumResolutionMatch = {
  kind: 'liquidium-modern-resolution';
  resolution: LiquidiumResolutionKind;
  escrowAddress: string;
  destinationAddress: string | null;
  leafScriptHex: string;
};

// Single internal pubkey shared by every modern Liquidium tap-tree we have
// seen. Empirically verified across the full population of 220 closed
// resolutions on the OMB collection (171 repay + 49 default candidates) at
// detector promotion time. Distinct from the legacy Liquidium internal pubkey
// `9367…d27a` used by Phase 4 — that one fingerprints OP_CSV+OP_DROP single-
// pubkey leaves and does not match modern instant loans.
const LIQUIDIUM_MODERN_INTERNAL_PUBKEY =
  '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0';

// Liquidium activation/fee output that appears in every modern repay tx but
// not in defaults. Used as a corroborating signal, not the primary check.
const LIQUIDIUM_ACTIVATION_FEE_ADDR =
  'bc1papmpmu0xzfvw4x9qe4jstgxfnfy5q8zhh6xredjxd86ca74uph3s59se9u';

function addressOf(
  output:
    | {
        address?: string;
        scriptpubkey_address?: string;
        scriptPubKey?: { address?: string; addresses?: string[] };
      }
    | undefined
): string | null {
  return (
    output?.address ??
    output?.scriptpubkey_address ??
    output?.scriptPubKey?.address ??
    output?.scriptPubKey?.addresses?.[0] ??
    null
  );
}

function typeOf(
  output:
    | {
        type?: string;
        scriptpubkey_type?: string;
        scriptPubKey?: { type?: string };
      }
    | undefined
): string | null {
  return output?.type ?? output?.scriptpubkey_type ?? output?.scriptPubKey?.type ?? null;
}

function isP2trType(t: string | null): boolean {
  return t === 'v1_p2tr' || t === 'witness_v1_taproot';
}

function witnessOf(vin: ResolutionFingerprintTx['vin'][number]): string[] {
  return vin.txinwitness ?? vin.witness ?? [];
}

// Control block bytes 1..33 = 32-byte schnorr internal pubkey. Length must be
// 33 + 32*N for a depth-N merkle path. We have only ever seen depth-2 (97
// bytes / 194 hex chars) for modern Liquidium, but the parser tolerates other
// depths so a future leaf-tree extension doesn't silently break detection.
function parseControlBlock(
  hex: string
): { internalPubkey: string; depth: number } | null {
  if (typeof hex !== 'string' || hex.length < 66) return null;
  const cbBytes = hex.length / 2;
  if ((cbBytes - 33) % 32 !== 0) return null;
  const firstByte = parseInt(hex.slice(0, 2), 16);
  if (firstByte !== 0xc0 && firstByte !== 0xc1) return null;
  return {
    internalPubkey: hex.slice(2, 66).toLowerCase(),
    depth: (cbBytes - 33) / 32,
  };
}

// Repay leaf shape:
//   <push 32-byte pkA> OP_CHECKSIGVERIFY
//   <push 32-byte pkB> OP_CHECKSIGVERIFY
//   <push 66-byte ASCII outpoint marker>
// Total length is 1+32+1 + 1+32+1 + 1+66 = 135 bytes (270 hex chars). The
// trailing 66-byte ASCII string is the inscription's previous outpoint
// (`<txid>:<vout>`), which Liquidium uses to bind the leaf to one specific
// inscription so two loans can never share a tap-tree by accident.
function isRepayLeaf(leafHex: string): boolean {
  // Hex offsets for: push32 || pkA || OP_CHECKSIGVERIFY || push32 || pkB ||
  // OP_CHECKSIGVERIFY || push66 || ascii. Total = 2+64+2+2+64+2+2+132 = 270.
  if (typeof leafHex !== 'string' || leafHex.length !== 270) return false;
  if (leafHex.slice(0, 2) !== '20') return false; // push 32 bytes (pkA)
  if (leafHex.slice(66, 68) !== 'ad') return false; // OP_CHECKSIGVERIFY
  if (leafHex.slice(68, 70) !== '20') return false; // push 32 bytes (pkB)
  if (leafHex.slice(134, 136) !== 'ad') return false; // OP_CHECKSIGVERIFY
  if (leafHex.slice(136, 138) !== '42') return false; // push 66 bytes (0x42)
  return true;
}

// Default leaf shape (CSV-gated lender claim):
//   <push N-byte timelock> OP_CHECKSEQUENCEVERIFY OP_DROP
//   <push 32-byte pkA> OP_CHECKSIGVERIFY
//   <push 32-byte pkB> OP_CHECKSIG
// We don't decode the timelock here — Phase 4's parseLoanDefaultLeaf does that
// for the legacy single-key path; modern default is two-key after CSV.
function hasDefaultLeafMarker(leafHex: string): boolean {
  // OP_CSV (b2) + OP_DROP (75) appearing as adjacent bytes is unique to the
  // default path.
  return typeof leafHex === 'string' && leafHex.toLowerCase().includes('b275');
}

function hasLiquidiumActivationOutput(tx: ResolutionFingerprintTx): boolean {
  for (const out of tx.vout) {
    if (addressOf(out) === LIQUIDIUM_ACTIVATION_FEE_ADDR) return true;
  }
  return false;
}

export function detectLiquidiumModernResolution(
  tx: ResolutionFingerprintTx
): LiquidiumResolutionMatch | null {
  if (!Array.isArray(tx.vin) || !Array.isArray(tx.vout) || tx.vin.length === 0) return null;

  const vin0 = tx.vin[0];
  if (!vin0) return null;

  const witness = witnessOf(vin0);
  // Script-path spend has at minimum [..., script, control-block]. Modern
  // Liquidium leaves push two schnorr sigs first, so we expect 4 elements,
  // but require only the trailing two so a future witness-layout tweak
  // (e.g. annex) doesn't break detection.
  if (witness.length < 2) return null;

  if (!isP2trType(typeOf(vin0.prevout))) return null;
  const escrowAddress = addressOf(vin0.prevout);
  if (!escrowAddress) return null;

  const controlBlockHex = witness[witness.length - 1];
  const leafScriptHex = witness[witness.length - 2];
  if (typeof controlBlockHex !== 'string' || typeof leafScriptHex !== 'string') return null;

  const cb = parseControlBlock(controlBlockHex);
  if (!cb) return null;
  if (cb.internalPubkey !== LIQUIDIUM_MODERN_INTERNAL_PUBKEY) return null;

  const destinationAddress = addressOf(tx.vout[0]);

  let resolution: LiquidiumResolutionKind;
  if (hasDefaultLeafMarker(leafScriptHex)) {
    resolution = 'defaulted';
  } else if (isRepayLeaf(leafScriptHex) && hasLiquidiumActivationOutput(tx)) {
    resolution = 'repaid';
  } else {
    // Internal pubkey matches Liquidium but neither leaf shape matches — a
    // future leaf or a malformed witness. Surface as 'unlocked' so the
    // active_loan_count is decremented; raw_json preserves the leaf hex for
    // post-hoc analysis.
    resolution = 'unlocked';
  }

  return {
    kind: 'liquidium-modern-resolution',
    resolution,
    escrowAddress,
    destinationAddress,
    leafScriptHex: leafScriptHex.toLowerCase(),
  };
}

export const LIQUIDIUM_MODERN_INTERNAL_PUBKEY_FOR_TEST = LIQUIDIUM_MODERN_INTERNAL_PUBKEY;
export const LIQUIDIUM_ACTIVATION_FEE_ADDR_FOR_TEST = LIQUIDIUM_ACTIVATION_FEE_ADDR;
