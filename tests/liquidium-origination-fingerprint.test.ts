import { describe, expect, it } from 'vitest';

import {
  detectLiquidiumOriginationCandidate,
  detectLiquidiumBuyBorrowCombo,
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

// Real buy-and-borrow combo: tx 1c28e06c… (inscription #60579862). A Satflow
// purchase + Liquidium origination settled atomically. Seven outputs, so the
// fixed-position canonical matcher rejects it. Values in mempool.space integer
// sats. in[2] is a 2-of-2 cooperative spend (must NOT be read as a vault);
// in[3] is the real 1-of-2 lender-vault input.
const twoOfTwoScript =
  '522103d91309fffed9730450f2ad0ac7ddc8b86e30bda5d77679da85fe89d5dff28c832103ea1828361fe9d7215d1bde01d58cf23ad4c968e2e3a854f13bfb3d07f5d83e1b52ae';

function comboTx(overrides: Partial<LoanOriginationFingerprintTx> = {}): LoanOriginationFingerprintTx {
  const vault = 'bc1qgwq60mmzm8xnv2ztek7a6sqaqwsx78uh6p9x8l9qxravy3farjrqtea362';
  const tx: LoanOriginationFingerprintTx = {
    vin: [
      { prevout: { scriptpubkey_type: 'p2sh', scriptpubkey_address: '3QgwQniFnVScVmtXBK2D7KCgGXxhsxea2w', value: 600 }, witness: ['x'] },
      { prevout: { scriptpubkey_type: 'p2sh', scriptpubkey_address: '3QgwQniFnVScVmtXBK2D7KCgGXxhsxea2w', value: 600 }, witness: ['x'] },
      { prevout: { scriptpubkey_type: 'v0_p2wsh', scriptpubkey_address: 'bc1quj58shmrkgepcltvd0vhexys4936j6y5z5t36es9ewapqaty4lfqya5y06', value: 999 }, witness: ['', 'sig', twoOfTwoScript] },
      { prevout: { scriptpubkey_type: 'v0_p2wsh', scriptpubkey_address: vault, value: 4510000 }, witness: ['', 'sig', oneOfTwoScript] },
      { prevout: { scriptpubkey_type: 'p2sh', scriptpubkey_address: '3QgwQniFnVScVmtXBK2D7KCgGXxhsxea2w', value: 2010338 }, witness: ['x'] },
    ],
    vout: [
      { scriptpubkey_type: 'p2sh', scriptpubkey_address: '3QgwQniFnVScVmtXBK2D7KCgGXxhsxea2w', value: 1200 },
      { scriptpubkey_type: 'v1_p2tr', scriptpubkey_address: 'bc1prxk449p5582uzh4y4xsl4tzmt5rj3dac7axgqsrvaqchm7v2465qp0agsz', value: 999 },
      { scriptpubkey_type: 'v0_p2wpkh', scriptpubkey_address: 'bc1qxyj3pdrrz3nq50p0pmm4ujaj5m952yn352cxzw', value: 2165999 },
      { scriptpubkey_type: 'v1_p2tr', scriptpubkey_address: 'bc1p39tdzrddy5swrsf4ysu9k867283nhq754lnfhj23u543a72r60wsz8c74p', value: 54125 },
      { scriptpubkey_type: 'v1_p2tr', scriptpubkey_address: feeAddress, value: 12375 },
      { scriptpubkey_type: 'v0_p2wsh', scriptpubkey_address: vault, value: 2860000 },
      { scriptpubkey_type: 'p2sh', scriptpubkey_address: '3QgwQniFnVScVmtXBK2D7KCgGXxhsxea2w', value: 1426573 },
    ],
  };
  return { ...tx, ...overrides };
}

describe('detectLiquidiumBuyBorrowCombo', () => {
  it('matches a real Satflow-purchase + Liquidium-origination combo', () => {
    expect(detectLiquidiumBuyBorrowCombo(comboTx())).toEqual({
      kind: 'liquidium-buy-borrow-combo',
      lenderVaultAddress: 'bc1qgwq60mmzm8xnv2ztek7a6sqaqwsx78uh6p9x8l9qxravy3farjrqtea362',
      // 4,510,000 vault in − 2,860,000 vault change = 1,650,000 (== 0.0165 BTC,
      // the 89%-LTV principal shown on the lender's Liquidium dashboard).
      principalSats: 1650000,
      activationFeeSats: 12375,
    });
  });

  it('is rejected by the fixed-position canonical matcher (7 outputs)', () => {
    expect(detectLiquidiumOriginationCandidate(comboTx())).toBeNull();
  });

  it('returns null when the activation-fee output is absent (plain sale)', () => {
    const tx = comboTx({
      vout: comboTx().vout.map(o =>
        o.scriptpubkey_address === feeAddress
          ? { ...o, scriptpubkey_address: 'bc1p39tdzrddy5swrsf4ysu9k867283nhq754lnfhj23u543a72r60wsz8c74p' }
          : o
      ),
    });
    expect(detectLiquidiumBuyBorrowCombo(tx)).toBeNull();
  });

  it('returns null when no 1-of-2 multisig vault input is present (fee-address poisoning guard)', () => {
    // Activation fee paid, but the only P2WSH input is the 2-of-2 cooperative
    // spend — not a lender vault. Must not be mistaken for an origination.
    const tx = comboTx({ vin: [comboTx().vin[0], comboTx().vin[1], comboTx().vin[2], comboTx().vin[4]] });
    expect(detectLiquidiumBuyBorrowCombo(tx)).toBeNull();
  });

  it('does not double-count the 2-of-2 cooperative P2WSH input as vault flow', () => {
    // Principal must derive only from the 1-of-2 vault (in[3]); the 999-sat
    // 2-of-2 input must be ignored.
    expect(detectLiquidiumBuyBorrowCombo(comboTx())?.principalSats).toBe(1650000);
  });

  it('normalizes bitcoind verbose (BTC values + scriptPubKey fields)', () => {
    const toVerbose = (o: {
      scriptpubkey_type?: string;
      scriptpubkey_address?: string;
      value?: number;
    }) => ({
      scriptPubKey: { address: o.scriptpubkey_address, type: o.scriptpubkey_type },
      value: (o.value ?? 0) / 1e8,
    });
    const base = comboTx();
    const tx: LoanOriginationFingerprintTx = {
      vin: base.vin.map(v => ({ prevout: v.prevout ? toVerbose(v.prevout) : undefined, txinwitness: v.witness })),
      vout: base.vout.map(toVerbose),
    };
    expect(detectLiquidiumBuyBorrowCombo(tx)).toEqual({
      kind: 'liquidium-buy-borrow-combo',
      lenderVaultAddress: 'bc1qgwq60mmzm8xnv2ztek7a6sqaqwsx78uh6p9x8l9qxravy3farjrqtea362',
      principalSats: 1650000,
      activationFeeSats: 12375,
    });
  });
});
