// Named sub-series — the groupings the artist actually drew as sets, and the
// ones collectors chase.
//
// Framework-free (same contract as src/lib/nav.ts): imported by the client
// gallery AND by server pages, so no 'use client', no server-only, no
// React/next imports.
//
// WHY THIS FILE AND NOT `tags` IN inscriptions.json:
// membership is hand-curated and belongs in a diff a human can review. That
// 888 KB JSON is generated (scripts/update-descriptions.js writes into it) and
// ships to every gallery visitor; adding curation there produces unreviewable
// diffs and grows the payload. ~120 integers here cost nothing.
//
// HONESTY: OMB is 1/1 hand-drawn. There is no generative trait metadata to
// read, here or on any marketplace — these lists are catalogued by hand from
// the artist's own descriptions and are openly incomplete. Every entry carries
// a `provenance` string saying exactly how it was built, and it renders
// verbatim on /history. `status: 'partial'` means we know we're missing some.
//
// To extend or finish a set: `pnpm series-scout --seed <term>` to find the
// band, `--band a-b` for a slideshow link that makes eyeballing it quick, then
// paste numbers below and re-run `--diff`. See scripts/series-scout.mjs.

export type SeriesId = 'fuck-you-sketch' | 'optimus' | 'pirates' | 'tt-lunch-sketch';

export type SeriesSeed = {
  /** Case-insensitive regex source used to find candidates. */
  pattern: string;
  /** Which record fields the pattern is matched against. */
  in: ReadonlyArray<'description' | 'tags'>;
};

export type Series = {
  id: SeriesId;
  label: string;
  /** URL value for `?series=`. */
  slug: string;
  blurb: string;
  /** 'complete' = we believe the list is exhaustive. 'partial' = still being catalogued. */
  status: 'complete' | 'partial';
  /** For artist-numbered sets, the size the artist declared. Null when open-ended. */
  declaredSize: number | null;
  /** Sorted ascending inscription numbers. */
  members: readonly number[];
  /** The artist's own index within the set, e.g. 83294043 → 25 (of 50). */
  memberIndex?: Readonly<Record<number, number>>;
  /** How this list was built. Rendered verbatim — this is the honesty knob. */
  provenance: string;
  /** How to re-find candidates. Consumed by scripts/series-scout.mjs. */
  seed: SeriesSeed;
};

