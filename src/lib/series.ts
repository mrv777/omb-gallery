// Named sub-series — recurring runs in the collection, and the ones collectors
// chase.
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
// HONESTY — READ BEFORE WRITING ANY COPY HERE:
// OMB is 1/1 hand-drawn. There is no generative trait metadata to read, here or
// on any marketplace. Two different kinds of evidence back these lists and they
// must never be conflated:
//
//   1. THE ARTWORK. Things visible in the piece itself — the "FUCK YOU SKETCH
//      25/50" written onto the drawing, the shared pirate tricorn. This is the
//      artist's own doing and can be cited as such.
//   2. OUR OWN NOTES. The `description` and `tags` fields in
//      src/data/collections/omb/inscriptions.json were written BY THE WIKI
//      MAINTAINERS while cataloguing. They are not the artist's metadata and
//      must never be described as such — "the artist tagged these" is a false
//      claim about a real person.
//
// Seeding off (2) is fine; it's how these sets were found. Presenting (2) as
// (1) is not. Every entry records which it was in `provenance` (an internal
// note, not rendered), and `status: 'partial'` tells readers we know we're
// missing some.
//
// To extend or finish a set: `pnpm series-scout --seed <term>` to find the
// band, `--band a-b` for a slideshow link that makes eyeballing it quick, then
// paste numbers below and re-run `--diff`. See scripts/series-scout.mjs.

