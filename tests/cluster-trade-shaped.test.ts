import { describe, expect, it } from 'vitest';
import { isTradeShapedPmxEdge, isCrossTraderEdge } from '@/lib/cluster';

// Baseline: one-directional, non-round-trip pmx and nothing else — the resale
// signature that should veto a listing-staging fold (e.g. goot -> hashmaxis).
const tradeShaped = {
  cih_count: 0,
  self_xfer_count: 0,
  co_cons_count: 0,
  co_parent_count: 0,
  pmx_count: 2,
  pmx_rt_count: 0,
};

describe('isTradeShapedPmxEdge', () => {
  it('is true for pmx-only, non-round-trip edges', () => {
    expect(isTradeShapedPmxEdge(tradeShaped)).toBe(true);
  });

  it('tolerates missing optional counts', () => {
    expect(isTradeShapedPmxEdge({ cih_count: 0, self_xfer_count: 0, pmx_count: 1 })).toBe(true);
  });

  it('is false when there is no pmx signal', () => {
    expect(isTradeShapedPmxEdge({ ...tradeShaped, pmx_count: 0 })).toBe(false);
  });

  it('is false when any round-trip pmx exists (consolidation)', () => {
    expect(isTradeShapedPmxEdge({ ...tradeShaped, pmx_rt_count: 1 })).toBe(false);
  });

  it.each([
    ['cih_count', { cih_count: 1 }],
    ['self_xfer_count', { self_xfer_count: 1 }],
    ['co_cons_count', { co_cons_count: 1 }],
    ['co_parent_count', { co_parent_count: 1 }],
  ])('is false when a shared-control signal (%s) is present', (_label, override) => {
    expect(isTradeShapedPmxEdge({ ...tradeShaped, ...override })).toBe(false);
  });
});

describe('isCrossTraderEdge unchanged by the new helper', () => {
  const msrs = new Set(['A', 'B']);

  it('still requires both endpoints to be MSRs', () => {
    const edge = { addr_a: 'A', addr_b: 'B', ...tradeShaped };
    expect(isCrossTraderEdge(edge, msrs)).toBe(true);
    expect(isCrossTraderEdge({ ...edge, addr_b: 'C' }, msrs)).toBe(false);
  });

  it('keeps edges with a round-trip or CIH anchor', () => {
    const edge = { addr_a: 'A', addr_b: 'B', ...tradeShaped };
    expect(isCrossTraderEdge({ ...edge, pmx_rt_count: 1 }, msrs)).toBe(false);
    expect(isCrossTraderEdge({ ...edge, cih_count: 1 }, msrs)).toBe(false);
  });
});
