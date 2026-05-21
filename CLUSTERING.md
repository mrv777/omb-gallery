# Wallet clustering

How the on-chain wallet-clustering heuristic works in this repo: signals,
tunables, the live tick vs the recompute pass, the calibration history,
and where to look first if you want to improve it.

## What it's for

Two production surfaces depend on it:

1. **Identity fold** (`cluster_anchors` at `IDENTITY_FOLD_THRESHOLD = 9900`).
   Folds heuristically-linked wallets into a Matrica user's identity for
   the leaderboard, holder profile aggregation, and the activity feed
   `@username` overlay. The fold is built from high-confidence cluster
   edges plus eligible listing-staging edges. **Components containing 2+ distinct Matrica
   users are skipped** — Matrica trumps the heuristic and the system
   never silently re-keys authoritative linkage. Roles stay Matrica-
   only by design (preventing a heuristic match from gaming the catalog).
2. **"Likely linked wallets" panel** on holder profiles
   (`getLikelyLinkedForWallets` at `CLUSTER_THRESHOLD = 9900` —
   intentionally aligned with `IDENTITY_FOLD_THRESHOLD`). Shows
   on-chain-only peer suggestions next to a user's Matrica-confirmed
   siblings. Below 9900 the heuristic mixes in cross-trader pairs
   (active P2P trading partners — different humans whose on-chain
   shape resembles consolidation) and we observed those dominating
   the 95–98% tier on real holder pages. The display-time filter
   (`isCrossTraderEdge` — see §5) is kept as defense-in-depth in case
   the threshold is lowered later for a forensics surface.

It is read by inscription / holder pages and by the activity feed's
username resolver. It does NOT drive notification fan-out — Matrica is
authoritative there.

## File map

- `src/lib/cluster.ts` — framework-free types + `confidenceFromCounts`
  formula + `isCrossTraderEdge` display predicate. Imported by both
  the live tick and the host-side backfill script. **Single source of
  truth for the score → threshold mapping.** Keep this in sync with
  `scripts/backfill-cluster.js`'s mirror.
- `src/lib/clusterStore.ts` — runtime DB-bound layer. Two entry points:
  - `runClusterTick()` (poll mode `cluster`, every 5min in `auto`) —
    incremental CIH + sx pass over new events past the cursor.
  - `runClusterRecompute()` (poll mode `cluster-recompute`, hourly cron) —
    full global pass for the v2 signals (cc / cp / pmx / pmx_rt) that
    depend on whole-corpus fan-out maps.
  - Plus the readers (`getInferredLinksForAddress`,
    `getLikelyLinkedForWallets`, `getClusterAnchorForAddress`,
    `recomputeClusterAnchors`).
- `src/lib/listingStagingStore.ts` — daily recompute for directed
  source -> seller links where a wallet repeatedly receives an OMB and
  lists/sells it within 12 hours. Eligible rows are stored in
  `wallet_staging_edges` and feed `cluster_anchors`; the evidence stays
  separate from `wallet_cluster_edges` confidence.
- `scripts/backfill-cluster.js` — host-side one-shot CIH backfill from
  cached raw txs (`scripts/fetch-raw-txs.js`) + identical v2 recompute
  logic. Run once after a deploy or when bitcoind drifts.
- `cluster-research/` — the calibration scripts that produced the
  current formula. Useful when you want to test a new signal against
  Matrica ground truth without modifying production code.
- DB schema in `src/lib/db.ts` (tables `wallet_cluster_edges`,
  `wallet_staging_edges`, `cluster_blacklist`, `cluster_anchors`);
  `user_version = 32` added the v2 cluster columns and v36 added
  listing-staging edges.

## Signals

Five distinct mechanisms feed the per-edge confidence. Counts are
stored separately from the derived score so threshold tuning doesn't
require recomputing edges.

