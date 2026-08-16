import { describe, expect, it } from 'vitest';

import { bip322SignatureToHex } from '../src/lib/wallet/bip322Signature';

const DREY_TAPROOT_SIGNATURE =
  'smpAUB6B2Rbupzua8LTQIF06516wzl+cwKy1be8RgoiW0riyXdKwe6GTz/5Hnb37m67pJwIKCh+D5jDueG6KpvYpmu8';
const DREY_TAPROOT_WITNESS_HEX =
  '01407a07645bba9cee6bc2d3408174eb9d7ac3397e7302b2d5b7bc460a225b4ae2c9774ac1ee864f3ff91e76f7ee6ebba49c0828287e0f98c3b9e1ba2a9bd8a66bbc';
const DREY_PADDED_PAYMENT_SIGNATURE =
  'smpAkcwRAIgdYsoJHZ3GQgP1hD9cdFfBcqV+m3nON62gIk1JdNtAgkCIGW4mT9wBvhfM0rRQQhftdqkO/DQBy9YJH9LYGeyBBt4ASECpueu7KjrvuS1COKjtc5yE7fDnUOH0BtFWeCFrmO019M=';
const DREY_PAYMENT_WITNESS_HEX =
  '024730440220758b2824767719080fd610fd71d15f05ca95fa6de738deb680893525d36d0209022065b8993f7006f85f334ad141085fb5daa43bf0d0072f58247f4b6067b2041b78012102a6e7aeeca8ebbee4b508e2a3b5ce7213b7c39d4387d01b4559e085ae63b4d7d3';

describe('BIP-322 signature encoding', () => {
  it('converts Drey current simple signatures to the hex ORD.NET expects', () => {
    expect(bip322SignatureToHex(DREY_TAPROOT_SIGNATURE)).toBe(DREY_TAPROOT_WITNESS_HEX);
  });

  it('handles the padded payment signature that made window.atob fail', () => {
    expect(() => atob(DREY_PADDED_PAYMENT_SIGNATURE)).toThrow();
    expect(bip322SignatureToHex(DREY_PADDED_PAYMENT_SIGNATURE)).toBe(DREY_PAYMENT_WITNESS_HEX);
  });

  it('retains compatibility with unprefixed Base64 signatures', () => {
    expect(bip322SignatureToHex(DREY_TAPROOT_SIGNATURE.slice(3))).toBe(DREY_TAPROOT_WITNESS_HEX);
  });

  it('normalizes signatures already returned as hex', () => {
    expect(bip322SignatureToHex('AABB00ff')).toBe('aabb00ff');
  });

  it('fails with a useful error for malformed wallet output', () => {
    expect(() => bip322SignatureToHex('smpnot-base64')).toThrow(
      'Wallet returned an invalid BIP-322 signature encoding.'
    );
    expect(() => bip322SignatureToHex('smp')).toThrow(
      'Wallet returned an invalid BIP-322 signature encoding.'
    );
  });
});
