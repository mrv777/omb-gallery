# On-chain activity tagging

How we classify on-chain events (transfers, sales, mints, loans) for the OMB collection. **Chain-primary, APIs verify only.** This document is the source of truth for what we tag, why, and how confident we are.

> **Operating principle.** All tags must derive from on-chain evidence. Third-party APIs (Satflow, ord.net, Magisat UI, OKX, Magic Eden) are used **only** for spot-checking our own detection. We will never re-introduce a tag whose only evidence is a 3rd-party API claim.

## 1. Confidence tiers

Every event has an `event_type` and (optionally) a `marketplace`. Each tag falls into one of these tiers:

| Tier | Meaning | Allowed sources |
|---|---|---|
| **chain-truth** | Directly observable on-chain. Cannot be wrong by construction. | UTXO movement, block height, taproot output keys, witness data |
| **chain-fingerprint** | Identified by a verified on-chain pattern with **≥3 confirmed test fixtures** (true positives) and **≥1 confirmed counter-example** (true negative). | Documented in this file + `scripts/known-transactions.json` |
| **legacy-3rd-party** | Existing rows tagged before this policy. Kept but not extended. | Satflow API, ord.net history backfill |
| **untagged** | We see the on-chain event but can't classify the marketplace. Better than mislabeling. | `marketplace = NULL` on `sold` rows |

A new fingerprint cannot promote from heuristic→chain-fingerprint without the test fixtures.

## 2. Confirmed facts

The atomic things we are certain about, with the on-chain evidence each rests on. Anything not in this section is either refuted (§4) or unknown (§5).

### 2.1 OMB minting wallets

One wallet per color held the original mint distribution and outflowed inscriptions to first buyers. Some of these wallets are still active beyond their distribution window (orange, black) and continue to do regular post-mint movements — those movements are NOT mints. Tagging requires three constraints to all hold:

1. `events.old_owner = wallet.addr`
2. `inscriptions.color = wallet.color`
3. `events.block_timestamp ≤ wallet.valid_until_ts`

| Color | Wallet | Observed outflow window | Cutoff (`valid_until_ts`) | Outflows in window |
|---|---|---|---|---|
| Green | `bc1pyl6g53k220rggaukyx929qnnxqw8vzt8xrfw88muw22pnwfvqjkqreeqpw` | 2023-06-29 → 2023-07-05 | 2024-01-01 (1704067200) | 1,883 |
| Blue | `bc1p53jarhva6eg4wggv7apndndger4y4gy9s6mf3gp0rttdzensu2nq3598ur` | 2023-05-08 → 2023-11-14 | 2024-06-01 (1717200000) | 98 |
| Red | `bc1pg8jywvphzeyf9fg8tsac6jq7ft2dzz7pez720r6uanumn6lyayeshg46es` | 2023-03-31 → 2023-11-06 | 2024-06-01 (1717200000) | 91 |
| Orange | `bc1p4a29gzwlear4csc9sz6ll97j9yl7877tasy75evq8wm6r3admtqq3m72k0` | 2024-03-15 → 2025-04-09 | 2025-09-01 (1756684800) | 2,915 |
| Black | `bc1q86ssqhk04chjah6kkuqw3fv5wjy7v2nflyg50t` | 2025-02-25 → 2025-02-26 | 2025-09-01 (1756684800) | 3,752 |

Cutoffs sit ≥4 months after each wallet's last observed mint outflow. The "definitely-not-a-mint" guardrail (current_date − 6 months ≈ 2025-11-04) is well after every cutoff, so a recent transfer can never trip a mint tag.

**Counter-example (true negative):** the black wallet (`bc1q86ss…`) has 2 historical outflows tagged with **red**-color OMBs (it received them and re-sent them, unrelated to its mint role). Color-match constraint #2 above correctly rejects these — they remain `transferred`.

- **Confidence:** chain-truth (direct outflows + simple time bound).
- **Verification:** user-supplied wallets, outflow counts cross-checked against the `events` table.
- **Code:** `MINT_WALLETS` const at the top of `src/lib/db.ts`. Migration v23 (greens only, no time bound) → v24 (all 5 colors, time-bounded, with aggregate recompute).