| signal                           | what it observes                                                                             | who computes it | suppressed when                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------- |
| `cih_count`                      | distinct txs where addr_a and addr_b co-input                                                | live tick       | tx is ACP-PSBT, has blacklisted input, has >20 inputs, or new_owner appears in inputs |
| `self_xfer_*`                    | direct A↔B transferred events with marketplace=NULL                                          | live tick       | either endpoint blacklisted; either endpoint is a multi-source receiver               |
| `co_cons_count`                  | # of distinct destinations bridging two monogamous senders (≤2 lifetime OMB recipients each) | recompute       | bridge is a blacklisted address                                                       |
| `co_parent_count`                | # of distinct non-MSR parents distributing to two monogamous receivers                       | recompute       | parent is itself an MSR but not personal-MSR (excludes exchange withdrawal addresses) |
| `pmx_*` (with `pmx_rt_*` subset) | direct A↔B transfers where one endpoint is a personal-MSR                                    | recompute       | either endpoint is on the hard blacklist (mints/marketplace fee/Liquidium/manual)     |

The `pmx_rt_count` is the subset of `pmx` events where the receiver
**previously owned that inscription** — the round-trip indicator.
Empirically (May 2026 snapshot): legitimate consolidation pmx
round-trips ~47% of the time; cross-trader pmx round-trips ~10%.

A "personal-MSR" is an MSR (≥5 distinct senders via marketplace=NULL
transferred events) that meets at least one of:

- ≥3 of its senders also receive back from it ("bidirectional flow"), OR
- ≥40% of inscriptions it received are still held by it now
  ("hodler consolidator").

Tunables live in `cluster.ts` (exported constants). Don't change them
without re-running the calibration scripts in `cluster-research/`.

## Listing-Staging Fold

Listing-staging is intentionally not a confidence score. It is a
separate directed audit table (`wallet_staging_edges`) for the pattern:
source wallet transfers an OMB to a seller wallet, then that seller
lists or sells the same OMB within 12 hours.

An edge is eligible for identity fold only when all of these hold:

- at least 2 distinct inscriptions have fast (`<=12h`) evidence
- previous event is `transferred`, `marketplace IS NULL`
- previous `new_owner` equals the seller, and previous `old_owner`
  differs from the seller
- neither endpoint is blacklisted or manually excluded
- endpoints do not map to two different real Matrica profiles
- the pair is not already known-same by Matrica or an existing
  cluster edge at `>=9500`

Eligible rows are unioned into `recomputeClusterAnchors()`, so the fold
is site-wide after the daily recompute. The holder page shows the
source -> seller evidence trail; activity rows and leaderboards do not
show an explicit staging badge in v1, though their grouping can change
through `cluster_anchors`.

## Confidence formula

`confidenceFromCounts(c) → integer in [0, 10000]` (readers divide by
10000 if they want a [0, 1] probability).

Per-signal ladders (each takes the _max_ of all firing tiers):

| signal                 | tier 1   | tier 2                | tier 3   | tier 4   |
| ---------------------- | -------- | --------------------- | -------- | -------- |
| cih                    | 1 → 0.80 | 2 → 0.95              | 3 → 0.98 | 5 → 0.99 |
| sx total               | 1 → 0.50 | 3 → 0.80              | —        | —        |
| sx bidir = min(ab, ba) | 1 → 0.92 | 2 → 0.99              | —        | —        |
| cc                     | 1 → 0.80 | 2 → 0.95              | 3 → 0.98 | 5 → 0.99 |
| cp                     | 1 → 0.80 | 2 → 0.95              | 3 → 0.98 | —        |
| pmx total              | 1 → 0.75 | 3 → 0.90              | —        | —        |
| pmx bidir              | 1 → 0.95 | 2 + pmx_rt ≥ 2 → 0.99 | —        | —        |

Cross-mechanism bonuses:

- `cih ≥ 1 && sx_bidir ≥ 1` → 0.99
- `cih ≥ 1 && sx_total ≥ 1` → 0.95
- `cih ≥ 2 && sx_total ≥ 2` → 0.99
- **indep ≥ 2** (any 2 distinct signals firing) → 0.97
- **indep ≥ 3** → 0.99

Indep counts each of {cih, sx, cc, cp, pmx} as one mechanism.

