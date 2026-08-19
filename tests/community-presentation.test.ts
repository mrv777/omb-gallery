import { describe, expect, it } from 'vitest';
import { looksLikeAddress } from '@/lib/format';
import {
  communityParticipantState,
  communityProgressLabel,
} from '@/lib/community-purchases/presentation';

describe('Group Buy campaign presentation', () => {
  it('uses reservation language until the campaign fills', () => {
    expect(communityProgressLabel('open')).toBe('reserved');
    expect(communityProgressLabel('readiness')).toBe('assigned');
    expect(communityParticipantState('open', { allocatedUnits: [0], readiness: 'waiting' })).toBe(
      'reserved'
    );
    expect(
      communityParticipantState('readiness', { allocatedUnits: [0], readiness: 'waiting' })
    ).toBe('action needed');
    expect(communityParticipantState('held', { allocatedUnits: [0], readiness: 'ready' })).toBe(
      'owner'
    );
  });

  it('does not present a wallet address as a Matrica identity', () => {
    expect(looksLikeAddress('bc1p5e4pmtdwl5qqx4tktd7zhcfxjgywj5ahzmnwrmnxs3dpfj7h5st')).toBe(true);
    expect(looksLikeAddress('ombcollector')).toBe(false);
  });
});
