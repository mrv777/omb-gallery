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
  | 'relaxed-p2tr-bigvin';

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
