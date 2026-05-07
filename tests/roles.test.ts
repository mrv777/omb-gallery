import { describe, expect, it } from 'vitest';
import {
  ROLES,
  emptyCounts,
  evaluateRoles,
  rankOf,
  shortfallFor,
  sortRoleIds,
  getRoleById,
} from '@/lib/roles';

describe('roles catalog', () => {
  it('catalog ids are unique', () => {
    const ids = ROLES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('catalog emoji length matches the requirement count for single-color tiers', () => {
    for (const r of ROLES) {
      if (r.combo) continue;
      const total = Object.values(r.requires).reduce((a, b) => a + (b ?? 0), 0);
      expect(r.emoji.length).toBe(total);
    }
  });

  it('rankOf reflects array order; sortRoleIds restores priority order', () => {
    expect(rankOf('top-stack')).toBe(0);
    expect(rankOf('black-1')).toBe(ROLES.length - 1);
    expect(rankOf('does-not-exist')).toBeGreaterThan(ROLES.length);
    const shuffled = ['black-1', 'rainbow', 'red-1', 'top-stack'];
    expect(sortRoleIds(shuffled)).toEqual(['top-stack', 'rainbow', 'red-1', 'black-1']);
  });
});

describe('evaluateRoles — discrete tiers, stacking', () => {
  it('zero counts → no roles', () => {
    expect(evaluateRoles(emptyCounts())).toEqual([]);
  });

  it('1 black eye → only the 1-black role (no implicit intermediate tiers)', () => {
    expect(evaluateRoles({ ...emptyCounts(), black: 1 })).toEqual(['black-1']);
  });

  it('3 black eyes → still only 1-black (no 3-black role exists)', () => {
    expect(evaluateRoles({ ...emptyCounts(), black: 3 })).toEqual(['black-1']);
  });

  it('5 black eyes → still only 1-black (just below the 6-black threshold)', () => {
    expect(evaluateRoles({ ...emptyCounts(), black: 5 })).toEqual(['black-1']);
  });

  it('6 black eyes → both 1-black and 6-black (stacking)', () => {
    const ids = evaluateRoles({ ...emptyCounts(), black: 6 });
    expect(ids).toContain('black-1');
    expect(ids).toContain('black-6');
    // priority order — black-6 ahead of black-1
    expect(ids.indexOf('black-6')).toBeLessThan(ids.indexOf('black-1'));
  });

  it('2 oranges → only 1-orange (4 is the next threshold)', () => {
    expect(evaluateRoles({ ...emptyCounts(), orange: 2 })).toEqual(['orange-1']);
  });

  it('4 oranges → 1-orange + 4-orange', () => {
    const ids = evaluateRoles({ ...emptyCounts(), orange: 4 });
    expect(ids).toEqual(expect.arrayContaining(['orange-1', 'orange-4']));
  });

  it('1 red + 1 blue → red-1, blue-1, AND R&B combo (combos stack)', () => {
    const ids = evaluateRoles({ ...emptyCounts(), red: 1, blue: 1 });
    expect(ids).toEqual(expect.arrayContaining(['rnb', 'red-1', 'blue-1']));
  });

  it('1 red + 1 blue + 1 green → R&B + rainbow + all three single-colors', () => {
    const ids = evaluateRoles({ ...emptyCounts(), red: 1, blue: 1, green: 1 });
    expect(ids).toEqual(expect.arrayContaining(['rainbow', 'rnb', 'red-1', 'blue-1', 'green-1']));
    expect(ids).not.toContain('top-stack'); // needs 8 greens
  });

  it('1 red + 1 blue + 8 greens → top-stack + rainbow + R&B + green-3 + green-1', () => {
    const ids = evaluateRoles({ ...emptyCounts(), red: 1, blue: 1, green: 8 });
    expect(ids).toEqual(
      expect.arrayContaining(['top-stack', 'rainbow', 'rnb', 'red-1', 'blue-1', 'green-3', 'green-1'])
    );
    // top-stack must be first (rarest)
    expect(ids[0]).toBe('top-stack');
  });
});

describe('shortfallFor', () => {
  it('returns [] when role is already earned', () => {
    const role = getRoleById('black-1')!;
    expect(shortfallFor(role, { ...emptyCounts(), black: 5 })).toEqual([]);
  });

  it('reports needed counts for unearned single-color tier', () => {
    const role = getRoleById('green-3')!;
    const sf = shortfallFor(role, { ...emptyCounts(), green: 1 });
    expect(sf).toEqual([{ color: 'green', need: 2 }]);
  });

  it('reports per-color shortfalls for combos', () => {
    const role = getRoleById('rainbow')!;
    const sf = shortfallFor(role, { ...emptyCounts(), red: 1 });
    expect(sf).toEqual(
      expect.arrayContaining([
        { color: 'green', need: 1 },
        { color: 'blue', need: 1 },
      ])
    );
    expect(sf).not.toContainEqual({ color: 'red', need: 0 });
  });
});
