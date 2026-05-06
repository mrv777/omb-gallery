import { describe, expect, it } from 'vitest';

import {
  detectLiquidiumOriginationCandidate,
  type LoanOriginationFingerprintTx,
} from '@/lib/liquidiumOriginationFingerprint';

const feeAddress = 'bc1papmpmu0xzfvw4x9qe4jstgxfnfy5q8zhh6xredjxd86ca74uph3s59se9u';
const oneOfTwoScript =
  '51210372c35da9513e6d123bb65513f5ca7edbd0be55125e44846c73ad585d0ce6ae572103cd1090d2bb22cb72f5d7259cbd24819fd828fa33a16429084a0e2614dce0f58352ae';

function candidateTx(
  overrides: Partial<LoanOriginationFingerprintTx> = {}
): LoanOriginationFingerprintTx {
  const lenderVault = 'bc1qgwq60mmzm8xnv2ztek7a6sqaqwsx78uh6p9x8l9qxravy3farjrqtea362';
  const tx: LoanOriginationFingerprintTx = {
    vin: [
      {
        prevout: {
          scriptpubkey_type: 'v1_p2tr',
          scriptpubkey_address: 'bc1p82yarx94pmdqc4h0r90e6rfhgwnr3gq03sm296s63vlu9nvc75sqlx0t7k',
          value: 0.0001,
        },
        witness: ['e2c1e13d63db858d6e6faa20ec0d718667182862cddf6419c6843b73954c7faf'],
      },
      {
        prevout: {
          scriptpubkey_type: 'v0_p2wsh',
          scriptpubkey_address: lenderVault,
          value: 0.00647924,
        },
        witness: ['', '304502210083dfa82501', oneOfTwoScript],
      },
      {
        prevout: {
          scriptpubkey_type: 'v0_p2wsh',
          scriptpubkey_address: lenderVault,
          value: 0.00605874,
        },
        witness: ['', '3045022100a02875da01', oneOfTwoScript],
      },
    ],
    vout: [
      {
        scriptpubkey_type: 'v1_p2tr',
        scriptpubkey_address: 'bc1p4kf0n5742vfs9f5jx8cum34gq2e9vpnvzhh2jdcwhlku4r5ftxvqf5e8q4',
        value: 0.0001,
      },
      { scriptpubkey_type: 'v1_p2tr', scriptpubkey_address: feeAddress, value: 0.00023137 },
      {
        scriptpubkey_type: 'p2sh',
        scriptpubkey_address: '3HEXk7N1Sww8UU346NL4pGPszJ1MzEKMeb',
        value: 0.03061159,
      },
      { scriptpubkey_type: 'v0_p2wsh', scriptpubkey_address: lenderVault, value: 0.00306307 },
    ],
  };

  return { ...tx, ...overrides };
}

