// Liquidium instant-loan origination fingerprint.
//
// All match kinds anchor on the same strong gates (Liquidium activation-fee
// address at vout[1], P2WSH lender vault at vout[3] with 1-of-2 multisig
// witness on every non-collateral input, P2TR collateral=escrow value
// preservation). The matchKind labels the borrower-payout variant so the
// caller can reason about confidence: strict-p2sh / variant-p2tr are the
// historical promoted shapes; relaxed-p2sh / relaxed-p2wpkh /
// relaxed-p2tr-bigvin are loosened cases that the call site can elevate to
// high confidence when the lender vault is in the known-vault set, or hold
// at medium otherwise. ONCHAIN_TAGGING.md §2.4.

export type LoanOriginationFingerprintTx = {
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

export type LiquidiumOriginationMatchKind =
  | 'strict-p2sh'
  | 'variant-p2tr'
  | 'relaxed-p2sh'
  | 'relaxed-p2wpkh'
  | 'relaxed-p2tr-bigvin'
  // Buy-and-borrow combo: a Satflow purchase and a Liquidium origination
  // settled atomically in one tx. Has extra outputs (seller payout, buyer
  // change, marketplace fees) so it never matches the fixed-position shapes
  // above; detected separately by detectLiquidiumBuyBorrowCombo.
  | 'combo-buy-borrow';

export type LiquidiumOriginationCandidate = {
  kind: 'liquidium-origination-candidate';
  matchKind: LiquidiumOriginationMatchKind;
  collateralAddress: string;
  escrowAddress: string;
  activationFeeAddress: string;
  borrowerPayoutAddress: string;
  lenderVaultAddress: string;
  principalSats: number;
  activationFeeSats: number;
};

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

function valueSats(
  output:
    | {
        scriptPubKey?: { address?: string; type?: string };
        scriptpubkey_address?: string;
        value?: number;
      }
    | undefined
): number {
  const v = output?.value ?? 0;
  // mempool.space returns integer sats; bitcoind verbose=2 returns BTC.
  return output && 'scriptpubkey_address' in output && Number.isInteger(v)
    ? Math.round(v)
    : Math.round(v * 1e8);
}

function isP2trType(t: string | null): boolean {
  return t === 'v1_p2tr' || t === 'witness_v1_taproot';
}

function isP2wshType(t: string | null): boolean {
  return t === 'v0_p2wsh' || t === 'witness_v0_scripthash';
}

function isP2shType(t: string | null): boolean {
  return t === 'p2sh' || t === 'scripthash';
}

function isP2wpkhType(t: string | null): boolean {
  return t === 'v0_p2wpkh' || t === 'witness_v0_keyhash';
}

function witnessOf(vin: LoanOriginationFingerprintTx['vin'][number]): string[] {
  return vin.txinwitness ?? vin.witness ?? [];
}

function isOneOfTwoMultisigWitness(vin: LoanOriginationFingerprintTx['vin'][number]): boolean {
  const witnessScript = witnessOf(vin).at(-1);
  if (typeof witnessScript !== 'string') return false;
  // OP_1 OP_PUSHBYTES_33 <pubkey> OP_PUSHBYTES_33 <pubkey> OP_2 OP_CHECKMULTISIG.
  return /^5121[0-9a-f]{66}21[0-9a-f]{66}52ae$/i.test(witnessScript);
}

export function detectLiquidiumOriginationCandidate(
  tx: LoanOriginationFingerprintTx
): LiquidiumOriginationCandidate | null {
  if (!Array.isArray(tx.vin) || !Array.isArray(tx.vout)) return null;
  if (tx.vin.length < 2 || tx.vout.length !== 4) return null;

  const collateralIn = tx.vin[0]?.prevout;
  const escrowOut = tx.vout[0];
  const feeOut = tx.vout[1];
  const payoutOut = tx.vout[2];
  const changeOut = tx.vout[3];

  const collateralAddress = addressOf(collateralIn);
  const escrowAddress = addressOf(escrowOut);
  const feeAddress = addressOf(feeOut);
  const borrowerPayoutAddress = addressOf(payoutOut);
  const lenderVaultAddress = addressOf(changeOut);

  if (!collateralAddress || !escrowAddress || !borrowerPayoutAddress || !lenderVaultAddress) {
    return null;
  }
  if (!isP2trType(typeOf(collateralIn)) || !isP2trType(typeOf(escrowOut))) return null;
  if (valueSats(collateralIn) !== valueSats(escrowOut)) return null;
  if (feeAddress !== LIQUIDIUM_ACTIVATION_FEE_ADDR) return null;
  if (!isP2wshType(typeOf(changeOut))) return null;

  const payoutType = typeOf(payoutOut);
  const vinCount = tx.vin.length;
  let matchKind: LiquidiumOriginationMatchKind;
  if (vinCount >= 3 && isP2shType(payoutType)) {
    matchKind = 'strict-p2sh';
  } else if (vinCount <= 4 && isP2trType(payoutType)) {
    matchKind = 'variant-p2tr';
  } else if (vinCount === 2 && isP2shType(payoutType)) {
    matchKind = 'relaxed-p2sh';
  } else if (isP2wpkhType(payoutType)) {
    matchKind = 'relaxed-p2wpkh';
  } else if (vinCount > 4 && isP2trType(payoutType)) {
    matchKind = 'relaxed-p2tr-bigvin';
  } else {
    return null;
  }

  for (const vin of tx.vin.slice(1)) {
    const prevout = vin.prevout;
    if (addressOf(prevout) !== lenderVaultAddress) return null;
    if (!isP2wshType(typeOf(prevout))) return null;
    if (!isOneOfTwoMultisigWitness(vin)) return null;
  }

  return {
    kind: 'liquidium-origination-candidate',
    matchKind,
    collateralAddress,
    escrowAddress,
    activationFeeAddress: feeAddress,
    borrowerPayoutAddress,
    lenderVaultAddress,
    principalSats: valueSats(payoutOut),
    activationFeeSats: valueSats(feeOut),
  };
}

export type LiquidiumBuyBorrowComboCandidate = {
  kind: 'liquidium-buy-borrow-combo';
  lenderVaultAddress: string;
  principalSats: number;
  activationFeeSats: number;
};

// Buy-and-borrow combo detector.
//
// A buyer purchases an OMB through a marketplace (Satflow) AND originates a
// Liquidium loan against it in a SINGLE atomic transaction: the marketplace
// pays the seller, the lender vault funds the LTV portion, and the OMB lands
// directly in the Liquidium escrow as collateral. The marketplace plumbing
// adds outputs (seller payout, buyer change, fees) so the tx has more than the
// four outputs the canonical fixed-position matcher requires — it never
// matches detectLiquidiumOriginationCandidate.
//
// Position-independent gates, anchored on Liquidium-specific evidence:
//   1. The Liquidium activation-fee address is paid in some output. This
//      address is paid only at loan origination, so its presence rules out a
//      plain marketplace sale.
//   2. At least one P2WSH input is spent via the Liquidium 1-of-2 multisig
//      witness (the lender vault funding the loan).
//   3. Net principal (vault inputs minus change returned to the same vault
//      addresses) is positive.
//
// The escrow address is NOT derived here — the caller already knows it from
// the ord-detected transfer's destination (the OMB's new owner). ONCHAIN_TAGGING.md §2.4.
export function detectLiquidiumBuyBorrowCombo(
  tx: LoanOriginationFingerprintTx
): LiquidiumBuyBorrowComboCandidate | null {
  if (!Array.isArray(tx.vin) || !Array.isArray(tx.vout)) return null;

  // Gate 1: activation fee paid (the definitive Liquidium-origination anchor).
  let activationFeeSats = 0;
  let sawActivationFee = false;
  for (const out of tx.vout) {
    if (addressOf(out) === LIQUIDIUM_ACTIVATION_FEE_ADDR) {
      sawActivationFee = true;
      activationFeeSats = valueSats(out);
      break;
    }
  }
  if (!sawActivationFee) return null;

  // Gate 2: lender vault input(s) — P2WSH prevouts spent via the 1-of-2
  // multisig witness. Sum each vault address's input contribution.
  const vaultInByAddr = new Map<string, number>();
  for (const vin of tx.vin) {
    const prevout = vin.prevout;
    if (!isP2wshType(typeOf(prevout))) continue;
    if (!isOneOfTwoMultisigWitness(vin)) continue;
    const addr = addressOf(prevout);
    if (!addr) continue;
    vaultInByAddr.set(addr, (vaultInByAddr.get(addr) ?? 0) + valueSats(prevout));
  }
  if (vaultInByAddr.size === 0) return null;

  // The dominant vault (largest input contribution) is the lender vault stored
  // on the loan; mirrors the canonical detector's single-lender model.
  let lenderVaultAddress: string | null = null;
  let lenderVaultIn = 0;
  let vaultInTotal = 0;
  vaultInByAddr.forEach((sats, addr) => {
    vaultInTotal += sats;
    if (sats > lenderVaultIn) {
      lenderVaultIn = sats;
      lenderVaultAddress = addr;
    }
  });
  if (!lenderVaultAddress) return null;

  // Gate 3: net principal = vault inputs − change paid back to those vaults.
  let vaultOutTotal = 0;
  for (const out of tx.vout) {
    const addr = addressOf(out);
    if (addr && vaultInByAddr.has(addr)) vaultOutTotal += valueSats(out);
  }
  const principalSats = vaultInTotal - vaultOutTotal;
  if (principalSats <= 0) return null;

  return {
    kind: 'liquidium-buy-borrow-combo',
    lenderVaultAddress,
    principalSats,
    activationFeeSats,
  };
}