**B1 backoff** (round-trip-gated): if the only signal is pmx and
pmx_bidir ≥ 2 but pmx_rt < 2, cap at 0.95 instead of 0.99. This is
the cross-trader exclusion — two big collectors (ApeSoda↔goot,
JJL↔dor1tolover) who actively trade with each other but no inscription
ever returns to its origin show this exact shape and used to incorrectly
clear the identity-fold band.

## Display-time filter

Public-facing readers (`getInferredLinksForAddress`,
`getLikelyLinkedForWallets`) drop edges that match
`isCrossTraderEdge`:

- both endpoints are MSRs (in `cluster_blacklist` with reason
  `auto-high-degree`), AND
- pmx_rt_count = 0 (no round-trip events), AND
- no anchoring signal (cih = 0, self_xfer = 0, co_parent = 0).

This is layered ON TOP of the score-level B1 backoff. The score change
prevents bad edges from reaching IDENTITY_FOLD; the display filter
prevents the remaining surviving cross-trader edges (cc=1+pmx≥1
combos that crossed 9700 via the indep bonus) from showing on
holder profiles. Underlying data is unaffected — flip the filter off
and the edges are still there.

## Live tick vs recompute

|           | live tick (`cluster`)                                 | recompute (`cluster-recompute`)                                                                                                  |
| --------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| schedule  | every 5min in `auto`                                  | hourly own cron                                                                                                                  |
| signals   | cih + sx (incremental)                                | cc, cp, pmx, pmx_rt (global)                                                                                                     |
| inputs    | new events past poll cursor + bitcoind raw-tx fetch   | full events table                                                                                                                |
| wallclock | ~5s typical                                           | ~5–8s on May 2026 snapshot                                                                                                       |
| writes    | `cih_count` / `self_xfer_*`; preserves cc/cp/pmx columns | cc/cp/pmx columns; recomputes confidence using merged counts; refreshes cluster_anchors and cluster_blacklist (auto-high-degree) |

Why the split: the v2 signals depend on whole-corpus fan-out maps
(monogamy classification of every wallet, MSR classification, personal-
MSR classification) which can't be incrementally maintained on a per-
event basis without a careful diff scheme. A new transferred event
may flip a wallet's monogamy status, which retroactively invalidates
cc/cp edges built when it was monog. The hourly recompute sidesteps
this by always recomputing from scratch.

The live tick **does not touch** cc/cp/pmx columns — its UPSERT
deliberately omits them so existing values survive the conflict
resolution. When it computes confidence for a row, it reads the
existing cc/cp/pmx values from the row first and passes them to
`confidenceFromCounts`.

## Calibration (May 2026 snapshot)

Against Matrica ground truth (5,601 linked wallets across 2,728 users,
of which 700 are multi-wallet → 41,481 same-user pairs):

|                                | v1 (pre-this-branch) | v2 (current)               |
| ------------------------------ | -------------------- | -------------------------- |
| 9500 precision                 | 88.89%               | **93.88%**                 |
| 9500 recall                    | 0.02% (8/41,481)     | **39.70%** (16,467/41,481) |
| 9700 precision                 | 88.89%               | **94.46%**                 |
| 9700 recall                    | 0.02%                | **27.96%**                 |
| 9900 precision (identity fold) | 88.89%               | **88.10%**                 |
| 9900 recall                    | 0.02%                | **0.15%**                  |

Production fold impact at 9900:

|                                                        | v1  | v2     |
| ------------------------------------------------------ | --- | ------ |
| extra wallets folded into Matrica clusters             | 95  | 150    |
| unlinked-only on-chain components                      | 84  | 85     |
| Matrica users with ≥1 on-chain peer suggestion at 9500 | 367 | ~900   |
| total peer suggestions across all users at 9500        | 536 | ~5,000 |

Per-user examples: JJL (197 wallets) went from 0/19,306 pairs recovered
to 78.5%; IOBbiz (33 wallets) from 0% to 100%; NoNam3 from 0 extra
folded wallets to 9. Big collectors who use a personal-consolidator
pattern were entirely invisible to v1 because of the multi-source-
receiver suppression — v2's cc + pmx signals recover them.