describe('detectLiquidiumOriginationCandidate', () => {
  it('matches the modern Liquidium instant-loan origination shape', () => {
    const match = detectLiquidiumOriginationCandidate(candidateTx());

    expect(match).toEqual({
      kind: 'liquidium-origination-candidate',
      matchKind: 'strict-p2sh',
      collateralAddress: 'bc1p82yarx94pmdqc4h0r90e6rfhgwnr3gq03sm296s63vlu9nvc75sqlx0t7k',
      escrowAddress: 'bc1p4kf0n5742vfs9f5jx8cum34gq2e9vpnvzhh2jdcwhlku4r5ftxvqf5e8q4',
      activationFeeAddress: feeAddress,
      borrowerPayoutAddress: '3HEXk7N1Sww8UU346NL4pGPszJ1MzEKMeb',
      lenderVaultAddress: 'bc1qgwq60mmzm8xnv2ztek7a6sqaqwsx78uh6p9x8l9qxravy3farjrqtea362',
      principalSats: 3061159,
      activationFeeSats: 23137,
    });
  });

  it('matches the promoted P2TR-principal variant subset', () => {
    const tx = candidateTx({
      vin: candidateTx().vin.slice(0, 2),
      vout: candidateTx().vout.map((vout, i) =>
        i === 2
          ? {
              scriptpubkey_type: 'v1_p2tr',
              scriptpubkey_address:
                'bc1ps0h8u8jfercahggmv3u3sm7eh742l3w9mv6809fqcyk88jlr7a8sx8z744',
              value: 0.03061159,
            }
          : vout
      ),
    });

    expect(detectLiquidiumOriginationCandidate(tx)?.matchKind).toBe('variant-p2tr');
  });

  it('matches the relaxed P2SH two-input variant', () => {
    const tx = candidateTx({ vin: candidateTx().vin.slice(0, 2) });
    expect(detectLiquidiumOriginationCandidate(tx)?.matchKind).toBe('relaxed-p2sh');
  });

  it('matches the relaxed P2WPKH-principal variant at any vin count', () => {
    const twoIn = candidateTx({
      vin: candidateTx().vin.slice(0, 2),
      vout: candidateTx().vout.map((vout, i) =>
        i === 2
          ? {
              scriptpubkey_type: 'v0_p2wpkh',
              scriptpubkey_address: 'bc1qgcs4jtt5l64yngu5rljhdny2z4fc7wc5g675mm',
              value: 0.03061159,
            }
          : vout
      ),
    });
    const threeIn = candidateTx({
      vout: candidateTx().vout.map((vout, i) =>
        i === 2
          ? {
              scriptpubkey_type: 'v0_p2wpkh',
              scriptpubkey_address: 'bc1qgcs4jtt5l64yngu5rljhdny2z4fc7wc5g675mm',
              value: 0.03061159,
            }
          : vout
      ),
    });

    expect(detectLiquidiumOriginationCandidate(twoIn)?.matchKind).toBe('relaxed-p2wpkh');
    expect(detectLiquidiumOriginationCandidate(threeIn)?.matchKind).toBe('relaxed-p2wpkh');
  });

  it('matches the relaxed P2TR-principal variant when vin > 4', () => {
    const baseVin = candidateTx().vin;
    const extraVins = Array.from({ length: 8 }, () => baseVin[1]);
    const tx = candidateTx({
      vin: [baseVin[0], ...extraVins],
      vout: candidateTx().vout.map((vout, i) =>
        i === 2
          ? {
              scriptpubkey_type: 'v1_p2tr',
              scriptpubkey_address:
                'bc1ps0h8u8jfercahggmv3u3sm7eh742l3w9mv6809fqcyk88jlr7a8sx8z744',
              value: 0.03061159,
            }
          : vout
      ),
    });

    expect(detectLiquidiumOriginationCandidate(tx)?.matchKind).toBe('relaxed-p2tr-bigvin');
  });

  it('rejects the old loose four-output shape without the lender vault witness', () => {
    const tx = candidateTx({
      vin: [
        candidateTx().vin[0],
        {
          prevout: {
            scriptpubkey_type: 'v0_p2wsh',
            scriptpubkey_address: 'bc1qgwq60mmzm8xnv2ztek7a6sqaqwsx78uh6p9x8l9qxravy3farjrqtea362',
            value: 0.00647924,
          },
          witness: ['', '304502210083dfa82501', '0014deadbeef'],
        },
      ],
    });

    expect(detectLiquidiumOriginationCandidate(tx)).toBeNull();
  });

  it('normalizes mempool.space integer-sat values', () => {
    const tx = candidateTx({
      vin: candidateTx().vin.map(vin => ({
        ...vin,
        prevout: vin.prevout
          ? { ...vin.prevout, value: Math.round((vin.prevout.value ?? 0) * 1e8) }
          : undefined,
      })),
      vout: candidateTx().vout.map(vout => ({
        ...vout,
        value: Math.round((vout.value ?? 0) * 1e8),
      })),
    });

    expect(detectLiquidiumOriginationCandidate(tx)?.principalSats).toBe(3061159);
  });

  it('normalizes bitcoind verbose scriptPubKey fields', () => {
    const tx = candidateTx({
      vin: candidateTx().vin.map(vin => ({
        ...vin,
        prevout: vin.prevout
          ? {
              scriptPubKey: {
                address: vin.prevout.scriptpubkey_address,
                type:
                  vin.prevout.scriptpubkey_type === 'v1_p2tr'
                    ? 'witness_v1_taproot'
                    : vin.prevout.scriptpubkey_type === 'v0_p2wsh'
                      ? 'witness_v0_scripthash'
                      : vin.prevout.scriptpubkey_type,
              },
              value: vin.prevout.value,
            }
          : undefined,
      })),
      vout: candidateTx().vout.map(vout => ({
        scriptPubKey: {
          address: vout.scriptpubkey_address,
          type:
            vout.scriptpubkey_type === 'v1_p2tr'
              ? 'witness_v1_taproot'
              : vout.scriptpubkey_type === 'v0_p2wsh'
                ? 'witness_v0_scripthash'
                : vout.scriptpubkey_type,
        },
        value: vout.value,
      })),
    });

    expect(detectLiquidiumOriginationCandidate(tx)?.matchKind).toBe('strict-p2sh');
  });
});
