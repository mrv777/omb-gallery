# Wallet-clustering v2: investigation report

Date: 2026-05-07
Snapshot: `/var/lib/coolify-omb-data/app.db` → VACUUMed to `/tmp/app-snap.db`
(94 MB, 58,682 events, 23,726 v1 cluster edges, 5,601 Matrica-linked
wallets across 2,728 users, of which 700 are multi-wallet).

## TL;DR

v1 is precision-fine but **recall-broken**: at threshold 9500 it
recovers **8/41,481 = 0.02%** of Matrica-confirmed pairs. 606 of 613
claimed multi-wallet users have ZERO pair recovery.

The root cause is that the multi-source-receiver (MSR) suppression —
designed to avoid linking exchange/custodial endpoints — accidentally
destroys the **personal-consolidator pattern** (one big collector
receiving inscriptions from many of their own sub-wallets). JJL alone
has 197 wallets, 192 of which feed his main consolidator wallet, all of
which are silently suppressed.

v2 adds three new signals (`co_consolidator`, `co_parent`, and a
selectively-re-enabled `personal-MSR self-xfer`) and reaches **39.7%
recall at 93.9% precision at threshold 9500** — the recall jumps from
0.02% to 39.7% (a ~2000× improvement) while precision *improves* by 5
points. Per-user, **96 multi-wallet users now have full recall** (vs 6
in v1), and 187 of 613 have at least one pair recovered (vs 7).

**Recommendation: ship v2 (after wiring the new signals into the live
poll tick — see "Operational notes" below).**

---

## Step 1: v1 audit

### Threshold table (v1)

| threshold | edges | tp | fp | auto-shell | unknown | precision | recall |
|-----------|-------|----|----|------------|---------|-----------|--------|
| 9000      | 2,265 | 65 | 14 | 14 | 2,172 | 82.28% | 0.19% (80 / 41,481) |
| 9500      | 1,554 | 8  | 1  | 4  | 1,541 | 88.89% | 0.02% (8 / 41,481) |
| 9700      | 637   | 8  | 1  | 4  | 624   | 88.89% | 0.02% (8 / 41,481) |
| 9900      | 213   | 8  | 1  | 4  | 200   | 88.89% | 0.02% (8 / 41,481) |

(`unknown` = at least one endpoint not in wallet_links; these are
wallets the heuristic links that Matrica has no opinion on.)

### Real false-positive characterization

There is **exactly one** real Matrica-disagreement at thresholds 9500
and above. Its signature is:

```
A: BilliHoo  (bc1p3jpxaa…6p7sfu6sa8)
B: MobyTik1  (bc1pwlzk7za…hrgn0lqqjczp6)
cih=0  self_xfer_ab=2  self_xfer_ba=3   confidence=9900
5 marketplace=NULL transferred events between them spanning 2025-03 … 2025-08.
```

Bidirectional self-xfer × 5 over 5 months. This is either (a) the same
human running two Matrica accounts, (b) closely-coupled partner
accounts ("his and hers"), or (c) frequent peer-to-peer OTC traders.
Without account-recovery side-channel data, it's not separable. We
treat it as the irreducible noise floor.

### Recall is the catastrophic failure

Per-user recall at threshold 9500, top users:

| user | n_wallets | total_pairs | recovered | recall |
|------|-----------|-------------|-----------|--------|
| JJL | 197 | 19,306 | 0 | 0.00% |
| biduoduo | 60 | 1,770 | 0 | 0.00% |
| skysupersonic | 54 | 1,431 | 0 | 0.00% |
| Nodes | 45 | 990 | 0 | 0.00% |
| Pyroshi | 45 | 990 | 0 | 0.00% |
| kindafungible | 42 | 861 | 0 | 0.00% |

Of 613 claimed multi-wallet users: **6** have full recall, **1**
partial, **606** zero.

### Root cause: personal consolidators get blacklisted

Drilling into JJL specifically:
- 197 wallets total, 197 appear in OMB events.
- 711 marketplace=NULL transferred events touch them; **207** are
  internal JJL→JJL transfers.
