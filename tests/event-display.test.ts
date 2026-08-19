import { describe, expect, it } from 'vitest';
import { EVENT_DISPLAY } from '../src/lib/eventDisplay';

describe('event display hierarchy', () => {
  it('keeps sale, mint, and loan lifecycle treatments distinct', () => {
    expect(EVENT_DISPLAY.sold).toMatchObject({
      color: 'text-accent-green',
      bg: 'bg-accent-green/10 border-accent-green/40',
    });
    expect(EVENT_DISPLAY.mint).toMatchObject({
      color: 'text-accent-orange',
      bg: 'bg-accent-orange/10 border-accent-orange/40',
    });
    expect(EVENT_DISPLAY['loan-originated']).toMatchObject({
      color: 'text-accent-orange',
      bg: 'border-bone-dim/40',
    });
    expect(EVENT_DISPLAY['loan-repaid']).toMatchObject({
      color: 'text-accent-green',
      bg: 'border-bone-dim/40',
    });
    expect(EVENT_DISPLAY['loan-defaulted']).toMatchObject({
      color: 'text-accent-red',
      bg: 'bg-accent-red/10 border-accent-red/40',
    });
    expect(EVENT_DISPLAY['loan-unlocked']).toMatchObject({
      color: 'text-bone',
      bg: 'border-bone-dim/40',
    });
  });
});
