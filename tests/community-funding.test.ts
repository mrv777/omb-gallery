import { describe, expect, it } from 'vitest';
import {
  assertConfirmedCommunityFunding,
  requiredCommunityFundingSats,
} from '@/lib/community-purchases/funding';

describe('group buy funding checks', () => {
  it('rounds each owner maximum up to the next satoshi', () => {
    expect(requiredCommunityFundingSats('10001', 1)).toBe(101n);
    expect(requiredCommunityFundingSats('10001', 20)).toBe(2001n);
  });

  it('accepts exactly enough confirmed clean BTC and ignores unconfirmed BTC', () => {
    expect(() =>
      assertConfirmedCommunityFunding(
        { confirmed: '2001', unconfirmed: '999999', total: '1002000' },
        2001n
      )
    ).not.toThrow();
    expect(() =>
      assertConfirmedCommunityFunding(
        { confirmed: '2000', unconfirmed: '999999', total: '1001999' },
        2001n
      )
    ).toThrow(/2,000 confirmed spendable sats.*2,001/u);
  });

  it('rejects invalid maximums and unit counts', () => {
    expect(() => requiredCommunityFundingSats('-1', 1)).toThrow(/maximum is invalid/u);
    expect(() => requiredCommunityFundingSats('1000', 0)).toThrow(/unit count is invalid/u);
  });
});