export type SeriesId = 'fuck-you-sketch' | 'white-border-abstract' | 'optimus' | 'pirates';

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
  /** Known series size when established. Null when open-ended. */
  declaredSize: number | null;
  /** Sorted ascending inscription numbers. */
  members: readonly number[];
  /** The index the artist wrote on the piece itself, e.g. 83294043 → 25 (of 50). */
  memberIndex?: Readonly<Record<number, number>>;
  /**
   * How this list was built — an internal note for whoever extends it.
   * NOT rendered: on a public card it buried the art under methodology. The
   * `status` pill communicates incompleteness to readers instead.
   */
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
      'A set of fifty the artist numbered himself, with the index written onto the drawing — "FUCK YOU SKETCH 25/50 2025" and so on, legible in the artwork. That makes it the one series with a known denominator, and the only one where you can prove exactly what is still missing.',
    status: 'partial',
    declaredSize: 50,
    members: [
      83294043, 83294044, 83294045, 83294074, 83294091, 83295229, 83295230, 83295236, 83295243,
      83295258, 83295266, 83295267, 83295289, 83295293, 83295313, 83295319, 83295492, 83295499,
      83295502, 83295534, 83295541, 83295555, 83295558, 83295562, 83295630, 83295640, 83295664,
      83295670, 83295686, 83295759, 83295822, 83295844, 83295928, 83296235, 83296258, 83296418,
      83296421, 83296835, 83297136, 83297158, 83297346, 83297350, 83297524, 83297561, 83298066,
      83301802, 83308591, 83308608,
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
      83295630: 1,
      83295640: 49,
      83295664: 4,
      83295670: 47,
      83295686: 50,
      83295759: 23,
      83295822: 41,
      83295844: 15,
      83295928: 45,
      83296235: 35,
      83296258: 29,
      83296418: 31,
      83296421: 40,
      83296835: 42,
      83297136: 48,
      83297158: 27,
      83297346: 33,
      83297350: 7,
      83297524: 36,
      83297561: 32,
      83298066: 20,
      83301802: 8,
      83308591: 3,
      83308608: 34,
    },
    provenance:
      'Seeded 2026-07-24 from this wiki\'s own catalogue notes, which record the "N/50" written on each drawing. Expanded 2026-07-25 with an on-device visual sweep and direct review of the artwork. 48 of the declared 50 are now identified, all black eyes, clustered in #83294043–#83308608; indices 9 and 22 have not yet been located.',
    seed: { pattern: 'fuck you sketch', in: ['description'] },
  },
  {
    id: 'white-border-abstract',
    label: 'White border abstract',
    slug: 'white-border-abstract',
    blurb:
      'A fifty-piece black-eye run of layered, chaotic portraits, each framed by the same irregular slime-like white border.',
    status: 'complete',
    declaredSize: 50,
    members: [
      83304388, 83307198, 83307280, 83308674, 83309450, 83309489, 83309901, 83310217, 83311096,
      83311179, 83311182, 83311186, 83311209, 83311905, 83311919, 83313077, 83313390, 83313438,
      83313447, 83313557, 83313586, 83313592, 83313617, 83313699, 83313715, 83313719, 83313909,
      83313924, 83313930, 83313947, 83313951, 83314016, 83314020, 83314518, 83314526, 83314535,
      83314562, 83314575, 83314936, 83314944, 83314966, 83314967, 83315112, 83316080, 83316081,
      83316338, 83316379, 83316380, 83316401, 83316867,
    ],
    provenance:
      'Seeded 2026-07-25 from 14 entries labelled "White border abstract" in this wiki\'s own catalogue notes, then expanded with an on-device visual-similarity sweep and maintainer review. Completed 2026-07-26 when the maintainer identified #83304388 as the final member. #83316072 and #83316830 were explicitly rejected during review.',
    seed: { pattern: 'white border abstract', in: ['description'] },
  },
  {
    id: 'pirates',
    label: 'Pirates',
    slug: 'pirates',
    blurb:
      'Tricorn hats, ships, spyglasses, hooks and one bitcoin earring. The same hat — skull and crossbones over an OMB band — recurs across nearly the whole run, which is what marks this as a set rather than a motif that happened to come round twice.',
    status: 'partial',
    declaredSize: null,
    members: [
      60569771, 83296231, 83298016, 83301817, 83302969, 83304370, 83304609, 83307199, 83308657,
      83309456, 83309884, 83309905, 83310004, 83310290, 83310355, 83311047, 83311067, 83311086,
      83311158, 83311213, 83311351, 83311921, 83311939, 83311965, 83312965, 83313589, 83313913,
      83314539,
    ],
    provenance:
      'Seeded 2026-07-24 from this wiki\'s own catalogue notes containing "pirate", then confirmed by eye against the shared hat. 27 black eyes clustered in #83296231–#83314539 plus one earlier orange (#60569771). Open-ended — pieces whose note is blank or does not use the word have not been reviewed.',
    seed: { pattern: 'pirate', in: ['description'] },
  },
  {
    id: 'optimus',
    label: 'Optimus robots',
    slug: 'optimus',
    blurb:
      "Humanoid robots after Tesla's Optimus — working fast food, on the phone refusing a request, pouring oil into its own head. Grouped here by eye: unlike the Fuck You sketches there is no marker in the artwork tying them together, so this one is our reading, not the artist's declaration.",
    status: 'partial',
    declaredSize: null,
    members: [
      83293807, 83294081, 83294082, 83295252, 83295260, 83295275, 83295306, 83295491, 83295498,
      83295503, 83295540, 83295560, 83295634, 83295643, 83295691, 83295695, 83295746, 83295756,
      83295815, 83295915, 83295936, 83296271, 83296354, 83296373, 83296392, 83296420, 83296764,
      83296826, 83299046, 83299885, 83299973, 83301395, 83301785, 83308300, 83309471,
    ],
    provenance:
      'Seeded 2026-07-24 from this wiki\'s own "Optimus" / "Tesla" tags. Expanded 2026-07-25 with an on-device visual-similarity sweep, contact-sheet review, and maintainer corrections. 35 black-eye robots are currently catalogued.',
    seed: { pattern: 'optimus|tesla', in: ['tags'] },
  },
];

// NOT shipped as a series yet — "TT lunch sketches", pieces that appear to be
// dated by the day they were drawn (#83315117 "12/22/24", #83315934 "1/2/25").
// Two members found from two descriptions is a hunch, not a catalogue: there is
// no evidence yet of how big the habit was, and a two-piece chip in the gallery
// filter bar carries no information. Sweep it with
// `pnpm series-scout --seed "lunch sketch"` and promote it here if it turns out
// to be a real run.

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

/** The index written on the piece itself within a numbered set, e.g. "25/50". */
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
