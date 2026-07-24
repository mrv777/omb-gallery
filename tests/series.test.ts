import { describe, expect, it } from 'vitest';

import inscriptions from '@/data/collections/omb/inscriptions.json';
import {
  SERIES,
  getSeries,
  memberLabel,
  searchTokensForNumber,
  seriesForNumber,
  seriesMemberSet,
} from '@/lib/series';

type Entry = { filename: string; description: string; tags: string[] };
const REAL = new Map<number, { color: string; description: string; tags: string[] }>();
for (const [color, entries] of Object.entries(inscriptions as Record<string, Entry[]>)) {
  for (const e of entries) {
    REAL.set(parseInt(e.filename, 10), { color, description: e.description, tags: e.tags });
  }
}

describe('series catalogue integrity', () => {
  it('has unique ids and slugs', () => {
    expect(new Set(SERIES.map(s => s.id)).size).toBe(SERIES.length);
    expect(new Set(SERIES.map(s => s.slug)).size).toBe(SERIES.length);
  });

  it.each(SERIES.map(s => [s.slug, s] as const))(
    '%s: every member is a real OMB inscription',
    (_slug, series) => {
      // The point of this test. Members are hand-pasted from scout output, and
      // a transposed digit would otherwise render as a silently-missing
      // thumbnail rather than an error.
      for (const n of series.members) {
        expect(REAL.has(n), `#${n} is not an OMB inscription number`).toBe(true);
      }
    }
  );

  it.each(SERIES.map(s => [s.slug, s] as const))(
    '%s: members are sorted ascending with no duplicates',
    (_slug, series) => {
      const sorted = [...series.members].sort((a, b) => a - b);
      expect(series.members).toEqual(sorted);
      expect(new Set(series.members).size).toBe(series.members.length);
    }
  );

  it.each(SERIES.map(s => [s.slug, s] as const))(
    '%s: memberIndex is consistent with members and declaredSize',
    (_slug, series) => {
      if (!series.memberIndex) return;
      const members = new Set(series.members);
      const seen = new Set<number>();
      for (const [numStr, idx] of Object.entries(series.memberIndex)) {
        const n = Number(numStr);
        expect(members.has(n), `memberIndex has #${n}, which is not a member`).toBe(true);
        expect(idx).toBeGreaterThanOrEqual(1);
        if (series.declaredSize != null) expect(idx).toBeLessThanOrEqual(series.declaredSize);
        // Two pieces claiming to be "17/50" means one of them was misread.
        expect(seen.has(idx), `index ${idx} is claimed twice`).toBe(false);
        seen.add(idx);
      }
    }
  );

  it.each(SERIES.map(s => [s.slug, s] as const))(
    '%s: a numbered set never claims more members than it declared',
    (_slug, series) => {
      if (series.declaredSize == null) return;
      expect(series.members.length).toBeLessThanOrEqual(series.declaredSize);
    }
  );

  it.each(SERIES.map(s => [s.slug, s] as const))(
    '%s: status matches whether the set is actually complete',
    (_slug, series) => {
      if (series.declaredSize == null) return;
      const complete = series.members.length === series.declaredSize;
      expect(series.status).toBe(complete ? 'complete' : 'partial');
    }
  );

  it.each(SERIES.map(s => [s.slug, s] as const))(
    '%s: provenance says how the list was built',
    (_slug, series) => {
      // Rendered verbatim on /history. An empty string there would present a
      // hand-curated guess as if it were authoritative.
      expect(series.provenance.length).toBeGreaterThan(40);
    }
  );

  it('seeds actually match the members they were derived from', () => {
    // Not every member has to match (some get added by eye), but a seed that
    // matches nothing means the pattern rotted and --diff is now useless.
    for (const series of SERIES) {
      const re = new RegExp(series.seed.pattern, 'i');
      const matched = series.members.filter(n => {
        const rec = REAL.get(n);
        if (!rec) return false;
        if (series.seed.in.includes('description') && re.test(rec.description)) return true;
        if (series.seed.in.includes('tags') && rec.tags.some(t => re.test(t))) return true;
        return false;
      });
      expect(matched.length, `${series.slug} seed matches nothing`).toBeGreaterThan(0);
    }
  });
});

describe('lookups', () => {
  it('resolves a series by slug and rejects unknown ones', () => {
    expect(getSeries('pirates')?.id).toBe('pirates');
    expect(getSeries('not-a-series')).toBeNull();
    expect(getSeries(null)).toBeNull();
    expect(getSeries('')).toBeNull();
  });

  it('memberSet is O(1)-shaped and matches the array', () => {
    const pirates = getSeries('pirates')!;
    const set = seriesMemberSet('pirates');
    expect(set.size).toBe(pirates.members.length);
    expect(set.has(pirates.members[0])).toBe(true);
    // Memoized — same reference on a second call.
    expect(seriesMemberSet('pirates')).toBe(set);
  });

  it('maps a number back to its series, and returns empty for the other ~8,930', () => {
    const pirates = getSeries('pirates')!;
    expect(seriesForNumber(pirates.members[0]).map(s => s.id)).toEqual(['pirates']);
    expect(seriesForNumber(89945)).toEqual([]);
  });

  it('labels a numbered member with the artist index', () => {
    const fy = getSeries('fuck-you-sketch')!;
    // 83294043 is "Fuck you sketch 25/50" in the artist's own description.
    expect(memberLabel(fy, 83294043)).toBe('Fuck You sketches 25/50');
    const pirates = getSeries('pirates')!;
    expect(memberLabel(pirates, pirates.members[0])).toBe('Pirates');
  });

  it('emits search tokens for members only', () => {
    const pirates = getSeries('pirates')!;
    const tokens = searchTokensForNumber(pirates.members[0]);
    expect(tokens).toContain('series:pirates');
    expect(tokens).toBe(tokens.toLowerCase());
    expect(searchTokensForNumber(89945)).toBe('');
  });
});
