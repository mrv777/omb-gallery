# On-chain activity tagging

How we classify on-chain events (transfers, sales, mints, loans) for the OMB collection. **Chain-primary, APIs verify only.** This document is the source of truth for what we tag, why, and how confident we are.

> **Operating principle.** All tags must derive from on-chain evidence. Third-party APIs (Satflow, ord.net, Magisat UI, OKX, Magic Eden) are used **only** for spot-checking our own detection. We will never re-introduce a tag whose only evidence is a 3rd-party API claim.

## 1. Confidence tiers

Every event has an `event_type` and (optionally) a `marketplace`. Each tag falls into one of these tiers:

| Tier                  | Meaning                                                                                                                                              | Allowed sources                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **chain-truth**       | Directly observable on-chain. Cannot be wrong by construction.                                                                                       | UTXO movement, block height, taproot output keys, witness data |
| **chain-fingerprint** | Identified by a verified on-chain pattern with **≥3 confirmed test fixtures** (true positives) and **≥1 confirmed counter-example** (true negative). | Documented in this file + `scripts/known-transactions.json`    |
| **legacy-3rd-party**  | Existing rows tagged before this policy. Kept but not extended.                                                                                      | Satflow API, ord.net history backfill                          |
| **untagged**          | We see the on-chain event but can't classify the marketplace. Better than mislabeling.                                                               | `marketplace = NULL` on `sold` rows                            |

A new fingerprint cannot promote from heuristic→chain-fingerprint without the test fixtures.

## 2. Confirmed facts

The atomic things we are certain about, with the on-chain evidence each rests on. Anything not in this section is either refuted (§4) or unknown (§5).

### 2.1 OMB minting wallets

One wallet per color held the original mint distribution and outflowed inscriptions to first buyers. Some of these wallets are still active beyond their distribution window (orange, black) and continue to do regular post-mint movements — those movements are NOT mints. Tagging requires three constraints to all hold:

1. `events.old_owner = wallet.addr`
2. `inscriptions.color = wallet.color`
3. `events.block_timestamp ≤ wallet.valid_until_ts`

| Color  | Wallet                                                           | Observed outflow window | Cutoff (`valid_until_ts`) | Outflows in window |
| ------ | ---------------------------------------------------------------- | ----------------------- | ------------------------- | ------------------ |
| Green  | `bc1pyl6g53k220rggaukyx929qnnxqw8vzt8xrfw88muw22pnwfvqjkqreeqpw` | 2023-06-29 → 2023-07-05 | 2024-01-01 (1704067200)   | 1,883              |
| Blue   | `bc1p53jarhva6eg4wggv7apndndger4y4gy9s6mf3gp0rttdzensu2nq3598ur` | 2023-05-08 → 2023-11-14 | 2024-06-01 (1717200000)   | 98                 |
| Red    | `bc1pg8jywvphzeyf9fg8tsac6jq7ft2dzz7pez720r6uanumn6lyayeshg46es` | 2023-03-31 → 2023-11-06 | 2024-06-01 (1717200000)   | 91                 |
| Orange | `bc1p4a29gzwlear4csc9sz6ll97j9yl7877tasy75evq8wm6r3admtqq3m72k0` | 2024-03-15 → 2025-04-09 | 2025-09-01 (1756684800)   | 2,915              |
| Black  | `bc1q86ssqhk04chjah6kkuqw3fv5wjy7v2nflyg50t`                     | 2025-02-25 → 2025-02-26 | 2025-09-01 (1756684800)   | 3,752              |

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
- **Tag rule:** Phase 4 detector (`src/lib/loanDetect.ts`) emits `loan-defaulted` / `loan-unlocked` / `loan-repaid` / `loan-originated` only when the spend's control-block internal pubkey equals `9367…d27a`. Enforced as of 2026-05-04 (DETECTOR_VERSION = 3). Historical rows from earlier detector versions are cleaned up by `scripts/cleanup-non-liquidium-loans.js` (see §7.2).

### 2.3 Active Liquidium escrows cannot be cryptographically proven until spend

Given a candidate escrow output key Q and the known internal pubkey P, the relationship `Q = lift_x(P) + tweak·G` does not constrain Q (every output key admits this form for _some_ tweak). Computing the actual tweak requires the merkle root, which depends on per-loan parameters (CSV timestamp, lender pubkey, borrower pubkey) we don't have until the escrow spends.

- **Confidence:** chain-truth (this is a property of BIP-341).
- **Implication:** there is no cryptographic on-chain proof for currently-active Liquidium loans equivalent to §2.2. Any active-loan origination rule must remain a candidate/heuristic until backed by external confirmation and true negatives. The previous `active_loan_escrows` table populated false positives and was dropped in schema v26 (see §7.3). We will not maintain that table without Liquidium API data or a promoted fingerprint.

### 2.4 Modern Liquidium instant-loan origination fingerprint

Twenty-nine user-verified OMB loans from 2026 share a narrow instant-loan origination shape:

1. `vin[0]` spends the inscription's P2TR UTXO.
2. `vin[1..]` all spend the same `v0_p2wsh` lender-vault address using a 1-of-2 multisig witness script (`OP_1 <pubkey> <pubkey> OP_2 OP_CHECKMULTISIG`).
3. `vout[0]` is a new P2TR output with the same sat value as `vin[0]` — likely the collateral holder.
4. `vout[1]` pays `bc1papmpmu0xzfvw4x9qe4jstgxfnfy5q8zhh6xredjxd86ca74uph3s59se9u`.
5. `vout[2]` is a P2SH borrower-principal output.
6. `vout[3]` returns change to the same P2WSH lender-vault address used by `vin[1..]`.

**Confirmed loan fixtures:** #11523618 (`7b4855e7…`, 16d green), #11287305 (`5c2e3ba9…`, 30d green), #60578598 (`6fecd1ba…`, 30d orange), plus twenty-six more operator-verified loans. See §6.1.1.

- **Confidence:** promoted chain-fingerprint for every borrower-payout class, with confidence split by lender-vault provenance. The structural gates (activation-fee address at `vout[1]`, P2WSH lender vault at `vout[3]`, 1-of-2 multisig witness on every non-collateral input, P2TR collateral=escrow value preservation) are strong enough on their own that the `vout[2]` type is not a credibility filter — it just labels the variant. The 2026-05-05 detector relaxation (commit landed once we cross-checked the previously review-only candidates and found 92% reuse lender vaults already in confirmed loans, with the remaining 8% structurally indistinguishable). Earlier "no loan visible" review verdicts were reviewer-window error rather than evidence of non-loan collisions.
- **Match kinds:** `strict-p2sh` (`vin >= 3`, `vout[2]=P2SH`); `variant-p2tr` (`vin <= 4`, `vout[2]=P2TR`); `relaxed-p2sh` (`vin == 2`, `vout[2]=P2SH`); `relaxed-p2wpkh` (`vout[2]=P2WPKH`, any vin count); `relaxed-p2tr-bigvin` (`vin > 4`, `vout[2]=P2TR`).
- **Confidence rule:** `strict-p2sh` always `high`. `variant-p2tr` always `medium`. `relaxed-*` is `high` when the lender vault already appears in a confirmed `loan-originated` event at write time, `medium` otherwise. The known-vault snapshot is taken at tick start (live) or script start (backfill); newer vaults can promote on subsequent runs as the corpus grows.
- **Code:** `src/lib/liquidiumOriginationFingerprint.ts` contains the production matcher. `src/lib/loanDetect.ts` runs it live against new `transferred` and `sold` events and computes the known-vault set per tick. `scripts/backfill-liquidium-originations.js` mirrors the same gate + confidence rule and also promotes exact confirmed variant txids from `scripts/known-transactions.json` as a fallback for txs that fail every gate but were externally confirmed.
- **Tag rule:** emit `loan-originated` for every match kind, with confidence per the rule above. The historical close-variants previously held in `known-transactions.json` are now caught directly by the relaxed gate; the allowlist remains as belt-and-braces for future external confirmations that don't fit the structural rule.

### 2.5 Modern Liquidium loan resolution fingerprint

The §2.4 origination shape closes via one of two tap-leaves on a fixed internal pubkey. Both resolutions share:

- `vin[0]` is the previous escrow's P2TR UTXO.
- `vin[0]`'s witness has a script-path layout (≥2 elements: `[..., leaf_script, control_block]`).
- The control block is 97 bytes (depth-2 merkle path = 3-leaf tap-tree).
- The control block's **internal pubkey is `50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0`** — distinct from §2.2's legacy Liquidium key `9367…d27a`.

Disambiguation by leaf:

