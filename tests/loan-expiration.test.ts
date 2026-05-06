import { describe, expect, it } from 'vitest';

// We import the lib's internals via the `_internal` export rather than
// re-implementing the decoder in the test, so any drift between the prod
// parser and this fixture is caught.
import { _internal } from '@/lib/loanExpiration';

describe('loanExpiration BIP-112 decoder', () => {
  it('decodes the modern Liquidium 30d default leaf', () => {
    // From tests/liquidium-modern-resolution-fingerprint.test.ts — the
    // canonical default leaf shape: <push 3 bytes> b275 <pkA> ad <pkB> ac.
    // 0x4013c6 = bit 22 set + magnitude 0x13c6 = 5062 → 5062*512s = 30 days.
    const leaf =
      '03c61340' + 'b275' + '20' +
      'a4c184aae8b4ccba9682b5ea95faf15ff2f82820fa1eb34aa5a13220fb366285' +
      'ad' + '20' +
      '94933588001ce9bace34f1b017055e6a9547a8241414d61e4e0f6045c8c77b75' + 'ac';
    const csv = _internal.parseModernDefaultLeafCsv(leaf);
    expect(csv).toBe(0x4013c6);
    const dec = _internal.decodeCsvField(csv!);
    // BIP-112 time-CSV is quantized to 512s units, so 30d ≈ 5062 × 512 =
    // 2,591,744s. The decodeTermDays helper rounds back to ~30 via snapToMenu.
    expect(dec).toEqual({ kind: 'time', seconds: 5062 * 512 });
    expect(_internal.snapToMenu(5062 * 512 / 86400)).toBe(30);
  });

  it('returns null for a non-default leaf (no b275 marker)', () => {
    // A unlock-leaf or repay-leaf shape — no CSV+OP_DROP.
    const leaf = '20' + '11'.repeat(32) + 'ac';
    expect(_internal.parseModernDefaultLeafCsv(leaf)).toBeNull();
  });

  it('decodes a block-relative CSV (bit 22 clear)', () => {
    // Hypothetical 144-block (~1d) timelock: pushdata 1 byte 0x90 (= 144),
    // then b275, then dummy pkA/pkB. We're only exercising the decoder, so
    // the leaf only needs to be parseable.
    const leaf = '0190' + 'b275' + '20' + '00'.repeat(32) + 'ad' + '20' + '00'.repeat(32) + 'ac';
    const csv = _internal.parseModernDefaultLeafCsv(leaf);
    expect(csv).toBe(0x90);
    const dec = _internal.decodeCsvField(csv!);
    expect(dec).toEqual({ kind: 'blocks', blocks: 0x90 });
  });

  it('treats CSV with bit 31 set as disabled', () => {
    expect(_internal.decodeCsvField(0x80000000)).toBeNull();
  });

  it('snapToMenu rounds to the nearest known rung within ±1 day', () => {
    expect(_internal.snapToMenu(29.6)).toBe(30);
    expect(_internal.snapToMenu(31)).toBe(30);
    expect(_internal.snapToMenu(13.7)).toBe(14);
    expect(_internal.snapToMenu(50)).toBe(50); // outside any rung; pass through
  });
});
