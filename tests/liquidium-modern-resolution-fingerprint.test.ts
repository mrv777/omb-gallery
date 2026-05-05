import { describe, expect, it } from 'vitest';

import {
  detectLiquidiumModernResolution,
  type ResolutionFingerprintTx,
  LIQUIDIUM_MODERN_INTERNAL_PUBKEY_FOR_TEST,
  LIQUIDIUM_ACTIVATION_FEE_ADDR_FOR_TEST,
} from '@/lib/liquidiumModernResolutionFingerprint';

const escrowAddr = 'bc1p7525hmk8rjvlsft5kjpeyxhze3yqjra654pupmc3wyh2c6xejm0qss4g9y';
const borrowerAddr = 'bc1pkpjy8m5q9uhjt9p89ykphla8m8wgjcwp0rraxwzxvr2lv7cw90fs9a6j22';
const lenderAddr = 'bc1pqwlnxhl4z3u3nmz8st0dpc0pn5gh8ggrmjhhdwey4tk2etha3aqqjr3g95';

const goodControlBlock =
  'c0' + LIQUIDIUM_MODERN_INTERNAL_PUBKEY_FOR_TEST + '00'.repeat(32) + '11'.repeat(32);

const repayLeaf =
  '20' +
  '4203828875dfde47d856ca13a315826d82ca8f87d80221c31a38f29fccb4db2a' +
  'ad' +
  '20' +
  '43ce54082cda3ff2775b4cfad732bc3570b6cc7e3e8a38f320ef2f86219d7154' +
  'ad' +
  '42' +
  '376139343237653438373339633761356463313635633035303935366462643534653865343634663938323335303261376536613132323432336633613930363a30';

const defaultLeaf =
  '03c61340' +
  'b275' +
  '20' +
  'a4c184aae8b4ccba9682b5ea95faf15ff2f82820fa1eb34aa5a13220fb366285' +
  'ad' +
  '20' +
  '94933588001ce9bace34f1b017055e6a9547a8241414d61e4e0f6045c8c77b75' +
  'ac';

function repayTx(overrides: Partial<ResolutionFingerprintTx> = {}): ResolutionFingerprintTx {
  return {
    vin: [
      {
        prevout: {
          scriptpubkey_type: 'v1_p2tr',
          scriptpubkey_address: escrowAddr,
          value: 0.0001,
        },
        witness: ['00'.repeat(64), '00'.repeat(64), repayLeaf, goodControlBlock],
      },
    ],
    vout: [
      { scriptpubkey_type: 'v1_p2tr', scriptpubkey_address: borrowerAddr, value: 0.0001 },
      { scriptpubkey_type: 'v0_p2wsh', scriptpubkey_address: lenderAddr, value: 0.01743632 },
      {
        scriptpubkey_type: 'v1_p2tr',
        scriptpubkey_address: LIQUIDIUM_ACTIVATION_FEE_ADDR_FOR_TEST,
        value: 0.00005032,
      },
      { scriptpubkey_type: 'p2sh', scriptpubkey_address: '32bw8sp13taw5CRRTL1HCtYA54XR4T8Qch', value: 0.00903587 },
    ],
    ...overrides,
  };
}

function defaultTx(overrides: Partial<ResolutionFingerprintTx> = {}): ResolutionFingerprintTx {
  return {
    vin: [
      {
        prevout: {
          scriptpubkey_type: 'v1_p2tr',
          scriptpubkey_address: escrowAddr,
          value: 0.00000999,
        },
        witness: ['00'.repeat(64), '00'.repeat(64), defaultLeaf, goodControlBlock],
      },
    ],
    vout: [
      { scriptpubkey_type: 'v1_p2tr', scriptpubkey_address: lenderAddr, value: 0.00000999 },
      { scriptpubkey_type: 'p2sh', scriptpubkey_address: '3ECGTytraUgmqid8EHSo6CHg5HGnieGu1u', value: 0.00003231 },
    ],
    ...overrides,
  };
}