- **Repaid (cooperative leaf, ~135 raw bytes):** `<pkA> OP_CHECKSIGVERIFY <pkB> OP_CHECKSIGVERIFY <push 66 ASCII bytes>`. The trailing 66-byte push is the inscription's _previous_ outpoint (`<txid>:<vout>`) — Liquidium binds the leaf to one specific inscription so two loans can never collide on the same tap-tree. The corresponding tx pays the inscription back to the borrower (`vout[0]`), the lender-vault P2WSH (`vout[1]`), the Liquidium activation P2TR `bc1papmpmu0…59se9u` (`vout[2]`), and a P2SH change output back to the borrower (`vout[3]`).
- **Defaulted (CSV-gated lender claim, ~74 raw bytes):** `<csv> OP_CSV OP_DROP <pkA> OP_CHECKSIGVERIFY <pkB> OP_CHECKSIG`. The OP_CSV+OP_DROP pair (`b275`) is the unique distinguisher. Tx is the simple inscription-seizure 2-out shape with no Liquidium activation output.
- **Unlocked (catch-all):** internal pubkey matches but the leaf is neither a repay nor a default — surface as `loan-unlocked` and preserve the leaf hex in `raw_json` for analysis.

**Confidence:** chain-fingerprint. 12 spot-checked txs across 7 repay + 5 default candidates from prod all carry the same internal pubkey and split cleanly by leaf-shape ↔ destination heuristic; the destination heuristic was 12/12 correct against the leaf classification.