## Where v2 still misses (recall)

About 426 of 613 claimed multi-wallet Matrica users still have zero
recall at 9500. Inspecting the list, two main shapes:

1. Users who move OMBs almost exclusively via marketplaces — `sold`
   events are excluded from CIH/sx/cc/cp/pmx by design, so internal
   wallet linkage doesn't appear in the events table.
2. Users whose wallets only ever hold OMBs (no transfers between them
   on the OMB chain). These would need a **funding-source common-root**
   signal — chain-walking each wallet's first funding tx via bitcoind
   and looking for shared ancestors. Deferred to a future iteration;
   it's much heavier (RPC per wallet, cycle/dedup handling) and the
   FP risk is real (anyone funded from a popular faucet/exchange).

## Tuning history

- **2026-04** v1 ships: CIH + direct sx with multi-source-receiver
  suppression + ACP-PSBT gate. Precision good (~89% at 9500), recall
  catastrophic (0.02%).
- **2026-05** v2 ships: adds cc, cp, pmx with personal-MSR
  classification; pmx_rt subset; B1 anchor-required at 9900;
  display-time cross-trader filter. Recall up ~2000×, precision
  preserved.

The full calibration write-up — including the variant tests that
ruled out alternative formulas — is in `cluster-research/REPORT.md`
(generated artifact; useful as a starting point for the next
iteration).

## Improving it next

If you want to push precision: tighten the indep ≥ 2 bonus condition
(currently any two singletons suffice; the variant test "B4" tried
requiring at least one signal to be "strong" — too aggressive on
recall. Maybe a middle ground works).

If you want to push recall: the funding-source common-root signal is
the obvious next candidate. Walk each wallet's first inbound tx via
bitcoind, intern by ancestor address, link wallets sharing an
ancestor within K blocks. FP control via excluding ancestors that
distribute to >N wallets (faucets/exchanges). Run as a backfill-only
mode; one-time per wallet so amortizes well.

The research scripts in `cluster-research/` (snapshot-driven, no
production code touched) are the right scaffold for any new
experiment. `01-audit-v1.js` is the pattern: load Matrica ground
truth, score against it, tabulate by threshold and by per-user.
`08-deeper-analysis.js` shows how to test a new structural signal
against the existing FP/TP populations before committing to a
formula change.

## Operational notes

- **First deploy**: after merging the v32 schema migration, kick the
  recompute manually so leaderboards reflect v2 immediately:

  ```
  curl -fsS -m 60 -H "Authorization: Bearer $INTERNAL_POLL_SECRET" \
    http://localhost:3000/api/internal/poll?mode=cluster-recompute
  ```

- **Cron** (Coolify Scheduled Tasks):

  ```
  17 * * * *  curl -fsS -m 60 -H "Authorization: Bearer $INTERNAL_POLL_SECRET" \
                http://localhost:3000/api/internal/poll?mode=cluster-recompute

  41 3 * * *  curl -fsS -m 60 -H "Authorization: Bearer $INTERNAL_POLL_SECRET" \
                http://localhost:3000/api/internal/poll?mode=listing-staging-recompute
  ```

  Offset the recomputes so they don't collide with the \*/5 `auto` tick,
  the top-of-hour matrica run, or the daily database backup.

- **Idempotence**: the recompute zeroes cc/cp/pmx columns on all
  edges before reapplying — re-running gives the same result.
  Confidence is recomputed in two passes (first using only v1 fields
  for rows untouched by the new accumulator, then with merged counts
  for rows in the accumulator).

- **Cluster_blacklist auto rows**: the recompute writes/refreshes
  `auto-high-degree` entries (one per current MSR). The live tick
  reads those for sx suppression. So new MSRs that emerge between
  recomputes won't be sx-suppressed for up to 1 hour — acceptable.

- **Display filter cache**: `loadMsrSet()` caches the MSR address set
  for 60s per process to avoid one query per "likely linked" lookup.
  Stale by up to 60s; not visible on the surface.