### 2.2 Liquidium loan escrow signature

When a Liquidium loan resolves (default or unlock) via taproot script-path spend, the witness reveals:

- **Internal pubkey** (bytes 1–32 of the control block — the last witness item): `93674766caa3db9c0f63c4b74f302510c509d6d0ffac9d67214d8f03cb2ed27a`
- **Tap-tree shape** (legacy era): exactly 2 leaves
  - Default leaf: `<csv_timestamp> OP_CSV OP_DROP <lender_pubkey> OP_CHECKSIG`
  - Unlock leaf: `<borrower_pubkey> OP_CHECKSIG`

**Empirical coverage:** 1,544 of 1,547 detected loan resolutions in our DB use this exact internal pubkey. The 3 outliers (2× `428a7f5cf69790ede30f060492cae580ddb98c7ef705939467d9c1bf73f1a60b`, 1× `2e8f1452bf3804272a5a7e1d0cc99a519b1b8891a8668e88c92794d8cfe40eda`) have a single-leaf tap-tree (no default path) — structurally impossible for a Liquidium loan, must be misdetections of some other escrow service.

- **Confidence:** chain-fingerprint (cryptographic — can be verified against any spend witness).
- **Test fixtures (true positives):** see §6.1.
- **Counter-example (true negative):** `3bd09bfc7d229428cb99cfb44170e939b80a297b2f35f2e2ea2af7df0da22711` (different internal pubkey, single-leaf tree — NOT Liquidium).
- **Tag rule:** Phase 4 detector (`src/lib/loanDetect.ts`) must emit `loan-defaulted` / `loan-unlocked` / `loan-repaid` / `loan-originated` only when the spend's control-block internal pubkey equals `9367…d27a`. The detector currently does not enforce this — see §7 for the cleanup.

### 2.3 Liquidium loan principal *cannot* be detected on-chain for unspent escrows

Given a candidate escrow output key Q and the known internal pubkey P, the relationship `Q = lift_x(P) + tweak·G` does not constrain Q (every output key admits this form for *some* tweak). Computing the actual tweak requires the merkle root, which depends on per-loan parameters (CSV timestamp, lender pubkey, borrower pubkey) we don't have until the escrow spends.

- **Confidence:** chain-truth (this is a property of BIP-341).
- **Implication:** there is **no** on-chain detection rule for currently-active Liquidium loans. The previous `active_loan_escrows` table populated 32 false positives. We will not maintain that table.

### 2.4 Self-transfers (`old_owner == new_owner`) are not real transfers

Postage moves, UTXO consolidation, and fee bumps within the same wallet appear as transfers in raw ord output but represent no change of ownership. Schema v21 deletes them retroactively and the live ord poll skips them.

- **Confidence:** chain-truth (literally same address on both sides).
- **Tag rule:** drop at insert time + already-backfilled.

### 2.5 Satflow-recorded sales (legacy, kept under legacy-3rd-party tier)

282 `sold` events have `marketplace = 'satflow'`. These came from Satflow's `/v1/activity/sales` endpoint pre-policy. Kept as legacy data; not extended (the API enrichment continues for now but new rules should target the on-chain Satflow PSBT signature directly — see §5).

## 3. Tagging rules currently active

| `event_type` | When emitted | Source rule | Confidence tier | Marketplace tag |
|---|---|---|---|---|
| `transferred` | ord poll detects UTXO change for any inscription, OR `backfill-transfers.js` walks chain history | UTXO movement | chain-truth | NULL |
| `mint` | `old_owner` matches a registered mint wallet (§2.1) AND inscription color matches | Wallet → color map | chain-truth | NULL |
| `sold` | (see §3.1 below — currently mixed quality) | Multiple paths | mixed | varies |
| `listed` | Satflow API listings stream | Satflow | legacy-3rd-party | `'satflow'` |
| `loan-originated` / `loan-defaulted` / `loan-unlocked` / `loan-repaid` | Phase 4 detects an OP_CSV+OP_DROP script-path spend; traces back to origination | `src/lib/loanDetect.ts` | mixed (see §2.2) | NULL |