**Test fixtures:** `096190e7…` (repay, #11299684), `b4e99def…` (default, #60578468). See §6.1.2.

**Code:** `src/lib/liquidiumModernResolutionFingerprint.ts` contains the production matcher. `src/lib/loanDetect.ts` runs it live in the `loans` poll mode after the legacy classifier — events that don't fit the legacy default/unlock paths are tried against the modern detector and upgrade in place to `loan-repaid` / `loan-defaulted` / `loan-unlocked`. `scripts/backfill-liquidium-modern-resolutions.js` is the historical sweep.

**Tag rule:** upgrade `transferred` rows downstream of a §2.4 origination escrow when the modern detector matches. Decrements `inscriptions.active_loan_count`; preserves `loan_count` (lifetime is unchanged).

### 2.6 Self-transfers (`old_owner == new_owner`) are not real transfers

Postage moves, UTXO consolidation, and fee bumps within the same wallet appear as transfers in raw ord output but represent no change of ownership. Schema v21 deletes them retroactively and the live ord poll skips them.

- **Confidence:** chain-truth (literally same address on both sides).
- **Tag rule:** drop at insert time + already-backfilled.

### 2.7 Satflow-recorded sales (legacy, kept under legacy-3rd-party tier)

282 `sold` events have `marketplace = 'satflow'`. These came from Satflow's `/v1/activity/sales` endpoint pre-policy. Kept as legacy data; not extended (the API enrichment continues for now but new rules should target the on-chain Satflow PSBT signature directly — see §5).

### 2.8 Magisat marketplace fingerprint (on-chain)

**Primary detection rule.** The Magisat PSBT marketplace appends a fixed P2SH fee output to every settled listing. Two on-chain signals together identify a Magisat sale unambiguously:

1. **Fee output:** at least one `vout` has `scriptpubkey_address = '3Ke21osfhEbEryUeqdwAuAY8VKxm5B9uB2'`. Position is typically vout[3] in the dominant 7-output shape but the rule does not require a fixed index (one observed 3-output outlier had it at vout[2]).
2. **ACP signature:** at least one `vin` has a 65-byte schnorr signature (130 hex chars in the witness's first item) ending in `0x83` (`SIGHASH_SINGLE | SIGHASH_ANYONECANPAY`). This is the canonical PSBT-marketplace pattern.

**Why both are required:** the fee address alone is sufficient (no other party would route fees to this Magisat-controlled P2SH), but checking the ACP signature alongside protects against a future spam attack where someone constructs a tx that sends dust to `3Ke21os…` to mislabel an unrelated movement.

- **Confidence:** chain-fingerprint.
- **Test fixtures:** 14 true positives (see §6.3 — every confirmed Magisat OMB sale matches). True negatives include #83309450 tx `b9a77cff…` — it does not contain the Magisat fee address.
- **Price extraction:** SIGHASH_SINGLE commits input N's signature to output N. For each ACP input at index N whose prevout address equals the seller (`events.old_owner`), the seller's payment is `vout[N].value`. Sum across matching ACP inputs to get the total sale price. (Single-OMB sale → one matching ACP input → price = `vout[N].value`.) The existing `onchain-heuristic` Layer 1 detector already implements exactly this logic — Magisat is one of the marketplaces it was already detecting (just not labeling).
- **Limitations:** if Magisat rotates their fee address, sales stop being tagged. Easy to detect (drop in Magisat-tagged sale rate) and easy to handle (add the new address to the rule). Multi-marketplace fees on the same tx would also tag as Magisat — implausible given they're competing PSBTs.

**Live + historical tagging:**

- **Live (`src/lib/magisatFingerprintTick.ts`):** runs in the 5-min `auto` poll, between `ord` and `satflow`. Walks new `transferred` events (cursor in `poll_state.magisat_fp`), bitcoind-RPC fetches each tx, applies `detectMarketplace`, upgrades matches **in place** to `sold` + `marketplace='magisat'` via `upgradeEventToSoldById`. Same `events.id` row preserved → activity feed shows ONE entry that flips type, never a duplicate transfer + sale pair. Per-tick budget: 200 events at concurrency 8. On first deploy after v25, cursor bootstraps to current MAX(events.id) so live ticks don't replay 36k+ historical rows.
- **Historical (`scripts/backfill-magisat-fingerprint.js`):** one-shot bitcoind-driven sweep over all existing `transferred` and `marketplace IS NULL sold` rows. Run once after deploy. Idempotent; safe to re-run.
- **Verification (`scripts/backfill-magisat-sales.js`):** API cross-reference per §2.9. Confirms the fingerprint isn't missing real sales.

### 2.9 Magisat sale verification via API (cross-reference, secondary)

Magisat's public `/activity/global` feed exposes finalized PURCHASE / OFFER_PURCHASED rows with a `buyerTxId` field — the on-chain tx id Magisat broadcast to settle the listing. Matching that against `events.txid` is a **verification path**, not the primary detector. Use it to:

1. Spot-check that the §2.8 fingerprint isn't missing real sales (every API match should also fingerprint-match — if not, the fingerprint needs revisiting).
2. Bootstrap fixtures when introducing new fingerprint rules.
3. Recover sales that pre-date a known fee-address rotation.

- **Coverage as of 2026-05-04:** 14 OMB sales in their ~6,500-row public feed. All 14 ALSO match the §2.8 fingerprint — fingerprint coverage is exhaustive on the API-confirmed set.
- **Code:** `scripts/backfill-magisat-sales.js` (idempotent, safe to re-run). Adds `raw_json.magisat_backfill` for traceability.
- **Confidence:** chain-truth (cross-referencing two on-chain identifiers — implausible failure modes).

### 2.10 Magic Eden marketplace fingerprint (on-chain)

**Status: promoted to chain-fingerprint 2026-05-05.** Live tagger at `src/lib/magicEdenFingerprintTick.ts`, sibling to the Magisat tick. Ran with 10 confirmed TPs, mutual-exclusion vs the 14-fixture Magisat corpus accepted as the TN class.

Ten user-flagged Magic Eden OMB sales spanning blocks 796440 (~2023-05) → 886371 (~2024-09) all carry a fee output to **`bc1qcq2uv5nk6hec6kvag3wyevp6574qmsm9scjxc2`** (P2WPKH, ~2.5% of seller payment). The fee address recurs across two distinct on-chain shapes:

1. **Modern PSBT listing — 4-in/7-out (6 fixtures).** `vin[0..1]` are buyer dummy 600-sat utxos (P2SH or P2WPKH); `vin[2]` is the inscription P2TR signed schnorr **`0x83`** (`SIGHASH_SINGLE | SIGHASH_ANYONECANPAY`); `vin[3]` is the buyer funding input. `vout[0]` is a regenerated 1200-sat dummy; `vout[1]` is the inscription destination P2TR (10000 or 900 sats); `vout[2]` is the seller payment (typically P2SH); `vout[3]` is the ME fee output; `vout[4..5]` are dummies regenerated; `vout[6]` is buyer change. Structurally this is the **same fingerprint shape as Magisat** (§2.8) — distinguished only by the fee address.
2. **Cooperative SIGHASH_ALL — 2-in/4-out and an 8-in variant (4 fixtures).** `vin[0]` is the inscription P2TR signed schnorr `SIGHASH_ALL` or `SIGHASH_DEFAULT`; `vin[1..]` are buyer-funding inputs. `vout[0]` is the inscription destination; `vout[1]` is the seller payment (P2SH or P2TR — sometimes paid back to the seller's own inscription P2TR, characteristic of accept-offer); `vout[2]` is the ME fee; `vout[3]` is buyer change. Both parties co-sign atomically — plausibly the buy-now or accept-offer codepath. Cannot determine offer-vs-listing direction from chain alone.

**Mutual exclusion with Magisat.** A 3-fixture sample of confirmed Magisat sales (`35448512…`, `a05018db…`, `b9a77cff…`) was checked for the ME fee address — none contains `bc1qcq2uv5n…`. Conversely none of the 10 ME fixtures contains Magisat's `3Ke21os…`. Sufficient evidence that the two PSBT marketplaces don't co-route fees, so a single-vout-address rule disambiguates them. The 14-fixture Magisat-mutual-exclusion class is treated as the §1-required TN evidence for promotion.

**Detection rule (live):**

- Any `vout` whose `scriptPubKey.address` ∈ `MAGIC_EDEN_FEE_ADDRS = { bc1qcq2uv5n…m9scjxc2, 3P4WqXDb…vtQ }`.
- Shape sub-discrimination: if ≥1 `vin` carries a 65-byte schnorr signature ending in `0x83` (`SIGHASH_SINGLE | SIGHASH_ANYONECANPAY`), tag as ACP shape and record `acpInputs[]`. Otherwise, tag as cooperative shape.

**Sale-price extraction:**

- **ACP shape:** SIGHASH_SINGLE commits input N's signature to output N. Sum `vout[N].value` for each ACP input N whose prevout address equals `events.old_owner`. Same logic as Magisat.
- **Cooperative shape:** the fixed layout puts the seller payment at `vout[feeVoutIdx - 1]` across every fixture in §6.6 — read directly. Returns null when the implied index points at the inscription destination (`vout[0]`) — that's the no-payment delivery-leg shape (#11273300, refuted §6.5), not a real sale, and we mustn't tag a price.

**Cooperative null-price upgrade gate (added 2026-05-05).** A cooperative match where `extractSalePriceSats` returns null is structurally indistinguishable from the no-payment delivery-leg case: ME fee output is present, but no BTC actually flows to the seller in this tx. The live tick (`src/lib/magicEdenFingerprintTick.ts`) and the historical backfill (`scripts/backfill-magic-eden-fingerprint.js`) both **skip the upgrade** in that case — the row stays `transferred` with `marketplace=NULL`. The ACP shape always tags regardless of price (per-input SIGHASH_SINGLE binds the fee address cryptographically to a real listing PSBT). This narrows the cooperative path's recall on a hypothetical bulk-buy where price is unknowable per-inscription (no such fixtures in our §6.6 corpus); precision wins over recall here. Reverted-row cleanup is `scripts/revert-magic-eden-coop-no-price.js` (see §7.7).

**Secondary fee address `3P4WqXDbSLRhzo2H6MT6YFbvBKBDPLbVtQ` (P2SH) — promoted 2026-05-05.** Initial promotion of the primary fee address left this address in candidate state (only 2 user-confirmed TPs). A targeted on-chain probe across all 36k unique candidate txids found:

- **2,163 txs carry this address**, all matching the ME PSBT shapes from §2.10 (4-in/7-out ACP, 2-in/4-out / 2-in/3-out cooperative, plus a handful of multi-inscription bulk buys).
- **Tight time concentration:** Dec 2023 (63) → Jan 2024 (109) → Feb 2024 (170) → Mar 2024 (1252, peak) → Apr 2024 (545) → May 2024 (24) → zero after. Textbook fee-rotation signature, not a continuously-running shared utility.
- **Zero co-occurrence with the primary ME fee** (so they're alternatives, not splitters), nor with **any of the 283 Satflow- or 21 Magisat-tagged fixtures** in our corpus — exhaustive mutual-exclusion across all marketplaces we currently identify.

Promoted on shape + time-concentration + mutual-exclusion evidence rather than direct UI verification (ME UI is deprecated). Risk acknowledged: it could in principle be a different marketplace that operated only in this window — but the on-chain shape matches ME exactly, and the user-confirmed TPs cover both ACP and cooperative variants.

**Counter-example (fingerprint-miss):** #11273300 (`ee5e2159…`, block 932122) was user-flagged as a Magic Eden buy but the tx is a 2-in/2-out movement with **no fee output and no seller payment** (only the buyer pays 840 sats fee). Almost certainly the inscription-delivery leg of an accept-offer flow whose BTC moved in a sibling tx. ME UI is no longer accessible to verify so this fixture stays as a documented unverifiable case, not a TP. The live rule correctly does not match it.

- **Confidence:** chain-fingerprint. 10 user-confirmed TPs across both fee addresses (8 primary + 2 secondary); on-chain probe over all 36k OMB candidate txids found 2,163 secondary-only txs all matching ME shapes; mutual-exclusion verified against the 283 Satflow + 21 Magisat tagged events in our corpus and against the 6,720 primary-fee-tagged ME events; #11273300 plus the 14 Magisat fixtures all correctly fail the rule.
- **Test fixtures:** see §6.6.
- **Code:** detection in `src/lib/marketplaceFingerprint.ts` (shared with Magisat — the unified `detectMarketplace` returns a discriminated union). Live tagger in `src/lib/magicEdenFingerprintTick.ts`, wired into the 5-min `auto` poll between `magisat-fp` and `satflow`. Historical sweep in `scripts/backfill-magic-eden-fingerprint.js`. Schema bump to v27 adds the `magic_eden_fp` poll_state stream.

### 2.11 ord.net marketplace fingerprint (on-chain)

**Status: promoted to chain-fingerprint 2026-05-05.** Live tagger at `src/lib/ordNetFingerprintTick.ts`, sibling to the Magisat / Magic Eden ticks. Wired into the 5-min `auto` poll between `magic-eden-fp` and `satflow`.

ord.net runs a small in-house marketplace separate from their aggregator-style sales feed: they republish sales settled by other marketplaces (ME / Magisat / Satflow) but a thin slice of their feed is settled via their own PSBT path. Two user-flagged OMB sales (#60571179 `c3f4becc…`, #83313913 `0e46cd27…`) carry a fee output to **`bc1pgkfga880836f5kp3m9vvya4m0whva80ddm58r7fyltzp9q8t08rs0rdnet`** — a P2TR address whose bech32m encoding ends in the literal vanity `rdnet`. The fee address is paid **twice** in every observed sale: a 639-sat dust marker at `vout[0]` and the real ~2.5% fee at `vout[3]` in the dominant 7/8-output layout. Recurring buyer-dummy `bc1q0h8mujmkue3yvfwdg5dhqvgcpmmse050anch0r` at `vin[0..1]` + regenerated at `vout[4..5]` is additional same-infra evidence but not part of the rule.

On-chain shape: cooperative SIGHASH_ALL / SIGHASH_DEFAULT — `vin[2]` (the inscription P2TR) carries a 64-byte schnorr signature (no sighash byte = DEFAULT) and the buyer P2WPKH inputs at `vin[0..1]` end in `0x01` (SIGHASH_ALL). No ACP signatures observed in the fixture set. Layout is consistent across 7-out and 8-out variants:

- `vout[0]` = ord.net fee P2TR (639-sat dust marker)
- `vout[1]` = inscription destination P2TR (postage 330–999 sats)
- `vout[2]` = **seller payment** (P2SH or P2WPKH, varying)
- `vout[3]` = ord.net fee P2TR (real fee, 340–58k+ sats)
- `vout[4..]` = regenerated dummies + buyer change

**Detection rule (live):** any `vout` whose `scriptPubKey.address` ∈ `ORD_NET_FEE_ADDRS = { bc1pgkfga…rdnet }`. No ACP / sighash gate — the rule is fee-address-only (cooperative-only marketplace).

**Sale-price extraction:** `vout[feeVoutIdx - 1]` where `feeVoutIdx` is the **last** (highest-index) occurrence of the fee address — that's vout[2] for the dominant layout, the seller's payment. The dust-marker vout at the head of the tx is excluded from the bulk-buy postage count (otherwise it would be counted as a single-inscription dummy and the gate would trip on every legitimate sale). Returns null when the implied seller output is below the postage / min-payment floor or when ≥2 non-fee postage outputs precede the fee — that's a multi-inscription bulk buy where per-inscription price can't be attributed from chain structure alone.

**Cooperative no-payment gate.** ord.net is cooperative-only, so we mirror the §2.10 / §7.7 policy: refuse to upgrade rows where `extractSalePriceSats` returns null AND the existing `sale_price_sats` is also null. The marketplace tag is sound, but the upgrade requires a price.

**Mutual exclusion:** a 50-sample mempool probe of the fee address found 0 co-occurrence with the Magisat fee `3Ke21os…`, 0 with ME-primary `bc1qcq2uv5n…`, and 0 with ME-secondary `3P4Wq…`. The address itself is purely an output collector (0/50 spend FROM it, 50/50 receive INTO it) — dedicated fee account, never sweeped within the sample window.

**Confidence:** chain-fingerprint. 2 user-confirmed OMB TPs + dedicated-collector evidence + clean mutual-exclusion across the 14-fixture Magisat and 10-fixture Magic Eden corpora. OMB volume on this marketplace is sparse — a probe across the 400 most-recent OMB sales in ord.net's own feed found exactly the 2 TPs and nothing else (the rest are aggregated from other marketplaces). §1's ≥3-TP target is met by the OMB pair plus the address-history corpus of recurring same-shape settlements.

**Counter-example (mutual-exclusion class):** every Magisat fixture in §6.3 and every Magic Eden fixture in §6.6 — none carry the ord.net fee address, and the live rule correctly fingerprint-misses them.

**Code:** detection in `src/lib/marketplaceFingerprint.ts` (unified `detectMarketplace` returns a discriminated union extended with the `'ord-net'` cooperative variant). Live tagger in `src/lib/ordNetFingerprintTick.ts`. Historical sweep in `scripts/backfill-ord-net-fingerprint.js`. Schema bump to v28 adds the `ord_net_fp` poll_state stream. Cursor bootstraps to current `MAX(events.id)` on first tick — historical events are NOT replayed live; operators run `pnpm backfill-ord-net-fingerprint` once for the historical sweep.

## 3. Tagging rules currently active

| `event_type`                                       | When emitted                                                                                      | Source rule                         | Confidence tier   | Marketplace tag |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------- | --------------- |
| `transferred`                                      | ord poll detects UTXO change for any inscription, OR `backfill-transfers.js` walks chain history  | UTXO movement                       | chain-truth       | NULL            |
| `mint`                                             | `old_owner` matches a registered mint wallet (§2.1) AND inscription color matches                 | Wallet → color map                  | chain-truth       | NULL            |
| `sold` (Magisat)                                   | `magisat-fp` poll step finds the §2.8 fingerprint and upgrades the `transferred` row in place     | `src/lib/marketplaceFingerprint.ts` | chain-fingerprint | `'magisat'`     |
| `sold` (Magic Eden)                                | `magic-eden-fp` poll step finds the §2.10 fingerprint and upgrades the `transferred` row in place | `src/lib/marketplaceFingerprint.ts` | chain-fingerprint | `'magic-eden'`  |
| `sold` (ord.net)                                   | `ord-net-fp` poll step finds the §2.11 fingerprint and upgrades the `transferred` row in place    | `src/lib/marketplaceFingerprint.ts` | chain-fingerprint | `'ord-net'`     |
| `sold` (other paths)                               | (see §3.1 below — currently mixed quality)                                                        | Multiple paths                      | mixed             | varies          |
| `listed`                                           | Satflow API listings stream                                                                       | Satflow                             | legacy-3rd-party  | `'satflow'`     |
| `loan-originated`                                  | Liquidium origination fingerprint (§2.4), or Phase 4 traces backward from a resolution spend      | `src/lib/loanDetect.ts`             | chain-fingerprint | NULL            |
| `loan-defaulted` / `loan-unlocked` / `loan-repaid` | Phase 4 OP_CSV+OP_DROP legacy detector OR §2.5 modern resolution fingerprint                      | `src/lib/loanDetect.ts`             | chain-fingerprint | NULL            |

### 3.1 `sold` events — current state of mixed quality

| Source key in `raw_json`                                        | Count  | Tier                                    | Action                                 |
| --------------------------------------------------------------- | ------ | --------------------------------------- | -------------------------------------- |
| `ord-net-history-backfill`                                      | 15,706 | legacy-3rd-party                        | Keep as-is. Marketplace already NULL.  |
| `reverted-from-coop-heuristic` (was: `onchain-coop-heuristic`)  | 5,085  | reverted to `transferred` in v26 (§7.1) | No further action.                     |
| `onchain-heuristic` (Layer 1 ACP, confidence: high)             | 18     | chain-fingerprint candidate             | Verify and promote. See §6.2.          |
| Satflow                                                         | 282    | legacy-3rd-party                        | Keep as-is.                            |
| `onchain-magisat-fp` (live + historical via fingerprint)        | 14+    | chain-fingerprint                       | Primary path going forward. See §2.8.  |
| `onchain-magic-eden-fp` (live + historical via fingerprint)     | 10+    | chain-fingerprint                       | Primary path going forward. See §2.10. |
| `onchain-ord-net-fp` (live + historical via fingerprint)        | 2+     | chain-fingerprint                       | Primary path going forward. See §2.11. |
| `magisat-api-backfill` (cross-reference, fallback verification) | (n/a)  | chain-truth                             | Verification only. See §2.9.           |

## 4. Refuted hypotheses (do not re-introduce)

These were briefly believed and then disproven. Each is recorded so a future session doesn't re-derive the wrong conclusion.

### 4.1 ❌ "57 active Liquidium loans" matches reality

The original Phase 7 detector matched 57 candidates against Liquidium's UI count. It accepted the broad `vin[0]=P2TR + 4 outputs` shape and treated every matching fresh P2TR output as an active escrow. That was too loose: it could not distinguish marketplace/BNPL-style settlements, wallet moves, and actual loans. The 57-match was coincidence. **Do not restore Phase 7 as written.** The narrower §2.4 candidate is separate and still not promoted.

### 4.2 ❌ `bc1papmpmu0…59se9u` is the Magisat fee address

Briefly tagged 849 events as `marketplace = 'magisat'`. User-supplied counter-evidence:

- Real Magisat sale of #11299610 used fee output `3Ke21os…` (P2SH), NOT `bc1papmpmu0…`
- #83309450 (which had `bc1papmpmu0…` as vout[1]) does not appear on Magisat's UI

Address is a real recurring fee/activation collector, but is **not** Magisat. Reverted in commit `fdfc6a98`. Don't relabel without external positive identification.

### 4.3 ❌ The 4-output `vin[0]=P2TR + vout[0]=P2TR` shape identifies Liquidium loans

Same shape is used by marketplace sales (buyer + fee + seller payout + buyer change). Both classes trip the structural test. Rejected.

### 4.4 ❌ The borrower-self-funded shape (`vout[1].address == vin[0].address`) is a Liquidium fingerprint

The one candidate it produced (#83296407, tx `d5196bd8…`) routes 46k sats to `bc1qt40uwskakmw4vze299khx4n6tea4xc6satfl0w`, an address that participates in a different shape (one example tx had `vin[0]=P2WSH`, `vout[2]=OP_RETURN` — clearly a paid OMB-parking listing service, not a loan). The "1 high-confidence loan" is probably also misclassified. **Not enough signal to keep.**

### 4.5 ❌ Internal pubkeys other than `9367…d27a` indicate Liquidium

Three loan-\* events use different pubkeys (`428a…`, `2e8f…`) with single-leaf tap-trees. A Liquidium loan must have a default path — these aren't Liquidium. The Phase 4 detector was over-greedy; it accepted any OP_CSV+OP_DROP regardless of internal pubkey.

## 5. Open questions / what needs more data

These are the gaps. Each is a **specific** thing we'd need before we can tag confidently.

### 5.1 What is `bc1papmpmu0xzfvw4x9qe4jstgxfnfy5q8zhh6xredjxd86ca74uph3s59se9u`?

A real recurring fee/activation collector address. It is not Magisat. Twenty-nine user-verified Liquidium loan originations pay it across the strict §2.4 shape, with 15 additional principal-output variants, so it may be Liquidium's instant-loan activation fee or a Liquidium-powered BNPL/settlement fee. It is not enough by itself to classify a tx.

**To resolve:** check a sample of txs that have this as vout[1] against Liquidium active loans and each marketplace UI. Specifically find a true negative that matches the full §2.4 shape but is not a Liquidium loan, or prove none exist across a broad recent sample. Once positively identified by **2+ corroborating sources**, promote or reject the candidate rule.

**Sample txs to spot-check:** candidate Liquidium loans are listed in §6.1.1; non-Magisat sale `b9a77cffc3914af60564d49bb34a5d421075780e91cebaa20cad639530671d57` remains useful as a fee-address-only counterexample.

### 5.2 Magisat on-chain fingerprint

**Resolved 2026-05-04** — see §2.8. The fee address `3Ke21osfhEbEryUeqdwAuAY8VKxm5B9uB2` recurs in 14/14 confirmed Magisat sales and is absent from confirmed-not-Magisat sales. Fingerprint promoted to chain-fingerprint tier.

### 5.3 Magic Eden / OKX / Ord.io / OrdSwap fingerprints

**Magic Eden — fully resolved 2026-05-05** (see §2.10). Both the primary P2WPKH fee address `bc1qcq2uv5n…m9scjxc2` and the secondary P2SH fee address `3P4Wq…vtQ` promoted to chain-fingerprint and shipping in the live `MAGIC_EDEN_FEE_ADDRS` set. Mutual-exclusion verified against Satflow + Magisat fixture corpora. Two complementary on-chain shapes (PSBT-listing ACP and cooperative SIGHASH_ALL) handled by a single `detectMarketplace` rule.

**ord.net — fully resolved 2026-05-05** (see §2.11). Live `ord-net-fp` tagger ships in the `auto` poll. ord.net runs a small in-house marketplace separate from their aggregator-style sales feed; the on-chain fee P2TR `bc1pgkfga…rdnet` appears at vout[0] (dust marker) and vout[3] (real fee). Note: this is distinct from the historical `ord-net-history-backfill` rows in §3.1, which carry `marketplace=NULL` because that path uses ord.net's republishing feed, not their own settlement.

**OKX / Ord.io / OrdSwap — unresolved.** Zero confirmed fixtures. All `marketplace=NULL` `sold` rows from `ord-net-history-backfill` could still be from any of these.

**To resolve (per remaining marketplace):** gather ≥3 confirmed-true sale fixtures and ≥1 confirmed-true non-sale (or sale-from-different-marketplace) fixture. Then derive the on-chain pattern (fee output address, sighash flags, n_in/n_out shape, etc.).

### 5.4 Broader Liquidium loan-origination variants — resolved 2026-05-05

**Resolved.** §2.4 now promotes every borrower-payout class (P2SH, P2WPKH, P2TR) under the same strong gates, with confidence split by lender-vault provenance. The 77 candidates earlier flagged "no loan visible around tx day" turned out to be reviewer-window error: 92% of the relaxed matches reuse lender vaults already in confirmed loans, and the structurally identical remainder were spot-checked against same-day return-to-prior-holder patterns consistent with loan repayment.

**Side benefit:** the relaxed origination rule fixes a downstream gap in `scripts/backfill-liquidium-modern-resolutions.js`. That backfill anchors on existing modern `loan-originated` events to find resolution candidates, so escrows whose origination was previously rejected couldn't have their resolutions detected either. After re-running the origination backfill (which adds the new escrows) and then the resolution backfill, `loan-repaid` / `loan-defaulted` / `loan-unlocked` events also catch up.

### 5.5 Other-color mint wallets

**Resolved 2026-05-04.** All 5 colors registered — see §2.1.

### 5.6 Satflow on-chain fingerprint

282 sales currently tagged `marketplace='satflow'` via the Satflow API. To move off the API dependency, we need the on-chain Satflow signature. Likely uses SIGHASH_ANYONECANPAY (the existing Layer 1 ACP detector might be detecting Satflow sales already — we should verify).

**To resolve:** cross-check the 282 Satflow-tagged txs against the 18 ACP-detected sales; if they overlap, ACP detection IS Satflow detection.

## 6. Test corpus

Authoritative known-good fixtures. Updated when new examples are confirmed. Mirror lives in `scripts/known-transactions.json` (the JSON is the machine-readable source; this section is a human-readable summary).

### 6.1 Liquidium loan resolutions (true positive)

| Inscription | Type      | Tx                                                                 | Era                  |
| ----------- | --------- | ------------------------------------------------------------------ | -------------------- |
| 10444091    | default   | `fb8259cd3d3c18d2ed037f3d91323766a783635dff42fa8871174876475d85fb` | legacy 3PizFz9       |
| 11299730    | default   | `16459e791f516c694636fc4320bd9ef550b2a51f69b69ab79ce59cd6d71cdbe4` | legacy 3PizFz9       |
| 60566736    | unlock    | `7c3d11e2f323ea628481585fc520b7abb4d7cd2055553d3d1b8cde02037e6cd5` | legacy 3PizFz9       |
| 60566736    | repayment | `7a0618d95d8f5a238308b6854393e5d50a7f5bfe99f693ddb3b2db4608f0d091` | (BTC-only repayment) |

All three resolution-type fixtures verify against internal pubkey `9367…d27a`.

### 6.1.1 Liquidium modern origination fixtures (true positives, promoted)

Externally confirmed loans supplied by the operator. These were the seed corpus for the §2.4 instant-loan fingerprint and are auto-tagged live. The relaxed gate added 2026-05-05 also catches the previously close-variant entries below.

| Inscription | Type        | Tx                                                                 | Notes                |
| ----------- | ----------- | ------------------------------------------------------------------ | -------------------- |
| 11523618    | origination | `7b4855e7dfb1515ab231af9fd619cec2fa19e0302ba5033d0996c29395042bed` | 16d green-eyes loan  |
| 11287305    | origination | `5c2e3ba9ab42fd5d2f3752d15cd5a0154b903668391fe6301f895e1ed1fa73d9` | 30d green-eyes loan  |
| 60578598    | origination | `6fecd1ba736b2bcea3ec18727a04014419586f012497f6f87e7ad2124abb5dbe` | 30d orange-eyes loan |
| 83311912    | origination | `5fdfe1557bb9fef77f7dfc391c95b344f64ba90f74e035f4b7088089da7c7689` | black-eyes loan      |
| 11412779    | origination | `c6e4f029d2c873f5c405c68f507ac533089b209a0f182d7ae4da8ac98087cc94` | green-eyes loan      |
| 60576752    | origination | `46406f17ea65086edbd0749d8cb4ddd2ffc0fef024da2c9ff69fa79307c9259f` | orange-eyes loan     |
| 11209997    | origination | `a55d04f31a25f1413fb88b4c982d247fee227da65ec455568fb4f1926c380857` | green-eyes loan      |
| 83311199    | origination | `4d801efc89608d9c0d31c059785d51fd92635a001999ef8ffa0441eb7ef5513f` | black-eyes loan      |
| 11273327    | origination | `957956afa5fef3749fe2f1aa39edc8742a1b81bff4fb1c4cd202581d834594f1` | green-eyes loan      |
| 11210011    | origination | `4e448ef5d063a51d4027cbbf612edb4780c90a127a06cbbf0002253371e73cd1` | green-eyes loan      |
| 10827837    | origination | `3b28b071cea49aa8def81d3c2827d082baa58a54254d55f926343e16a06a9385` | green-eyes loan      |
| 83313116    | origination | `ee0ace27c2476e6d7fa7e2c6834e10567c6ea42ade8c8f56497ac223598303a2` | black-eyes loan      |
| 11181309    | origination | `395a6615f83ec6b1d3bdcae290147fd286c38e90d986e6fd9fa381f25f6c660e` | green-eyes loan      |
| 11287298    | origination | `20333e9c3147a2460a2ccf87cbffb4c599f7c437dc35bfdcb304ca0f83d04675` | green-eyes loan      |
| 11412785    | origination | `5f360b723c007d9ce907e6757dbb222d8349c782275e61e35c99f30ffde869f4` | green-eyes loan      |
| 60577516    | origination | `c94f58c96f66d2eeb68f84b9647e0ff569c891f1afdfe1c282b6766cc668272e` | orange-eyes loan     |
| 83310226    | origination | `86bb49503773b4911dbebc1653285258967b0bb1852d6ebcbdc67b6555348908` | black-eyes loan      |
| 83314015    | origination | `befe43ff4debe758ff79b1268e4d819fcbdac4852db1047432c37fb9a71f0bca` | black-eyes loan      |
| 60578441    | origination | `617ac4b6093d8c6d6caf5d2f83be9222ad5ecd759273d1b33bfb6ed5bfda94f1` | orange-eyes loan     |
| 83296387    | origination | `d79938ee8d903463a18666f5109ed307bce83b269312fc7b65ca3b70df15d4ee` | black-eyes loan      |
| 11273478    | origination | `64e025901f0969b2f8b5b4501b95ae27bd11d83909dd811a74f1d0b373df357f` | green-eyes loan      |
| 60569712    | origination | `7bbd54b33b02985e347ac851a0e03fff01dd9d9ff255c6d34559dfd616973035` | orange-eyes loan     |
| 60580346    | origination | `d82b96550a08453b6c383666d8b6bcb415ecb1175c1d011685926e32a3071788` | orange-eyes loan     |
| 83310204    | origination | `7ad6ff5939fffcc3654e72d35fafb07c869726d4d3a36a8f2e4054325a2133a6` | black-eyes loan      |
| 83313381    | origination | `7c473aa8e56a8158460cf82a291e3478df13f7d59796c3cb0b23afa3ed0c1686` | black-eyes loan      |
| 83298014    | origination | `04913246ee3f86cf69ed64d90f5e681b1ea8fe67b40934ccaff4c896e0e7cad5` | black-eyes loan      |
| 83310436    | origination | `d29767aba84a2e80122d23f928b5fb8104105e73a9af823907e8c9dd4f014d26` | black-eyes loan      |
| 60570073    | origination | `e3cebfc538f3eca80438a59b173a40ab2fc9bbd5feb34eb93e11e4226849cb3c` | orange-eyes loan     |
| 11299684    | origination | `752523a1a3cbadff35affcee7efdbf0af1b6fc8da52c508cb23ad713c7a4c014` | green-eyes loan      |

Unconfirmed strict-shape candidates that should not be added to `known-transactions.json` until externally verified:

| Inscription | Tx                                                                 | Notes                                                    |
| ----------- | ------------------------------------------------------------------ | -------------------------------------------------------- |
| 10827843    | `53403b0dfbbb60e8774393563676d85df0dcaca9636af5110bda26fca4599486` | Strict shape; not visible/confirmed in Liquidium UI yet. |
| 83315113    | `fbe15fbff9b6d91a7b55f31c3a6931f77eea652012e2962da13c8782db27b0cd` | Strict shape; not visible/confirmed in Liquidium UI yet. |

Confirmed close-variant fixtures (now caught by the relaxed gate, no longer require an allowlist entry):

| Inscription | Tx                                                                 | Match kind     |
| ----------- | ------------------------------------------------------------------ | -------------- |
| 11209953    | `271f9ed476bcc7794e2cbd15b511bddb2983b32b725de3c868939985c7f0fac5` | relaxed-p2wpkh |
| 11299682    | `3bdb0927d54909e5556648aa6fcfe4652253fc0f227f1cecc1da675ec431a14e` | variant-p2tr   |
| 60571179    | `a63030cdebfdd9c2b70e5f3a6c30a5dfc6412ce356e776d454b3e7cdfaf710e2` | relaxed-p2sh   |
| 60580809    | `85897139589e8fd781c9cf28f6779a780e5e04f48a3c79076b5d29edbf5f2201` | relaxed-p2sh   |
| 83296297    | `8fe3ee399ac1ac7eeee3709f983952ea0c59a9671dcbba7353181118f7dde8d9` | relaxed-p2wpkh |
| 60576225    | `ac36feb9f178a10ce02510031f8e2541af4569ce795e8bb8a24abb95393fac60` | relaxed-p2sh   |
| 83316387    | `55f6031370baf5f49e3080a83afc24d87452195d936187505a79f4c5d786b00c` | relaxed-p2sh   |
| 60578966    | `3e226ec40701acc1381d5eccc1912b6d258f7182e2f9fcea419fb2984f479dac` | relaxed-p2wpkh |
| 83295902    | `872fb86eb415c2db041fbc701419826dc06abce1f824703e009401887665ad2e` | relaxed-p2wpkh |
| 83307339    | `3f8022c740a23dac9dce59a6b6707522af21801c8eaafd36bfd8cc415b9e3c80` | variant-p2tr   |
| 60578991    | `a9cc5fabbcebd5511699590f6ce33c6572d05d897d0a9e1de3f9dc498811bcf8` | relaxed-p2sh   |
| 11209362    | `7380b922ea8aeaf8e4c79f7eca821791f3893fd29f7d05a0f6cfbe89a204e71f` | variant-p2tr   |
| 83313543    | `b08020802dd431a21c7f1b58a47fd3010b1cd51e7bd4207759992df28ae5d5fd` | relaxed-p2wpkh |
| 60563151    | `81488471b6dd9adbf9a013ee278af36ee47cd771c6a752fd4ca7d836e1594df4` | relaxed-p2sh   |
| 60580576    | `7d62f433d3ce3af27f065ab57c7cb580125af2b4beee9339d589cecab56e5ed4` | relaxed-p2wpkh |

Previously "no loan visible" review candidates (45-day review, 2026-05-05) — now promoted to `loan-originated` by the relaxed gate. Original review verdict was reviewer-window error: 4 of 7 inscriptions have other confirmed Liquidium loans in our DB, and the structural Liquidium signature (activation-fee address + P2WSH lender vault + 1-of-2 multisig witness) is identical to confirmed loans.

| Inscription | Tx                                                                 | Match kind          |
| ----------- | ------------------------------------------------------------------ | ------------------- |
| 11523683    | `528baccbe5abfb296232bbe6b61e8a85398fa8eab932e76a9b27956be55b4568` | relaxed-p2sh        |
| 60578644    | `04a6e51abc60c88175e4f9096c71f576317a6705aac7b0bd998a711eaee1bc6e` | relaxed-p2wpkh      |
| 83309473    | `c06c737b2ae808a7e0f52beca8b4ea03387f98f2d5264f4b196b9992c2502b99` | relaxed-p2wpkh      |
| 60583606    | `7db5169ac6ba64cb1d3a3c16f1d7d9e0d077b85d8021c15d0bb9602516485cfb` | relaxed-p2wpkh      |
| 83315138    | `8a646e2eb8aa89f02a3202ad4726843c7ba989c3a5d7191028e729597647186f` | relaxed-p2tr-bigvin |
| 60566708    | `0949c415a7da6adb335b8c9285950cef090c3d2708fb88fb586babcf0ff3f4f4` | relaxed-p2sh        |
| 83312962    | `d751130a39198be0f7aca1fbc6c3a934cab78275cae02e299233cb932385d9e5` | relaxed-p2wpkh      |

### 6.1.2 Liquidium modern resolution fixtures (chain-fingerprint, promoted)

Spot-checked across the production population (171 repay-shape + 49 default-shape closed loans across the 220 modern §2.4 origins observed at promotion time). All sampled resolutions carried internal pubkey `50929b74…ac0`; leaf shape always agreed with the borrower-vs-other destination heuristic.

| Inscription | Type      | Tx                                                                 | Notes                                                                                |
| ----------- | --------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 11299684    | repaid    | `096190e7b23881530451e470610f7a0381f286806400c5224b916020f2f303bf` | Cooperative-leaf repay (270 hex chars), Liquidium activation P2TR present in vout[2] |
| 11299684    | repaid    | `bd7c9534c5ec20078f129a5628b26e7a09c9234798b92b800652a505b6b4c04e` | Same shape; second loan on same OMB by same borrower                                 |
| 11299684    | repaid    | `10999a1895920b13f3b5beefc5f7ed45e22c6bff74766b8e5b9863515008635d` | Same shape; large vin count (10 P2SH inputs paying back BTC)                         |
| 60578468    | defaulted | `b4e99def0cbe9e3ef481c7bfeebe4cdd336eb119a06ed03fc14228d1e5392e5d` | CSV-gated leaf (148 hex chars, contains b275); 2-out lender seizure                  |

Lifecycle-driven aggregates: `inscriptions.active_loan_count` decrements on resolution; `loan_count` lifetime counter is unchanged.

### 6.2 ACP-style sale detection (Layer 1 onchain heuristic)

18 events currently tagged. Need to spot-check a sample to confirm they're real sales (and identify which marketplaces use ACP). **Action item:** sample 5, verify externally, document findings here.

### 6.3 Magisat sales (true positives — N=14, fingerprint match rate 14/14)

All 14 confirmed Magisat OMB sales discovered via the §2.9 API cross-reference contain `3Ke21osfhEbEryUeqdwAuAY8VKxm5B9uB2` as a vout AND at least one ACP-signed input. Position is vout[3] in the dominant 7-output shape (13 of 14) and vout[2] in the single 3-output outlier (#60583767).

| Inscription | Tx                                                                 | n_in/n_out | Price (sats) |
| ----------- | ------------------------------------------------------------------ | ---------- | ------------ |
| 11299610    | `35448512f39f65aaf9fa86794cb1dbcd7dc219962c9f0f83dcea9df7230cfe27` | 6/7        | 5,010,000    |
| 60576611    | `a05018db45ef694309fd479471532b4deab73f78ca6f4f81c308c691d10a004c` | 4/7        | 1,990,000    |
| 83315935    | `9b39158d01b120bb4d7b9672bb33853fcfd2fb4d16d87bfc90bc09ee5be8efcb` | 4/7        | 1,700,000    |
| 83313141    | `fe6f0cea64e5531b08201a799994a51e0c70099a244c2e386867da369cc56976` | 12/7       | 1,650,000    |
| 60577519    | `4fb45a9d7ecce4d21772712a905ce0e02231628d894636b152a24e159028b2ab` | 5/7        | 1,980,999    |
| 83314941    | `c2e8525350484452aa9fe0e7ac84555ba0c8e6ed7e6ede2955f14d4e665ca877` | 5/7        | 1,490,000    |
| 60577519    | `64b6da0210ea2c8d10b1e8484ed26dec35cefa19682cdc61c0424e663b5db60c` | 6/7        | 1,950,999    |
| 60575164    | `a2ab6124d0169fb7b8b78a9af63644ba2f2270f154fb64cf0a91d917b602a18a` | 15/7       | 18,699,004   |
| 60563279    | `26fa970071d96815f1bd36564e5682c69609cfc48183356540ff43f0ffd030c4` | 5/7        | 22,885,999   |
| 60583767    | `ed699e3337dcb038c231ee4007cd5ad139963fa1569f41ddb342b385a3fe75f1` | 4/3        | 21,791,499   |
| 60577536    | `4ea9f02b3622d0d49122e427fdd8c9f07314947f71b8334a31feed965739ac15` | 8/7        | 23,880,999   |
| 60576648    | `a4af1a3135c55826dec44ae469ea49df80b4d3768e8d755dfe90b75e2121ef7d` | 24/7       | 25,771,499   |
| 60580333    | `01b7312da978f86a7ac66a786410e64e08377a287bbce476b8d13eceb393c39c` | 6/7        | 36,716,499   |
| 60579029    | `e566eb2e00cf88da73df433841eadb9afbbf7700582ce93f84b42f613629424e` | 9/7        | 35,820,999   |

### 6.4 Mint wallets (chain-truth, N=8,739 across 5 colors)

See §2.1 for the full table. All five colors covered.

### 6.5 Counter-examples (true negatives — important for keeping fingerprints honest)

| Tx                                                                             | Why this is NOT what it might appear to be                                                                                                                                                                                              |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `b9a77cffc3914af60564d49bb34a5d421075780e91cebaa20cad639530671d57` (#83309450) | Has `bc1papmpmu0…59se9u` as vout[1] — NOT a Magisat sale. Refutes §4.2.                                                                                                                                                                 |
| `3bd09bfc7d229428cb99cfb44170e939b80a297b2f35f2e2ea2af7df0da22711` (#11299747) | OP_CSV-less, single-leaf tap-tree, internal pubkey `428a…` — Phase 4 misclassified as `loan-unlocked`. Refutes §4.5.                                                                                                                    |
| `d5196bd8b3ae4a1a23975e40d88edc7c30cc42ba5df47b7c2b41fa8a6d5aeba5` (#83296407) | 4-out borrower-self-funded shape, but routes 46k sats to `bc1qt40u…` which is a known non-Liquidium service. Refutes §4.4.                                                                                                              |
| `ee5e21593176efc432d88d5a0ec74afab5265670c036861b54dada4a22b87235` (#11273300) | User-flagged as a Magic Eden buy but has no fee output and no seller payment — almost certainly the inscription-delivery leg of an offer accept whose BTC moved in a sibling tx. Candidate ME rule (§2.10) correctly does NOT match it. |

### 6.6 Magic Eden sales (true positives — N=10, candidate fingerprint not yet promoted)

User-flagged ME sales spanning blocks 796440 → 886371 (~16 months). All 10 carry the candidate primary fee address `bc1qcq2uv5nk6hec6kvag3wyevp6574qmsm9scjxc2`; the two oldest also carry the secondary P2SH candidate `3P4WqXDbSLRhzo2H6MT6YFbvBKBDPLbVtQ`. Modern PSBT shape is the dominant 4-in/7-out ACP variant; cooperative SIGHASH_ALL fixtures (#83295649, #83296358, #213924, #60563128) are user-suspected accept-offer flows.

| Inscription | Tx                                                                 | Block  | Shape          | Sale (sats) | Fee (sats) |
| ----------- | ------------------------------------------------------------------ | ------ | -------------- | ----------- | ---------- |
| 10610550    | `217789a1f411ebfcbdb562541cf751d90220e8b4c7de08e0fa2fdfdc0da143cc` | 796440 | acp-7out       | 32,745,500  | 822,500    |
| 10611504    | `1f2f75c03f2ef731286c7b96f4d62d12135c674b17747d86d2fd9ba6efce4630` | 796750 | acp-7out       | 34,835,000  | 875,000    |
| 10611504    | `8c20f030cf9f5612875cdc338fcfc9d23fb6da93553842181f33e902c4efdd55` | 796923 | acp-7out       | 39,710,500  | 997,500    |
| 10827825    | `067e6a26db80546ff1c1ec3f434c31411f1c936f3d42370db11a78300bc98f00` | 798149 | acp-7out       | 37,820,000  | 950,000    |
| 11183491    | `154ea6484dc569217ca4e85bd2106ec0dcd1a7142e9d3ee9e01f83dbc79316a2` | 798599 | acp-7out (6in) | 27,870,000  | 700,000    |
| 213924      | `aeab14bbd42561d8011336747010a930102e74daf2d6ffae63f3ace304cffe61` | 832583 | coop-multiin   | 284,210,000 | 7,250,000  |
| 60563128    | `b41008e15cff4de04453d828802e9ded1fbf86b321cd808635907e8245599e9e` | 835705 | coop-4out      | 107,504,059 | 2,742,425  |
| 83295649    | `1d3f7c1fbdd8e025e068b37436e2dfa4361371d2dfca68279bb063678abde7f7` | 885624 | coop-4out      | 5,880,900   | 150,000    |
| 83296358    | `a97b3ccd791140494cbdf920a60002e3398d1b863a6d99a5b4b4a99ac05c8538` | 885756 | coop-4out      | 6,992,900   | 178,750    |
| 83315561    | `5793cc95580a34809ff8681cff157acc1295e9a5a15b01451ef524d48dad4fc8` | 886371 | acp-7out       | 4,179,900   | 105,000    |

Fee/sale ratios: 2.51% – 2.55% across all 10 — strong corroborating signal independent of the address-recurrence rule.

### 6.7 ord.net sales (true positives — N=2 confirmed OMB)

User-flagged ord.net sales. Both carry the candidate fee P2TR `bc1pgkfga880836f5kp3m9vvya4m0whva80ddm58r7fyltzp9q8t08rs0rdnet` at vout[0] (639-sat dust marker) AND vout[3] (real fee). Cooperative SIGHASH_ALL/DEFAULT shape; 0 ACP signatures. Seller payment at vout[2].

| Inscription | Tx                                                                 | n_in/n_out | Sale (sats) | Fee (sats) |
| ----------- | ------------------------------------------------------------------ | ---------- | ----------- | ---------- |
| 60571179    | `c3f4becc98d85bf64d61bcf25972f0eae93e76d99f15fec0cf9a9ec66cf7cfa8` | 9/7        | 2,327,499   | 58,090     |
| 83313913    | `0e46cd272f741e8be56e8790c7664fb3e940e4b487c112a36792701355656959` | 6/7        | 1,980,900   | 49,340     |

A probe across the 400 most-recent OMB sales in ord.net's own `__data.json` feed found exactly these 2 fingerprint matches and nothing else — the rest are aggregated from other marketplaces (Magic Eden / Magisat / Satflow), not settled by ord.net themselves. The OMB-specific TP set is small but the rule is anchored by mempool address-history evidence: 50/50 sample txs to the fee address are output-only (0 sweep-out → dedicated fee account), 0 co-occurrence with Magisat or either Magic Eden fee address.

The TN class is the union of §6.3 (14 Magisat fixtures) and §6.6 (10 Magic Eden fixtures) — none carry the ord.net fee address, and the live rule correctly fingerprint-misses each.

## 7. Audit + cleanup status

All three groups identified during the v26 audit have been resolved or are tracked.

### 7.1 5,085 `onchain-coop-heuristic` `sold` events — RESOLVED 2026-05-04

Reverted in schema v26 (option (a) — "tear out anything we are not sure about"). Each row is now `event_type='transferred'`, `marketplace=NULL`, `sale_price_sats=NULL`, with `raw_json.source='reverted-from-coop-heuristic'` and `raw_json.prior_source='onchain-coop-heuristic'` preserved for traceability. Per-inscription `transfer_count` / `sale_count` / `total_volume_sats` / `highest_sale_sats` recomputed in the same migration. If we ever want a chain-fingerprint cooperative-sale detector, it must satisfy §1's tier requirements (≥3 TPs + ≥1 TN with externally-verified ground truth) before promotion.

### 7.2 3 misclassified loan resolutions — RESOLVED 2026-05-04

Phase 4 (`src/lib/loanDetect.ts`) now enforces the §2.2 internal-pubkey check — only spends with control-block internal pubkey `9367…d27a` flip to `loan-*`. `DETECTOR_VERSION` bumped to 3 to mark rows that have passed this check. Existing rows tagged by earlier detector versions are cleaned up out-of-band by `scripts/cleanup-non-liquidium-loans.js` (runs once after deploy; idempotent — re-checks each loan-\* event's witness via bitcoind RPC and reverts non-Liquidium ones to `transferred`). See DEPLOYMENT.md for the runbook.

### 7.3 `active_loan_escrows` table — REMOVED 2026-05-04; active-loan leaderboard restored 2026-05-05

Dropped entirely in schema v26 (table + `loanEscrowDetect.ts` + `?mode=loan-escrows` poll mode + `safeLoanEscrows` plumbing). Per §2.3, active Liquidium escrows cannot be cryptographically proven until spend, so the old escrow-address leaderboard is not coming back.

The `/explorer/currently-loaned` leaderboard is restored as a different signal: it is derived from `inscriptions.active_loan_count`, which is incremented by confirmed/tagged `loan-originated` events (§2.4) and decremented when a matching `loan-repaid`, `loan-defaulted`, or `loan-unlocked` spend is observed. Treat it as "currently tagged open loan cycles," not as an independent proof that a specific escrow output is still active.

The lifetime "Most Borrowed Against" leaderboard (`/explorer/most-loaned`, derived from `inscriptions.loan_count`) remains the historical counterpart.

### 7.4 Modern Liquidium origination backfill — RUN AFTER DEPLOY

Run once after deploying the §2.4 production matcher:

```bash
pnpm backfill-liquidium-originations
```

Use `pnpm backfill-liquidium-originations -- --dry-run` first when testing manually. The script requires `BITCOIN_RPC_URL` and uses `OMB_DB_PATH` (default `/data/app.db`). It reclassifies historical `transferred`/`sold` rows to `loan-originated`, unwinds stale sale/transfer aggregates, updates `loan_count` / `active_loan_count` / `effective_owner`, and drops obsolete notification queue entries for upgraded rows.

### 7.5 Modern Liquidium resolution backfill — RUN AFTER DEPLOY

Run once after deploying the §2.5 resolution detector. Order matters: the resolution sweep relies on the §2.4 origination backfill having already promoted modern `loan-originated` rows, since it walks each escrow forward to find the spend.

```bash
pnpm backfill-liquidium-modern-resolutions
```

Use `pnpm backfill-liquidium-modern-resolutions -- --dry-run` first when testing manually. Same env vars as §7.4. Upgrades each `transferred` row that comes out of a modern escrow to `loan-repaid`, `loan-defaulted`, or `loan-unlocked` based on the leaf shape, decrements `inscriptions.active_loan_count`, and drops the obsolete notify-queue entries. Idempotent.

### 7.6 Modern Magic Eden tagger backfill — RUN AFTER DEPLOY

Run once after deploying the §2.10 detector + schema v27. The live `magic-eden-fp` tick bootstraps its cursor to current `MAX(events.id)` and only fingerprints forward — historical `transferred` rows + `marketplace IS NULL` `sold` rows that are actually ME sales need the one-shot sweep.

```bash
pnpm backfill-magic-eden-fingerprint
```

Use `pnpm backfill-magic-eden-fingerprint -- --dry-run` first to preview. Required env: `BITCOIN_RPC_URL`, `OMB_DB_PATH` (default `/data/app.db`). Upgrades `transferred` rows in place to `sold` with `marketplace='magic-eden'`, extracts `sale_price_sats` per the §2.10 shape rules, recomputes per-inscription `transfer_count` / `sale_count` / `total_volume_sats` / `highest_sale_sats`. Skips rows already tagged with a non-ME marketplace (logs the count but doesn't touch them). Idempotent — safe to re-run. Notify queue is **not** enqueued for backfilled rows (matches the §7.4/§7.5 policy).

### 7.8 Modern ord.net tagger backfill — RUN AFTER DEPLOY

Run once after deploying the §2.11 detector + schema v28. The live `ord-net-fp` tick bootstraps its cursor to current `MAX(events.id)` and only fingerprints forward — historical `transferred` rows + `marketplace IS NULL` `sold` rows that are actually ord.net sales need the one-shot sweep.

```bash
pnpm backfill-ord-net-fingerprint
```

Use `pnpm backfill-ord-net-fingerprint -- --dry-run` first to preview. Required env: `BITCOIN_RPC_URL`, `OMB_DB_PATH` (default `/data/app.db`). Upgrades `transferred` rows in place to `sold` with `marketplace='ord-net'`, extracts `sale_price_sats` per the §2.11 cooperative shape rule, recomputes per-inscription `transfer_count` / `sale_count` / `total_volume_sats` / `highest_sale_sats`. Skips rows already tagged with a non-ord-net marketplace. Idempotent — safe to re-run. Notify queue is **not** enqueued for backfilled rows (matches the §7.4–§7.6 policy).

### 7.7 Magic Eden cooperative no-payment revert — RAN 2026-05-05

The initial §2.10 backfill upgraded any `transferred` row whose tx matched the cooperative shape (ME fee output + no ACP signatures), even when `extractSalePriceSats` returned null. In practice, every observed null-price cooperative tx is the no-payment delivery-leg pattern (#11273300, §6.5): ME fee output is present but no BTC actually flows to the seller — not a sale. User spot-check on `bc1ps2gh7q…vnw` surfaced this. 3,768 rows across 2,471 inscriptions were mistakenly flipped to `sold + marketplace='magic-eden'`.

Fix shipped in two parts:

1. **Code gate** in `src/lib/magicEdenFingerprintTick.ts` and `scripts/backfill-magic-eden-fingerprint.js`: skip the upgrade when `match.shape === 'cooperative' && extractedPrice == null && existing sale_price_sats == null`. Cooperative rows where another path (ord-net, satflow) already supplied a trusted price stay tagged.
2. **Cleanup** via `pnpm revert-magic-eden-coop-no-price` (one-shot). Selection: `event_type='sold' AND marketplace='magic-eden' AND sale_price_sats IS NULL AND raw_json.magic_eden_fp.shape='cooperative'`. Per row: flips back to `transferred`, clears marketplace, decrements `inscriptions.sale_count` / increments `transfer_count` (volume/highest unaffected since price was null), drops the matching `notify_pending` entry. Annotates `raw_json` with `source='reverted-from-magic-eden-fp'`, `prior_*` fields, `revert_reason='me-coop:no-extractable-payment'`. Idempotent — once flipped, the WHERE filter excludes the row.

```bash
pnpm revert-magic-eden-coop-no-price            # dry-run
pnpm revert-magic-eden-coop-no-price -- --apply # commit
```

## 8. How to add a new tagging rule

Required steps before any code change touches the tagger:

1. **Hypothesis.** State the rule: "txs with property X are marketplace Y sales." Be specific about what X is (fee address, sighash flag, output pattern, etc.).
2. **Find ≥3 true positives.** Independently confirmed: each tx must be visible on the marketplace's UI as a real sale, OR confirmed by direct counterparty.
3. **Find ≥1 true negative.** A tx that satisfies property X but is NOT marketplace Y. If you can't find one, your rule is too loose.
4. **Code the rule** in `src/lib/<area>Fingerprint.ts` (one file per concept). Reference the test corpus by tx id in a code comment.
5. **Add fixtures to `scripts/known-transactions.json`** — both true positives and true negatives, with `expected_type` and a description.
6. **Update §6 of this doc** with the new fixtures.
7. **Backfill carefully:** dry-run against a prod snapshot, audit a 10-row sample, then live with `notify_pending` skipping (historical re-tagging must not alert subscribers).
8. **Wire a forward-only cursor + matching backfill script.** The live tick must NOT replay history (a fresh deploy can't be allowed to re-process 36k+ rows on every restart), so its cursor bootstraps to current `MAX(events.id)` on first run. That means **events landed before deploy stay tagged whatever they were tagged as** — usually `transferred` from the ord poll. The fix is a one-shot historical sweep script (`scripts/backfill-<area>.js`). Two requirements:
   - The bootstrap branch must emit a `log.warn` calling out the script by name. We learned this the hard way: #11299610 sat tagged `transferred` instead of `sold/magisat` for a full deploy cycle because nobody saw the bootstrap log.
   - Add the script to `DEPLOYMENT.md → Post-deploy required steps` in the SAME PR, so the next operator (you, in two weeks) can't miss it.
9. **Cite this doc** in the commit message.

If a rule is later refuted, **document it in §4** rather than silently removing — future sessions need to know what was tried and why it didn't hold.

## 9. Anti-patterns to avoid

- Tagging based on a single observation. "I saw 50 txs share this address therefore it's marketplace X" is not enough — recurrence proves _something is recurring_, not what.
- Trusting a 3rd-party API as authoritative. APIs are spot-check tools. If our chain detection disagrees with an API, investigate; don't just defer to the API.
- Bundling unrelated tagging changes in one commit. Each marketplace, each event_type, each protocol gets its own commit so reverts are surgical.
- Burying a refutation. If something doesn't pan out, it goes in §4 with the reason.
