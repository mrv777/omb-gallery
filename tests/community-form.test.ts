import { describe, expect, it } from 'vitest';
import { isGroupBuyFormReady, parseCommunityEnrollmentFor } from '@/lib/community-purchases/form';

const enrollment = {
  version: 1,
  network: 'mainnet',
  campaignId: 'cp_123',
  ownerId: 'owner_456',
  campaignRoot: {
    version: 1,
    masterFingerprintHex: '01020304',
    originPath: 'm',
    campaignXpub: `xpub${'1'.repeat(107)}`,
  },
};

const complete = {
  dreyReady: true,
  payoutAddress: 'bc1qexample',
  source: 'listed' as const,
  hasSelectedListing: true,
  frontedInscriptionNumber: '',
  frontedIntentId: '',
  maxCost: '100000',
  enrollmentText: JSON.stringify(enrollment),
  campaignId: 'cp_123',
  ownerId: 'owner_456',
  mode: 'anchored' as const,
  creatorUnits: 33,
  anchorAccepted: true,
  consent: true,
};

describe('Group Buy form readiness', () => {
  it('enables review only when every listed-purchase requirement is complete', () => {
    expect(isGroupBuyFormReady(complete)).toBe(true);
    expect(isGroupBuyFormReady({ ...complete, hasSelectedListing: false })).toBe(false);
    expect(isGroupBuyFormReady({ ...complete, maxCost: '' })).toBe(false);
    expect(isGroupBuyFormReady({ ...complete, maxCost: '0' })).toBe(false);
    expect(isGroupBuyFormReady({ ...complete, enrollmentText: '' })).toBe(false);
    expect(isGroupBuyFormReady({ ...complete, anchorAccepted: false })).toBe(false);
    expect(isGroupBuyFormReady({ ...complete, consent: false })).toBe(false);
    expect(isGroupBuyFormReady({ ...complete, payoutAddress: '' })).toBe(false);
    expect(isGroupBuyFormReady({ ...complete, payoutAddress: '   ' })).toBe(false);
    expect(isGroupBuyFormReady({ ...complete, dreyReady: false })).toBe(false);
  });

  it('requires both confirmed-purchase fields for a creator-fronted group buy', () => {
    const fronted = {
      ...complete,
      source: 'creator-fronted' as const,
      hasSelectedListing: false,
      frontedInscriptionNumber: '123',
      frontedIntentId: '456',
    };
    expect(isGroupBuyFormReady(fronted)).toBe(true);
    expect(isGroupBuyFormReady({ ...fronted, frontedInscriptionNumber: '' })).toBe(false);
    expect(isGroupBuyFormReady({ ...fronted, frontedIntentId: '' })).toBe(false);
  });

  it('requires an exact matching public enrollment package', () => {
    expect(parseCommunityEnrollmentFor(JSON.stringify(enrollment), 'cp_123', 'owner_456')).toEqual(
      enrollment
    );
    expect(
      parseCommunityEnrollmentFor(JSON.stringify(enrollment), 'cp_other', 'owner_456')
    ).toBeNull();
    expect(parseCommunityEnrollmentFor('{', 'cp_123', 'owner_456')).toBeNull();
  });
});