### 3.1 `sold` events — current state of mixed quality

| Source key in `raw_json` | Count | Tier | Action |
|---|---|---|---|
| `ord-net-history-backfill` | 15,706 | legacy-3rd-party | Keep as-is. Marketplace already NULL. |
| `onchain-coop-heuristic` (confidence: medium) | 5,085 | **suspect** — at least one (#83309450) was a verified false positive | **§7.1: needs audit** |
| `onchain-heuristic` (Layer 1 ACP, confidence: high) | 18 | chain-fingerprint candidate | Verify and promote. See §6.2. |
| Satflow | 282 | legacy-3rd-party | Keep as-is. |

## 4. Refuted hypotheses (do not re-introduce)

These were briefly believed and then disproven. Each is recorded so a future session doesn't re-derive the wrong conclusion.

### 4.1 ❌ "57 active Liquidium loans" matches reality

The original Phase 7 detector matched 57 candidates against Liquidium's UI count. Audit showed 32 of 33 entries had `vout[1] = bc1papmpmu0…59se9u` (a marketplace fee output) — they were sales, not loans. The 57-match was coincidence. **Phase 7 is broken; cannot be salvaged from chain alone.**

### 4.2 ❌ `bc1papmpmu0…59se9u` is the Magisat fee address

Briefly tagged 849 events as `marketplace = 'magisat'`. User-supplied counter-evidence:
- Real Magisat sale of #11299610 used fee output `3Ke21os…` (P2SH), NOT `bc1papmpmu0…`
- #83309450 (which had `bc1papmpmu0…` as vout[1]) does not appear on Magisat's UI

Address is a real recurring fee-collector (57+ OMB 4-out sales / 30d window, fees ~0.7% of payout) but is **not** Magisat. Reverted in commit `fdfc6a98`. Don't relabel without external positive identification.

### 4.3 ❌ The 4-output `vin[0]=P2TR + vout[0]=P2TR` shape identifies Liquidium loans

Same shape is used by marketplace sales (buyer + fee + seller payout + buyer change). Both classes trip the structural test. Rejected.

### 4.4 ❌ The borrower-self-funded shape (`vout[1].address == vin[0].address`) is a Liquidium fingerprint

The one candidate it produced (#83296407, tx `d5196bd8…`) routes 46k sats to `bc1qt40uwskakmw4vze299khx4n6tea4xc6satfl0w`, an address that participates in a different shape (one example tx had `vin[0]=P2WSH`, `vout[2]=OP_RETURN` — clearly a paid OMB-parking listing service, not a loan). The "1 high-confidence loan" is probably also misclassified. **Not enough signal to keep.**

### 4.5 ❌ Internal pubkeys other than `9367…d27a` indicate Liquidium

Three loan-* events use different pubkeys (`428a…`, `2e8f…`) with single-leaf tap-trees. A Liquidium loan must have a default path — these aren't Liquidium. The Phase 4 detector was over-greedy; it accepted any OP_CSV+OP_DROP regardless of internal pubkey.

## 5. Open questions / what needs more data

These are the gaps. Each is a **specific** thing we'd need before we can tag confidently.

### 5.1 What is `bc1papmpmu0xzfvw4x9qe4jstgxfnfy5q8zhh6xredjxd86ca74uph3s59se9u`?

A real recurring fee-collector address but unidentified. Not Magisat, not Liquidium, not in any loan event role. Could be OKX, OrdSwap, ord.io, or a custom escrow service.

**To resolve:** check 3-5 of the txs that have this as vout[1] against each marketplace UI (or DM the marketplaces with the txid). Once positively identified by **2+ corroborating sources**, add a fingerprint rule.

**Sample txs to spot-check:** `5c2e3ba9ab42fd5d2f3752d15cd5a0154b903668391fe6301f895e1ed1fa73d9` (#11287305, sold 3d ago — user already confirmed this one was a sale, marketplace unknown), `b9a77cffc3914af60564d49bb34a5d421075780e91cebaa20cad639530671d57` (#83309450, NOT on Magisat).

### 5.2 Magisat fingerprint

We have **one** real Magisat sale fixture: tx `35448512f39f65aaf9fa86794cb1dbcd7dc219962c9f0f83dcea9df7230cfe27` (#11299610). Shape: 6-in / 7-out. vout[3] = `3Ke21osfhEbEryUeqdwAuAY8VKxm5B9uB2` (P2SH, 75k sats — candidate Magisat fee address).

**To resolve:** collect 2+ additional confirmed Magisat sales, verify if `3Ke21os…` recurs OR find the actual Magisat fingerprint.

### 5.3 Magic Eden / OKX / Ord.io / OrdSwap fingerprints

Zero confirmed fixtures so far. All `marketplace=NULL` `sold` rows from `ord-net-history-backfill` could be from any of these.

**To resolve:** for each marketplace, gather ≥3 confirmed-true sale fixtures and ≥1 confirmed-true non-sale (or sale-from-different-marketplace) fixture. Then derive the on-chain pattern (fee output address, sighash flags, n_in/n_out shape, etc.).

### 5.4 Modern Liquidium loan-origination shape (if any)

We've only confirmed legacy 4-out, 3PizFz9-lender era loans. Modern loans may use different shapes (single-tx with no lender input, separate-tx flows, etc.). Cannot detect any of them on-chain currently.

**To resolve:** wait for Liquidium API access. No on-chain path forward.

### 5.5 Other-color mint wallets

**Resolved 2026-05-04.** All 5 colors registered — see §2.1.

### 5.6 Satflow on-chain fingerprint

282 sales currently tagged `marketplace='satflow'` via the Satflow API. To move off the API dependency, we need the on-chain Satflow signature. Likely uses SIGHASH_ANYONECANPAY (the existing Layer 1 ACP detector might be detecting Satflow sales already — we should verify).

**To resolve:** cross-check the 282 Satflow-tagged txs against the 18 ACP-detected sales; if they overlap, ACP detection IS Satflow detection.

## 6. Test corpus

Authoritative known-good fixtures. Updated when new examples are confirmed. Mirror lives in `scripts/known-transactions.json` (the JSON is the machine-readable source; this section is a human-readable summary).

### 6.1 Liquidium loan resolutions (true positive)

| Inscription | Type | Tx | Era |
|---|---|---|---|
| 10444091 | default | `fb8259cd3d3c18d2ed037f3d91323766a783635dff42fa8871174876475d85fb` | legacy 3PizFz9 |
| 11299730 | default | `16459e791f516c694636fc4320bd9ef550b2a51f69b69ab79ce59cd6d71cdbe4` | legacy 3PizFz9 |
| 60566736 | unlock | `7c3d11e2f323ea628481585fc520b7abb4d7cd2055553d3d1b8cde02037e6cd5` | legacy 3PizFz9 |
| 60566736 | repayment | `7a0618d95d8f5a238308b6854393e5d50a7f5bfe99f693ddb3b2db4608f0d091` | (BTC-only repayment) |

All three resolution-type fixtures verify against internal pubkey `9367…d27a`.

### 6.2 ACP-style sale detection (Layer 1 onchain heuristic)

18 events currently tagged. Need to spot-check a sample to confirm they're real sales (and identify which marketplaces use ACP). **Action item:** sample 5, verify externally, document findings here.

### 6.3 Magisat sale (true positive — N=1, needs more)

| Inscription | Tx | Notes |
|---|---|---|
| 11299610 | `35448512f39f65aaf9fa86794cb1dbcd7dc219962c9f0f83dcea9df7230cfe27` | 6-in / 7-out, vout[3]=`3Ke21os…` (75k sats) |

### 6.4 Mint wallets (chain-truth, N=8,739 across 5 colors)

See §2.1 for the full table. All five colors covered.

### 6.5 Counter-examples (true negatives — important for keeping fingerprints honest)

| Tx | Why this is NOT what it might appear to be |
|---|---|
| `b9a77cffc3914af60564d49bb34a5d421075780e91cebaa20cad639530671d57` (#83309450) | Has `bc1papmpmu0…59se9u` as vout[1] — NOT a Magisat sale. Refutes §4.2. |
| `5c2e3ba9ab42fd5d2f3752d15cd5a0154b903668391fe6301f895e1ed1fa73d9` (#11287305) | Has `bc1papmpmu0…59se9u` as vout[1] — confirmed sale but marketplace unknown. Refutes §4.3 (4-out shape ≠ loan). |
| `3bd09bfc7d229428cb99cfb44170e939b80a297b2f35f2e2ea2af7df0da22711` (#11299747) | OP_CSV-less, single-leaf tap-tree, internal pubkey `428a…` — Phase 4 misclassified as `loan-unlocked`. Refutes §4.5. |
| `d5196bd8b3ae4a1a23975e40d88edc7c30cc42ba5df47b7c2b41fa8a6d5aeba5` (#83296407) | 4-out borrower-self-funded shape, but routes 46k sats to `bc1qt40u…` which is a known non-Liquidium service. Refutes §4.4. |

## 7. Audit + cleanup plan for existing data

Three groups of currently-stored tags need attention.

### 7.1 5,085 `onchain-coop-heuristic` `sold` events (suspect)

Layer-2 cooperative-sale detection. The user spot-checked one (`b9a77cffc3914a…`, #83309450) and the matched "sale" doesn't show up on Magisat where we attributed it. Need to either:

- **(a) Revert all to `transferred`** with a `source = 'reverted-from-coop-heuristic'` tag for traceability. Loses 5,085 sale signals — many of which were probably real but unverifiable.
- **(b) Sample 50 randomly, verify externally, decide based on hit rate**. If hit rate is ≥90% revert is overkill; if ≤50% revert is justified.
- **(c) Keep but mark as `confidence=low`** in raw_json so the UI can downplay them. Doesn't fix the data, just labels it.

Recommend **(b)**. A 50-sample audit is cheap; the right action depends on the answer.

### 7.2 3 misclassified loan resolutions

Drop the 2 `428a…`-pubkey events and 1 `2e8f…`-pubkey event from loan-* event types — they're not Liquidium. Phase 4 also needs the pubkey check added going forward.

### 7.3 `active_loan_escrows` table

Drop entirely (table + Phase 7 detector code + `/explorer/currently-loaned` route + cron mode). No on-chain detection rule satisfies §1's principles for this. Replace UI card with `Most Loaned Against` (lifetime `loan_count` from Phase 4's resolved data — accurate, derives from §2.2).

## 8. How to add a new tagging rule

Required steps before any code change touches the tagger:

1. **Hypothesis.** State the rule: "txs with property X are marketplace Y sales." Be specific about what X is (fee address, sighash flag, output pattern, etc.).
2. **Find ≥3 true positives.** Independently confirmed: each tx must be visible on the marketplace's UI as a real sale, OR confirmed by direct counterparty.
3. **Find ≥1 true negative.** A tx that satisfies property X but is NOT marketplace Y. If you can't find one, your rule is too loose.
4. **Code the rule** in `src/lib/<area>Fingerprint.ts` (one file per concept). Reference the test corpus by tx id in a code comment.
5. **Add fixtures to `scripts/known-transactions.json`** — both true positives and true negatives, with `expected_type` and a description.
6. **Update §6 of this doc** with the new fixtures.
7. **Backfill carefully:** dry-run against a prod snapshot, audit a 10-row sample, then live with `notify_pending` skipping (historical re-tagging must not alert subscribers).
8. **Cite this doc** in the commit message.

If a rule is later refuted, **document it in §4** rather than silently removing — future sessions need to know what was tried and why it didn't hold.

## 9. Anti-patterns to avoid

- Tagging based on a single observation. "I saw 50 txs share this address therefore it's marketplace X" is not enough — recurrence proves *something is recurring*, not what.
- Trusting a 3rd-party API as authoritative. APIs are spot-check tools. If our chain detection disagrees with an API, investigate; don't just defer to the API.
- Bundling unrelated tagging changes in one commit. Each marketplace, each event_type, each protocol gets its own commit so reverts are surgical.
- Burying a refutation. If something doesn't pan out, it goes in §4 with the reason.