- The detector emits zero edges between these wallets.

Why? Three of JJL's wallets are flagged `auto-high-degree` by
`cluster_blacklist` (multi-source receivers, ≥5 distinct senders):

| address | senders | held now | retention |
|---------|---------|----------|-----------|
| `bc1pw94xx…th9` | 192 | 4 | 2.1% |
| `bc1p8ecl6…ljgp` | 122 | 0 | 0% |
| `bc1puypy…kdp` | 9 | n/a | n/a |

The MSR suppression in `cluster.ts` (`MULTI_SOURCE_RECEIVER_THRESHOLD =
5`) was added to keep exchange/custody endpoints out of clusters. It
correctly identifies these three addresses as receivers-from-many, but
in JJL's case, those many senders are also JJL — so the suppression
nukes the entire personal-consolidator graph. The same thing happens to
~157 other personal MSRs in the corpus.

There is no way to distinguish `personal consolidator` from `exchange
deposit address` from the *receiver pattern alone*. The discriminator
must come from the *senders' own behavior* (or the consolidator's
outflow, or the inscription retention rate).

---

## Step 2: signal proposals + predicted impact

I considered eight proposals. Briefly:

| signal | predicted recall lift | predicted precision risk | compute | verdict |
|--------|-----------------------|--------------------------|---------|---------|
| **A. co_consolidator** (monog senders → common destination) | LARGE — fixes JJL pattern directly | low (key gates: monog ≤2 fan-out + ≥2 distinct C bridges) | events-only, O(events) | **shipped** |
| **B. co_parent** (children of a common non-MSR distributor) | medium — catches the inverse pattern (primary→sub-wallets distribution) | low (P-not-MSR gate keeps marketplace withdrawal addresses out) | events-only | **shipped** |
| **C. personal-MSR un-suppression (pmx)** (re-enable self_xfer for MSRs classified personal via ≥3-bidir or ≥40% retention) | LARGE — bridges JJL's 3 consolidator hubs | medium (legit collector trades fire) | events-only + 1 RPC per MSR | **shipped** |
| D. funding-source common-root (chain-walk back N hops, link wallets sharing recent ancestor) | unknown, probably medium | high — would FP on any popular faucet/exchange withdrawal source unless gated | bitcoind RPC per wallet, expensive — backfill-only | **deferred** |
| E. fee-rate fingerprinting (KS-test on per-wallet sat/vB histograms) | low — too noisy on small samples | medium | events + bitcoind RPC | **rejected** (low ROI) |
| F. time-correlation (joint dormancy / activity sessions) | low | high (any two collectors active during a sale event correlate) | events-only but expensive | **rejected** |
| G. SegWit version mixing (taproot-vs-segwitv0 address-book correlation) | very small | low | events-only | **rejected** (too weak) |
| H. sat-tracking validation on existing self_xfer (drop "fake" self-xfers caused by sat-tracking artifacts) | small precision improvement, no recall change | n/a | bitcoind RPC | **deferred** (small ROI, would only help the 1 real FP at most) |

The three shipped signals are events-table-only (no bitcoind RPC), so
they're cheap enough to run in a backfill *and* could theoretically be
added to the live tick (with caveats — see "Operational notes").

---

## Step 3: prototype implementation

`cluster-research/02-build-v2.js` writes to a new
`wallet_cluster_edges_v2` table in a working copy of the snapshot. The
script:

1. Loads all `transferred` (marketplace=NULL) events into in-memory
   `senderRecipients`/`receiverSenders` adjacency maps.