describe('detectLiquidiumModernResolution', () => {
  it('classifies the cooperative-leaf shape as repaid', () => {
    const m = detectLiquidiumModernResolution(repayTx());
    expect(m).not.toBeNull();
    expect(m?.resolution).toBe('repaid');
    expect(m?.escrowAddress).toBe(escrowAddr);
    expect(m?.destinationAddress).toBe(borrowerAddr);
  });

  it('classifies the OP_CSV-gated leaf as defaulted', () => {
    const m = detectLiquidiumModernResolution(defaultTx());
    expect(m?.resolution).toBe('defaulted');
    expect(m?.destinationAddress).toBe(lenderAddr);
  });

  it('rejects spends whose internal pubkey is not the modern Liquidium key', () => {
    const wrongCb = 'c0' + 'ee'.repeat(32) + '00'.repeat(32) + '11'.repeat(32);
    const tx = repayTx({
      vin: [
        {
          prevout: { scriptpubkey_type: 'v1_p2tr', scriptpubkey_address: escrowAddr, value: 0.0001 },
          witness: ['00'.repeat(64), '00'.repeat(64), repayLeaf, wrongCb],
        },
      ],
    });
    expect(detectLiquidiumModernResolution(tx)).toBeNull();
  });

  it('rejects key-path spends (witness has only the schnorr signature)', () => {
    const tx = repayTx({
      vin: [
        {
          prevout: { scriptpubkey_type: 'v1_p2tr', scriptpubkey_address: escrowAddr, value: 0.0001 },
          witness: ['00'.repeat(64)],
        },
      ],
    });
    expect(detectLiquidiumModernResolution(tx)).toBeNull();
  });

  it('falls back to unlocked when internal pubkey matches but neither leaf shape does', () => {
    const oddLeaf = '20' + '11'.repeat(32) + 'ac';
    const tx = repayTx({
      vin: [
        {
          prevout: { scriptpubkey_type: 'v1_p2tr', scriptpubkey_address: escrowAddr, value: 0.0001 },
          witness: ['00'.repeat(64), '00'.repeat(64), oddLeaf, goodControlBlock],
        },
      ],
    });
    expect(detectLiquidiumModernResolution(tx)?.resolution).toBe('unlocked');
  });

  it('downgrades repay to unlocked when the Liquidium activation output is missing', () => {
    const tx = repayTx({
      vout: [
        { scriptpubkey_type: 'v1_p2tr', scriptpubkey_address: borrowerAddr, value: 0.0001 },
        { scriptpubkey_type: 'v0_p2wsh', scriptpubkey_address: lenderAddr, value: 0.01743632 },
        { scriptpubkey_type: 'p2sh', scriptpubkey_address: '32bw8sp13taw5CRRTL1HCtYA54XR4T8Qch', value: 0.00903587 },
      ],
    });
    expect(detectLiquidiumModernResolution(tx)?.resolution).toBe('unlocked');
  });

  it('normalizes bitcoind verbose scriptPubKey fields', () => {
    const tx: ResolutionFingerprintTx = {
      vin: [
        {
          prevout: {
            scriptPubKey: { address: escrowAddr, type: 'witness_v1_taproot' },
            value: 0.0001,
          },
          witness: ['00'.repeat(64), '00'.repeat(64), repayLeaf, goodControlBlock],
        },
      ],
      vout: [
        { scriptPubKey: { address: borrowerAddr, type: 'witness_v1_taproot' }, value: 0.0001 },
        { scriptPubKey: { address: lenderAddr, type: 'witness_v0_scripthash' }, value: 0.01743632 },
        {
          scriptPubKey: { address: LIQUIDIUM_ACTIVATION_FEE_ADDR_FOR_TEST, type: 'witness_v1_taproot' },
          value: 0.00005032,
        },
        { scriptPubKey: { address: '32bw8sp13taw5CRRTL1HCtYA54XR4T8Qch', type: 'scripthash' }, value: 0.00903587 },
      ],
    };
    expect(detectLiquidiumModernResolution(tx)?.resolution).toBe('repaid');
  });
});
