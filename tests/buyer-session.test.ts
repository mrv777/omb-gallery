import { describe, expect, it } from 'vitest';

import { verifyBuyerSignature } from '../src/lib/buyerSession';

const DREY_TAPROOT_VECTOR = {
  address: 'bc1pcquvhrqv0q68t4m0hfq6tpn006qrskyc7yrqnp2uyrf2emg3wynsdjyk38',
  message: 'PURVOQ544B6HUATVBJZN5EZJUU',
  signature:
    'smpAUB6B2Rbupzua8LTQIF06516wzl+cwKy1be8RgoiW0riyXdKwe6GTz/5Hnb37m67pJwIKCh+D5jDueG6KpvYpmu8',
};

describe('buyer signature verification', () => {
  it('accepts Drey simple BIP-322 signatures for Taproot addresses', () => {
    expect(verifyBuyerSignature(DREY_TAPROOT_VECTOR)).toBe(true);
  });

  it('rejects a Drey signature for a different message', () => {
    expect(
      verifyBuyerSignature({
        ...DREY_TAPROOT_VECTOR,
        message: `${DREY_TAPROOT_VECTOR.message}-tampered`,
      })
    ).toBe(false);
  });

  it('rejects a malformed Drey signature without throwing', () => {
    expect(
      verifyBuyerSignature({
        ...DREY_TAPROOT_VECTOR,
        signature: `${DREY_TAPROOT_VECTOR.signature.slice(0, -1)}A`,
      })
    ).toBe(false);
  });
});