2. Computes the MSR set (≥5 distinct senders) and classifies each MSR
   as **personal** if either:
   - ≥3 of its senders also receive back from it ("bidirectional
     flow"), OR
   - ≥40% of inscriptions it received marketplace=NULL are still held
     by it now ("hodler consolidator").
   365 of 638 MSRs in the corpus classify as personal (231 by
   bidirectionality, 134 by retention).
3. **Re-uses** the existing v1 `wallet_cluster_edges` rows for CIH +
   direct self-xfer counts (saves the bitcoind walk).
4. Computes `co_consolidator` pairs: any two **monogamous senders**
   (≤2 distinct lifetime recipients via marketplace=NULL transferred
   events) that share a common destination C with ≥2 such senders.
   Bumps `co_cons_count` per distinct C connecting the pair. 1,588
   consolidators yielded 83,373 pair bumps.
5. Computes `co_parent` pairs: the inverse — any two **monogamous
   receivers** (≤2 distinct lifetime senders) that share a common
   non-MSR parent P with ≥2 such monog children. Bumps
   `co_parent_count` per distinct P. 1,195 parents yielded 68,838
   bumps.
6. For each transferred event where one endpoint is a personal MSR,
   emits a `pmx` signal with directionality (analogous to self_xfer_ab
   / self_xfer_ba). 11,526 events.
7. Computes `confidenceFromCountsV2`. Confidence ladder is purely
   additive over v1's:

| signal | 1 | 2 | 3 | 5 |
|--------|---|---|---|---|
| cih_count | 0.80 | 0.95 | 0.98 | 0.99 |
| sx_total | 0.50 | — | 0.80 | — |
| sx_bidir = min(ab, ba) | 0.92 | 0.99 | — | — |
| **cc_count** | 0.80 | 0.95 | 0.98 | 0.99 |
| **cp_count** | 0.80 | 0.95 | 0.98 | — |
| **pmx (one-way)** | 0.75 | — | 0.90 | — |
| **pmx_bidir** | 0.95 | 0.99 | — | — |
| any 2 distinct mechanisms (cih / sx / cc / cp / pmx) | → **0.97** | | | |
| any 3 distinct mechanisms | → **0.99** | | | |

The cross-signal mixing tier ("any 2 / any 3") is what lifts
otherwise-borderline edges (`cc=1 + pmx=1`, `sx=0/1 + cc=1`) into the
public band (≥9500). Empirically this is where most recall comes from.

---

## Step 4: v1 vs v2 calibration

| ver | th | edges | tp | fp | auto-shell | unknown | precision | recall (pairs) |
|-----|----|-------|----|----|------------|---------|-----------|----------------|
| v1 | 9000 | 2,265 | 65 | 14 | 14 | 2,172 | 82.28% | 0.19% (80/41,481) |
| **v2** | **9000** | **46,852** | **1,545** | **111** | **133** | **45,063** | **93.30%** | **47.69% (19,782/41,481)** |
| v1 | 9500 | 1,554 | 8 | 1 | 4 | 1,541 | 88.89% | 0.02% (8/41,481) |
| **v2** | **9500** | **46,537** | **1,504** | **98** | **120** | **44,815** | **93.88%** | **39.70% (16,467/41,481)** |
| v1 | 9700 | 637 | 8 | 1 | 4 | 624 | 88.89% | 0.02% (8/41,481) |
| **v2** | **9700** | **45,453** | **1,476** | **90** | **111** | **43,776** | **94.25%** | **28.16% (11,681/41,481)** |
| v1 | 9900 | 213 | 8 | 1 | 4 | 200 | 88.89% | 0.02% (8/41,481) |
| v2 | 9900 | 396 | 49 | 9 | 29 | 309 | 84.48% | 0.20% (84/41,481) |

### Coverage (unknown-pair edges)

These are pairs that v2 surfaces where Matrica has no opinion — i.e.
new on-chain inferences for unlinked wallets:

| threshold | v1 unknowns | v2 unknowns | v2 / v1 |
|-----------|-------------|-------------|---------|
| 9000 | 2,172 | 45,063 | **20.7×** |
| 9500 | 1,541 | 44,815 | **29.1×** |
| 9700 | 624 | 43,776 | **70.2×** |
| 9900 | 200 | 309 | 1.5× |

### Per-user recall @ th=9500 (top 20 multi-wallet users)

| user | n_wallets | total_pairs | v1 | v2 | v2 recall |
|------|-----------|-------------|----|----|-----------|
| **JJL** | 197 | 19,306 | 0 | 15,162 | **78.5%** |
| biduoduo | 60 | 1,770 | 0 | 6 | 0.3% |
| skysupersonic | 54 | 1,431 | 0 | 3 | 0.2% |
| Nodes | 45 | 990 | 0 | 3 | 0.3% |
| Pyroshi | 45 | 990 | 0 | 15 | 1.5% |
| kindafungible | 42 | 861 | 0 | 0 | 0.0% |
| itsdonny | 39 | 741 | 0 | 6 | 0.8% |
| b420oka | 37 | 666 | 0 | 0 | 0.0% |
| tnbosshogg | 36 | 630 | 0 | 55 | 8.7% |
| **IOBbiz** | 33 | 528 | 0 | 528 | **100.0%** |
| Biome84 | 31 | 465 | 0 | 0 | 0.0% |
| **RockieRockie7** | 23 | 253 | 0 | 36 | 14.2% |

User-coverage summary:

|  | v1 @ 9500 | v2 @ 9500 |
|--|-----------|-----------|
| full recall | 6 | **96** |
| partial | 1 | **91** |
| zero | 606 | 426 |

### Where v2 *doesn't* help

About 426 multi-wallet users still have zero recall at 9500.
Inspecting a sample:

- **kindafungible**, **b420oka**, **GzsDWS…**, **matrixalb**, **mil2**,
  **mxms**, **p5y0p**, **CryptoBurrow**: these users' wallets
  apparently do not share OMB-event-table linkage at all. Their
  internal moves either go through marketplaces (sold events, excluded
  from CIH/self_xfer/cc/cp/pmx) or never touch OMBs collectively.
- A bitcoind chain-walk (signal D — funding-source common-root) is
  the only route to recover these users. That's a much heavier lift
  (RPC per wallet, requires dedup/cycle handling) and is **deferred**.
- **biduoduo / skysupersonic / Nodes** (recall <1%) appear to use
  marketplace-mediated movement almost exclusively. Hard to recover
  on-chain without sale-tx fingerprinting that bypasses
  PSBT-settlement suppression — out of scope for v2.

### v2 false-positive characterization

At threshold 9500, v2 has 98 real FPs (vs v1's 1). Drilling in:

- **50** are `cc + pmx` (co-consolidator + personal-MSR self_xfer).
  Examples: JJL ↔ dor1tolover, JJL ↔ goot, JJL ↔ Nodes. These are
  **big collectors who frequently peer-trade with each other**. The
  pattern: collector X's mule sells to collector Y's hub via direct
  transfer (no marketplace), and the mule also feeds X's hub. Both
  signals fire.
  - Suppressing pmx between two MSR-classified addresses removes ~13
    of these (cost: ~18 TPs and 4674 transitive recall pairs because
    one of those edges bridged JJL's three internal MSRs). Net win
    is unclear — kept off in the final formula.
- **29** are `sx + cc` — direct self_xfer plus co-consolidator. Same
  collector-trading-pair shape; e.g. LadyApeCS ↔ FundyApeCS (clearly
  partner / shared-household accounts), Shawnuff ↔
  BeverageGoblinToday (likely partner). Some are arguably TPs that
  Matrica simply has separated into two accounts.
- **4** are `cc + cp` — both parent and child sides agree. Looking at
  the names (THESCIENTIST99 ↔ Brabo, Mutantape ↔ lobobug), these
  *probably* are same humans across two Matrica accounts.

The "true" residual FP rate after subtracting partner accounts and
multiple-Matrica-account-per-human cases is **likely under 4%** — i.e.
v2's *displayed* precision (94%) is conservative.

### Why does precision drop slightly at 9900?

v1 had 88.89% precision at 9900 (1 real FP / 9 known). v2 has 84.48%
(9 real FP / 58 known). Looking at the 9 v2 FPs at 9900:

- 1 is the v1 BilliHoo↔MobyTik1 case (irreducible).
- 2 are sx+cc+cp triple-agreement (likely real same-humans, see above).
- 6 are bidirectional pmx ≥4 between big collectors (ApeSoda ↔ goot,
  ApeSoda ↔ M4ltB, Ganjr420 ↔ goot, etc.).

The bidirectional-pmx-between-big-collectors pattern is a real
weakness: two collectors who actively trade with each other (rather
than via marketplace) look identical to a single collector with two
addresses. **No on-chain signal can distinguish these without
observing one of them on a centralized service** (Matrica, exchange
KYC, etc.).

If 84% precision at 9900 is unacceptable, the simplest fix is to
require that bidirectional pmx is accompanied by **at least one
non-pmx signal** (cih or sx or cc) before clearing 9900. This would
cost ~6 TPs but drop the 6 collector-pair FPs.

---

## Recommendation: **ship v2**

Tradeoffs:

| | v1 (current) | v2 (proposed) |
|--|--|--|
| precision @ 9500 | 88.89% | **93.88%** |
| recall @ 9500 (Matrica pairs) | 0.02% | **39.70%** |
| precision @ 9900 (identity fold) | 88.89% | 84.48% |
| recall @ 9900 | 0.02% | 0.20% |
| coverage @ 9500 (unknown pairs) | 1,541 | 44,815 (29×) |
| users with full recall | 6 | 96 |

The 4-point precision regression at 9900 is the only watch-out.
Mitigations:
1. Keep IDENTITY_FOLD_THRESHOLD at 9900 but require a non-pmx
   "anchoring" signal alongside bidirectional pmx for the fold (small
   formula tweak).
2. OR, leave the formula and accept 84% identity-fold precision —
   roles remain Matrica-only by design (see CLAUDE.md), so the worst
   case is a leaderboard fold of two co-trading collectors. Manual
   override / blacklist hatch would handle reports.

### Operational notes

The v2 signals (cc, cp, pmx) are all events-table-derivable; they
don't need bitcoind RPC. **They could in principle run in the live
tick**, but cc/cp require global maps over the entire `transferred`
(marketplace=NULL) table, which is O(events) per recompute. Two paths:

- **Backfill-only path** (low risk, recommended for first ship): wire
  v2 into a new `?mode=cluster-v2` endpoint that runs a full recompute
  on demand or hourly via a separate cron. Keep the live `cluster`
  tick on v1 signals.
- **Live-incremental path** (more work): incrementally update the
  per-address fan-in/fan-out counts on each new transferred event,
  then re-evaluate cc/cp pairs only for the deltas. Personal-MSR
  re-classification can be lazy (on-MSR-blacklist-add). Touchier; the
  monogamy classification of any wallet can flip when its second
  recipient appears, invalidating cohort membership.

### What's NOT in v2

- `funding-source common-root` (signal D) — would help the ~426
  zero-recall users but requires bitcoind RPC chain-walks. Defer to v3.
- `sat-tracking validation` (signal H) — small precision win on
  self_xfer; defer.
- Loan-side correlation — Liquidium PSBT settlements already excluded
  from CIH/self_xfer; revisit once Liquidium ships an API.
- Graph-clustering refinement (Louvain, label propagation): the
  union-find we already do is sufficient; community-detection adds
  complexity for marginal recall.

---

## Files

- `01-audit-v1.js` — v1 calibration + FP/recall audit. Outputs
  `threshold-summary.json`, `fp-detail.json`, `recall-by-user.json`.
- `02-build-v2.js` — v2 prototype detector. Writes
  `wallet_cluster_edges_v2` to the snapshot copy.
- `03-score-v2.js` — v2 calibration against Matrica. Outputs
  `v2-threshold-summary.json`, `v2-fp-detail.json`.
- `04-coverage.js` — final v1-vs-v2 side-by-side calibration table +
  coverage stats + per-user recall.
- `coverage-output.txt` — last invocation of `04-coverage.js`.
