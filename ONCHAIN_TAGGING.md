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

### 2.3 Liquidium loan principal _cannot_ be detected on-chain for unspent escrows

Given a candidate escrow output key Q and the known internal pubkey P, the relationship `Q = lift_x(P) + tweak·G` does not constrain Q (every output key admits this form for _some_ tweak). Computing the actual tweak requires the merkle root, which depends on per-loan parameters (CSV timestamp, lender pubkey, borrower pubkey) we don't have until the escrow spends.

- **Confidence:** chain-truth (this is a property of BIP-341).
- **Implication:** there is **no** on-chain detection rule for currently-active Liquidium loans. The previous `active_loan_escrows` table populated 32 false positives and was dropped in schema v26 (see §7.3). We will not maintain that table.

### 2.4 Self-transfers (`old_owner == new_owner`) are not real transfers

Postage moves, UTXO consolidation, and fee bumps within the same wallet appear as transfers in raw ord output but represent no change of ownership. Schema v21 deletes them retroactively and the live ord poll skips them.

- **Confidence:** chain-truth (literally same address on both sides).
- **Tag rule:** drop at insert time + already-backfilled.

### 2.5 Satflow-recorded sales (legacy, kept under legacy-3rd-party tier)

282 `sold` events have `marketplace = 'satflow'`. These came from Satflow's `/v1/activity/sales` endpoint pre-policy. Kept as legacy data; not extended (the API enrichment continues for now but new rules should target the on-chain Satflow PSBT signature directly — see §5).

### 2.6 Magisat marketplace fingerprint (on-chain)

**Primary detection rule.** The Magisat PSBT marketplace appends a fixed P2SH fee output to every settled listing. Two on-chain signals together identify a Magisat sale unambiguously:

1. **Fee output:** at least one `vout` has `scriptpubkey_address = '3Ke21osfhEbEryUeqdwAuAY8VKxm5B9uB2'`. Position is typically vout[3] in the dominant 7-output shape but the rule does not require a fixed index (one observed 3-output outlier had it at vout[2]).
2. **ACP signature:** at least one `vin` has a 65-byte schnorr signature (130 hex chars in the witness's first item) ending in `0x83` (`SIGHASH_SINGLE | SIGHASH_ANYONECANPAY`). This is the canonical PSBT-marketplace pattern.

**Why both are required:** the fee address alone is sufficient (no other party would route fees to this Magisat-controlled P2SH), but checking the ACP signature alongside protects against a future spam attack where someone constructs a tx that sends dust to `3Ke21os…` to mislabel an unrelated movement.

- **Confidence:** chain-fingerprint.
- **Test fixtures:** 14 true positives (see §6.3 — every confirmed Magisat OMB sale matches). 2 true negatives (#11287305 tx `5c2e3ba9…`, #83309450 tx `b9a77cff…` — neither contains the fee address).
- **Price extraction:** SIGHASH_SINGLE commits input N's signature to output N. For each ACP input at index N whose prevout address equals the seller (`events.old_owner`), the seller's payment is `vout[N].value`. Sum across matching ACP inputs to get the total sale price. (Single-OMB sale → one matching ACP input → price = `vout[N].value`.) The existing `onchain-heuristic` Layer 1 detector already implements exactly this logic — Magisat is one of the marketplaces it was already detecting (just not labeling).
- **Limitations:** if Magisat rotates their fee address, sales stop being tagged. Easy to detect (drop in Magisat-tagged sale rate) and easy to handle (add the new address to the rule). Multi-marketplace fees on the same tx would also tag as Magisat — implausible given they're competing PSBTs.

**Live + historical tagging:**

- **Live (`src/lib/magisatFingerprintTick.ts`):** runs in the 5-min `auto` poll, between `ord` and `satflow`. Walks new `transferred` events (cursor in `poll_state.magisat_fp`), bitcoind-RPC fetches each tx, applies `detectMarketplace`, upgrades matches **in place** to `sold` + `marketplace='magisat'` via `upgradeEventToSoldById`. Same `events.id` row preserved → activity feed shows ONE entry that flips type, never a duplicate transfer + sale pair. Per-tick budget: 200 events at concurrency 8. On first deploy after v25, cursor bootstraps to current MAX(events.id) so live ticks don't replay 36k+ historical rows.
- **Historical (`scripts/backfill-magisat-fingerprint.js`):** one-shot bitcoind-driven sweep over all existing `transferred` and `marketplace IS NULL sold` rows. Run once after deploy. Idempotent; safe to re-run.
- **Verification (`scripts/backfill-magisat-sales.js`):** API cross-reference per §2.7. Confirms the fingerprint isn't missing real sales.

### 2.7 Magisat sale verification via API (cross-reference, secondary)

Magisat's public `/activity/global` feed exposes finalized PURCHASE / OFFER_PURCHASED rows with a `buyerTxId` field — the on-chain tx id Magisat broadcast to settle the listing. Matching that against `events.txid` is a **verification path**, not the primary detector. Use it to:

1. Spot-check that the §2.6 fingerprint isn't missing real sales (every API match should also fingerprint-match — if not, the fingerprint needs revisiting).
2. Bootstrap fixtures when introducing new fingerprint rules.
3. Recover sales that pre-date a known fee-address rotation.

- **Coverage as of 2026-05-04:** 14 OMB sales in their ~6,500-row public feed. All 14 ALSO match the §2.6 fingerprint — fingerprint coverage is exhaustive on the API-confirmed set.
- **Code:** `scripts/backfill-magisat-sales.js` (idempotent, safe to re-run). Adds `raw_json.magisat_backfill` for traceability.
- **Confidence:** chain-truth (cross-referencing two on-chain identifiers — implausible failure modes).

## 3. Tagging rules currently active

| `event_type`                                                           | When emitted                                                                                     | Source rule             | Confidence tier  | Marketplace tag |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------- | ---------------- | --------------- |
| `transferred`                                                          | ord poll detects UTXO change for any inscription, OR `backfill-transfers.js` walks chain history | UTXO movement           | chain-truth      | NULL            |
| `mint`                                                                 | `old_owner` matches a registered mint wallet (§2.1) AND inscription color matches                | Wallet → color map      | chain-truth      | NULL            |
| `sold` (Magisat)                                                       | `magisat-fp` poll step finds the §2.6 fingerprint and upgrades the `transferred` row in place    | `src/lib/marketplaceFingerprint.ts` | chain-fingerprint | `'magisat'` |
| `sold` (other paths)                                                   | (see §3.1 below — currently mixed quality)                                                       | Multiple paths          | mixed            | varies          |
| `listed`                                                               | Satflow API listings stream                                                                      | Satflow                 | legacy-3rd-party | `'satflow'`     |
| `loan-originated` / `loan-defaulted` / `loan-unlocked` / `loan-repaid` | Phase 4 detects an OP_CSV+OP_DROP script-path spend; traces back to origination                  | `src/lib/loanDetect.ts` | mixed (see §2.2) | NULL            |

### 3.1 `sold` events — current state of mixed quality

| Source key in `raw_json`                                          | Count  | Tier                                                                 | Action                                |
| ----------------------------------------------------------------- | ------ | -------------------------------------------------------------------- | ------------------------------------- |
| `ord-net-history-backfill`                                        | 15,706 | legacy-3rd-party                                                     | Keep as-is. Marketplace already NULL. |
| `reverted-from-coop-heuristic` (was: `onchain-coop-heuristic`)    | 5,085  | reverted to `transferred` in v26 (§7.1)                              | No further action.                    |
| `onchain-heuristic` (Layer 1 ACP, confidence: high)               | 18     | chain-fingerprint candidate                                          | Verify and promote. See §6.2.         |
| Satflow                                                           | 282    | legacy-3rd-party                                                     | Keep as-is.                           |
| `onchain-magisat-fp` (live + historical via fingerprint)          | 14+    | chain-fingerprint                                                    | Primary path going forward. See §2.6. |
| `magisat-api-backfill` (cross-reference, fallback verification)   | (n/a)  | chain-truth                                                          | Verification only. See §2.7.          |

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

Three loan-\* events use different pubkeys (`428a…`, `2e8f…`) with single-leaf tap-trees. A Liquidium loan must have a default path — these aren't Liquidium. The Phase 4 detector was over-greedy; it accepted any OP_CSV+OP_DROP regardless of internal pubkey.

## 5. Open questions / what needs more data

These are the gaps. Each is a **specific** thing we'd need before we can tag confidently.

### 5.1 What is `bc1papmpmu0xzfvw4x9qe4jstgxfnfy5q8zhh6xredjxd86ca74uph3s59se9u`?

A real recurring fee-collector address but unidentified. Not Magisat, not Liquidium, not in any loan event role. Could be OKX, OrdSwap, ord.io, or a custom escrow service.

**To resolve:** check 3-5 of the txs that have this as vout[1] against each marketplace UI (or DM the marketplaces with the txid). Once positively identified by **2+ corroborating sources**, add a fingerprint rule.

**Sample txs to spot-check:** `5c2e3ba9ab42fd5d2f3752d15cd5a0154b903668391fe6301f895e1ed1fa73d9` (#11287305, sold 3d ago — user already confirmed this one was a sale, marketplace unknown), `b9a77cffc3914af60564d49bb34a5d421075780e91cebaa20cad639530671d57` (#83309450, NOT on Magisat).

### 5.2 Magisat on-chain fingerprint

**Resolved 2026-05-04** — see §2.6. The fee address `3Ke21osfhEbEryUeqdwAuAY8VKxm5B9uB2` recurs in 14/14 confirmed Magisat sales and is absent from 2/2 confirmed-not-Magisat sales. Fingerprint promoted to chain-fingerprint tier.

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

| Inscription | Type      | Tx                                                                 | Era                  |
| ----------- | --------- | ------------------------------------------------------------------ | -------------------- |
| 10444091    | default   | `fb8259cd3d3c18d2ed037f3d91323766a783635dff42fa8871174876475d85fb` | legacy 3PizFz9       |
| 11299730    | default   | `16459e791f516c694636fc4320bd9ef550b2a51f69b69ab79ce59cd6d71cdbe4` | legacy 3PizFz9       |
| 60566736    | unlock    | `7c3d11e2f323ea628481585fc520b7abb4d7cd2055553d3d1b8cde02037e6cd5` | legacy 3PizFz9       |
| 60566736    | repayment | `7a0618d95d8f5a238308b6854393e5d50a7f5bfe99f693ddb3b2db4608f0d091` | (BTC-only repayment) |

All three resolution-type fixtures verify against internal pubkey `9367…d27a`.

### 6.2 ACP-style sale detection (Layer 1 onchain heuristic)

18 events currently tagged. Need to spot-check a sample to confirm they're real sales (and identify which marketplaces use ACP). **Action item:** sample 5, verify externally, document findings here.

### 6.3 Magisat sales (true positives — N=14, fingerprint match rate 14/14)

All 14 confirmed Magisat OMB sales discovered via the §2.7 API cross-reference contain `3Ke21osfhEbEryUeqdwAuAY8VKxm5B9uB2` as a vout AND at least one ACP-signed input. Position is vout[3] in the dominant 7-output shape (13 of 14) and vout[2] in the single 3-output outlier (#60583767).

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

| Tx                                                                             | Why this is NOT what it might appear to be                                                                                 |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `b9a77cffc3914af60564d49bb34a5d421075780e91cebaa20cad639530671d57` (#83309450) | Has `bc1papmpmu0…59se9u` as vout[1] — NOT a Magisat sale. Refutes §4.2.                                                    |
| `5c2e3ba9ab42fd5d2f3752d15cd5a0154b903668391fe6301f895e1ed1fa73d9` (#11287305) | Has `bc1papmpmu0…59se9u` as vout[1] — confirmed sale but marketplace unknown. Refutes §4.3 (4-out shape ≠ loan).           |
| `3bd09bfc7d229428cb99cfb44170e939b80a297b2f35f2e2ea2af7df0da22711` (#11299747) | OP_CSV-less, single-leaf tap-tree, internal pubkey `428a…` — Phase 4 misclassified as `loan-unlocked`. Refutes §4.5.       |
| `d5196bd8b3ae4a1a23975e40d88edc7c30cc42ba5df47b7c2b41fa8a6d5aeba5` (#83296407) | 4-out borrower-self-funded shape, but routes 46k sats to `bc1qt40u…` which is a known non-Liquidium service. Refutes §4.4. |

## 7. Audit + cleanup status

All three groups identified during the v26 audit have been resolved or are tracked.

### 7.1 5,085 `onchain-coop-heuristic` `sold` events — RESOLVED 2026-05-04

Reverted in schema v26 (option (a) — "tear out anything we are not sure about"). Each row is now `event_type='transferred'`, `marketplace=NULL`, `sale_price_sats=NULL`, with `raw_json.source='reverted-from-coop-heuristic'` and `raw_json.prior_source='onchain-coop-heuristic'` preserved for traceability. Per-inscription `transfer_count` / `sale_count` / `total_volume_sats` / `highest_sale_sats` recomputed in the same migration. If we ever want a chain-fingerprint cooperative-sale detector, it must satisfy §1's tier requirements (≥3 TPs + ≥1 TN with externally-verified ground truth) before promotion.

### 7.2 3 misclassified loan resolutions — RESOLVED 2026-05-04

Phase 4 (`src/lib/loanDetect.ts`) now enforces the §2.2 internal-pubkey check — only spends with control-block internal pubkey `9367…d27a` flip to `loan-*`. `DETECTOR_VERSION` bumped to 3 to mark rows that have passed this check. Existing rows tagged by earlier detector versions are cleaned up out-of-band by `scripts/cleanup-non-liquidium-loans.js` (runs once after deploy; idempotent — re-checks each loan-* event's witness via bitcoind RPC and reverts non-Liquidium ones to `transferred`). See DEPLOYMENT.md for the runbook.

### 7.3 `active_loan_escrows` table — REMOVED 2026-05-04

Dropped entirely in schema v26 (table + `loanEscrowDetect.ts` + `/explorer/currently-loaned` route + `?mode=loan-escrows` poll mode + `safeLoanEscrows` plumbing). Per §2.3, no on-chain detection rule can satisfy §1's principles for currently-active Liquidium loans (BIP-341 makes the escrow tap-tree opaque until script-path spend). The lifetime "Most Borrowed Against" leaderboard (`/explorer/most-loaned`, derived from `inscriptions.loan_count` populated by Phase 4 chain-fingerprint resolutions) is the surviving accurate signal.

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
