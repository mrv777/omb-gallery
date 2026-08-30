import { describe, expect, it } from 'vitest';
import { Psbt } from 'bitcoinjs-lib';
import {
  ListingPsbtValidationError,
  assertSignedPsbtPreservesPreflight,
  unsignedPsbtHash,
} from '../src/lib/marketplace/listingPsbt';

const TAPROOT_SCRIPT = Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.alloc(32, 7)]);

function unsignedPsbt(amount = 10_000): Psbt {
  return new Psbt()
    .addInput({
      hash: Buffer.alloc(32, 3),
      index: 0,
      witnessUtxo: { script: TAPROOT_SCRIPT, value: amount },
      tapInternalKey: Buffer.alloc(32, 7),
    })
    .addOutput({ script: TAPROOT_SCRIPT, value: amount - 500 });
}

describe('listing PSBT signed-result validation', () => {
  it('accepts an expected signature without storing or changing the transaction', () => {
    const original = unsignedPsbt().toBase64();
    const signed = Psbt.fromBase64(original);
    signed.updateInput(0, { tapKeySig: Buffer.alloc(64, 9) });

    expect(() =>
      assertSignedPsbtPreservesPreflight({
        unsignedPsbt: original,
        signedPsbt: signed.toBase64(),
        selectedInputIndexes: [0],
      })
    ).not.toThrow();
    expect(unsignedPsbtHash(signed.toBase64())).toBe(unsignedPsbtHash(original));
  });

  it('rejects a wallet-returned PSBT with a changed payment output', () => {
    const original = unsignedPsbt().toBase64();
    const changed = unsignedPsbt(10_001);
    changed.updateInput(0, { tapKeySig: Buffer.alloc(64, 9) });

    expect(() =>
      assertSignedPsbtPreservesPreflight({
        unsignedPsbt: original,
        signedPsbt: changed.toBase64(),
        selectedInputIndexes: [0],
      })
    ).toThrow(ListingPsbtValidationError);
  });

  it('rejects an unsigned wallet response', () => {
    const original = unsignedPsbt().toBase64();
    expect(() =>
      assertSignedPsbtPreservesPreflight({
        unsignedPsbt: original,
        signedPsbt: original,
        selectedInputIndexes: [0],
      })
    ).toThrow('did not add');
  });
});