export const SERIES: readonly Series[] = [
  {
    id: 'fuck-you-sketch',
    label: 'Fuck You sketches',
    slug: 'fuck-you-sketch',
    blurb:
      'A set of fifty the artist numbered himself — every description reads "Fuck you sketch N/50". That makes it the one series in the collection with a known denominator, and the only one where you can prove what is still missing.',
    status: 'partial',
    declaredSize: 50,
    members: [
      83294043, 83294044, 83294045, 83294074, 83294091, 83295229, 83295230, 83295236, 83295243,
      83295258, 83295266, 83295267, 83295289, 83295293, 83295313, 83295319, 83295492, 83295499,
      83295502, 83295534, 83295541, 83295555, 83295558, 83295562, 83297158, 83297350, 83308608,
    ],
    memberIndex: {
      83294043: 25,
      83294044: 26,
      83294045: 2,
      83294074: 28,
      83294091: 10,
      83295229: 6,
      83295230: 39,
      83295236: 38,
      83295243: 43,
      83295258: 18,
      83295266: 21,
      83295267: 30,
      83295289: 11,
      83295293: 46,
      83295313: 37,
      83295319: 5,
      83295492: 13,
      83295499: 14,
      83295502: 16,
      83295534: 12,
      83295541: 19,
      83295555: 17,
      83295558: 24,
      83295562: 44,
      83297158: 27,
      83297350: 7,
      83308608: 34,
    },
    provenance:
      'Seeded 2026-07-24 from artist descriptions matching "fuck you sketch N/50". 27 of the declared 50 identified, all black eyes, clustered in #83294043–#83308608. The other 23 are somewhere in that band and have not been catalogued yet.',
    seed: { pattern: 'fuck you sketch', in: ['description'] },
  },
  {
    id: 'pirates',
    label: 'Pirates',
    slug: 'pirates',
    blurb:
      'Tricorn hats, ships, spyglasses, hooks and one bitcoin earring. Several descriptions say outright "same hat as others in the pirate collection", so the artist was working this as a set rather than a recurring motif.',
    status: 'partial',
    declaredSize: null,
    members: [
      60569771, 83296231, 83298016, 83301817, 83302969, 83304370, 83304609, 83307199, 83308657,
      83309456, 83309884, 83309905, 83310004, 83310290, 83310355, 83311047, 83311067, 83311086,
      83311158, 83311213, 83311351, 83311921, 83311939, 83311965, 83312965, 83313589, 83313913,
      83314539,
    ],
    provenance:
      'Seeded 2026-07-24 from artist descriptions containing "pirate". 27 black eyes clustered in #83296231–#83314539 plus one earlier orange (#60569771). Open-ended — pieces whose description is blank or does not use the word have not been reviewed.',
    seed: { pattern: 'pirate', in: ['description'] },
  },
  {
    id: 'optimus',
    label: 'Optimus robots',
    slug: 'optimus',
    blurb:
      "Humanoid robots after Tesla's Optimus — working fast food, on the phone refusing a request, pouring oil into its own head. The artist tagged these as a group.",
    status: 'partial',
    declaredSize: null,
    members: [
      83293807, 83294081, 83294082, 83295252, 83295260, 83295275, 83295306, 83295491, 83295498,
      83295503, 83295540, 83295560, 83295634, 83308300,
    ],
    provenance:
      'Seeded 2026-07-24 from the artist\'s own "Optimus" / "Tesla" tags (including one record where both were stored in a single comma-joined string). 14 black eyes in #83293807–#83308300. Untagged robots elsewhere in the collection have not been reviewed.',
    seed: { pattern: 'optimus|tesla', in: ['tags'] },
  },
  {
    id: 'tt-lunch-sketch',
    label: 'TT lunch sketches',
    slug: 'tt-lunch-sketch',
    blurb:
      'Sketches the artist dated by the day he drew them over lunch. Only two are catalogued so far, three weeks apart — if the habit was regular there should be many more.',
    status: 'partial',
    declaredSize: null,
    members: [83315117, 83315934],
    provenance:
      'Seeded 2026-07-24 from descriptions containing "lunch sketch" — #83315117 (dated 12/22/24) and #83315934 (dated 1/2/25). Almost certainly incomplete; the dated-sketch habit is not yet mapped.',
    seed: { pattern: 'lunch sketch', in: ['description'] },
  },
];

const BY_SLUG = new Map(SERIES.map(s => [s.slug, s]));
const BY_ID = new Map(SERIES.map(s => [s.id, s]));

export function getSeries(slug: string | null | undefined): Series | null {
  if (!slug) return null;
  return BY_SLUG.get(slug) ?? null;
}

const MEMBER_SETS = new Map<SeriesId, ReadonlySet<number>>();

/** Memoized membership set — O(1) lookups for the gallery filter. */
export function seriesMemberSet(id: SeriesId): ReadonlySet<number> {
  let set = MEMBER_SETS.get(id);
  if (!set) {
    set = new Set(BY_ID.get(id)?.members ?? []);
    MEMBER_SETS.set(id, set);
  }
  return set;
}

// Built once at module load — ~120 entries total.
const BY_NUMBER = (() => {
  const m = new Map<number, Series[]>();
  for (const s of SERIES) {
    for (const n of s.members) {
      const list = m.get(n);
      if (list) list.push(s);
      else m.set(n, [s]);
    }
  }
  return m;
})();

/** Every series a piece belongs to. Empty for the overwhelming majority. */
export function seriesForNumber(n: number): readonly Series[] {
  return BY_NUMBER.get(n) ?? [];
}

/** The artist's index for a piece within a numbered set, e.g. "25/50". */
export function memberLabel(series: Series, n: number): string {
  const idx = series.memberIndex?.[n];
  if (idx == null) return series.label;
  return series.declaredSize != null
    ? `${series.label} ${idx}/${series.declaredSize}`
    : `${series.label} ${idx}`;
}

/**
 * Lowercased tokens folded into GalleryImage.searchText so the existing
 * substring search finds a curated set by name. Deliberately a superset with
 * the description text — typing "pirate" should match both the catalogued
 * pirates and any piece whose description happens to mention one.
 */
export function searchTokensForNumber(n: number): string {
  const hits = BY_NUMBER.get(n);
  if (!hits) return '';
  return hits
    .map(s => `series:${s.slug} ${s.label}`)
    .join(' ')
    .toLowerCase();
}
