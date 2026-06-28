// On-chain wallet clustering — pure heuristics, framework-free.
//
// Imported from both the runtime poll tick (via clusterStore.ts) and the
// host-side backfill scripts. Keep this file free of `server-only` and DB
// imports so node CLI scripts can use it directly.
//
// v2 covers five signal types. The first two are computed incrementally
// in the live tick; the last three depend on global fan-out maps and are
// recomputed by runClusterRecompute (poll mode `cluster-recompute`).
//
// Incremental (live tick):
//
//   1. Common-input ownership (CIH). Multiple non-blacklisted addresses
//      co-spent in one tx are presumed same-owner. Excluded: blacklisted
//      inputs (mint wallets, auto-detected high-degree multiplexers,
//      manual operator entries), marketplace-settlement txs, ACP-PSBT
//      shapes, and high-fanin (>20 inputs).
//
//   2. Self-transfer chain (sx). A `transferred` event with no marketplace
//      tag, neither endpoint blacklisted, is the OMB-postage consolidation
//      pattern. Direction-aware: bidirectional flow (min(ab, ba) ≥ 1) is
//      a much stronger signal than one-way.
//
// Global recompute (cluster-recompute mode):
//
//   3. Co-consolidator (cc). Two "monogamous senders" (each with ≤2
//      lifetime distinct OMB recipients) sharing a destination C with
//      ≥2 such senders. Counts distinct C's connecting the pair.
//      Catches the personal-consolidator pattern that the multi-source-
//      receiver suppression in v1 silently destroyed.
//
//   4. Co-parent (cp). The inverse — two "monogamous receivers"
//      (≤2 distinct lifetime senders each) sharing a non-MSR parent.
//      Catches "primary → sub-wallet distribution" patterns.
//
//   5. Personal-MSR self-xfer (pmx). Direct A↔B transfers where at
//      least one endpoint is a multi-source receiver classified
//      "personal" (either ≥3 of its senders also receive back from it,
//      OR ≥40% of inscriptions it received marketplace=NULL are still
//      held by it now). Re-enables sx-style signal for these MSRs which
//      v1 fully suppressed. pmx_rt is the subset of pmx events where
//      the *receiver* previously owned the inscription — empirically
//      ~47% of legitimate same-human pmx round-trip versus ~10% for
//      cross-trader pairs (see CLUSTERING.md §3 for the calibration).
//
// Confidence is derived from raw counts so the threshold can be tuned
// post-hoc without a recompute.

export type RawTxLike = {
  txid: string;
  vin: Array<{
    prevout?: {
      scriptPubKey?: { address?: string };
    };
    /** Witness elements; only the first (schnorr sig) is consulted. */
    txinwitness?: string[];
  }>;
};

export type EvidenceItem = {
  type: 'cih' | 'self_xfer' | 'pmx';
  txid: string;
  /** Block timestamp (seconds), if known — only used for display ordering. */
  ts?: number;
  /**
   * For self_xfer / pmx evidence: which direction the OMB moved (in
   * canonical pair order, where addr_a < addr_b). 'ab' = old_owner=addr_a,
   * new_owner=addr_b. Omitted for cih (which is symmetric).
   */
  direction?: 'ab' | 'ba';
  /**
   * For pmx (and sx, when known): true if the receiver previously owned
   * this inscription before the event — strong consolidation signal.
   * See CLUSTERING.md §3.
   */
  round_trip?: boolean;
};

export type EdgeCounts = {
  /** v1: common-input heuristic. */
  cih_count: number;
  /** v1: total self-xfer count = self_xfer_ab + self_xfer_ba. */
  self_xfer_count: number;
  self_xfer_ab?: number;
  self_xfer_ba?: number;
  /** v2: # of distinct destinations bridging two monogamous senders. */
  co_cons_count?: number;
  /** v2: # of distinct non-MSR parents distributing to two monog receivers. */
  co_parent_count?: number;
  /** v2: direct transfer events where one endpoint is a personal-MSR. */
  pmx_count?: number;
  pmx_ab?: number;
  pmx_ba?: number;
  /** v2: pmx subset where the receiver previously owned the inscription. */
  pmx_rt_count?: number;
  pmx_rt_ab?: number;
  pmx_rt_ba?: number;
};

/**
 * Canonical pair ordering. Sorts addresses lexicographically so each
 * unordered pair has a stable PRIMARY KEY. `a < b` is enforced by the
 * `wallet_cluster_edges.CHECK` constraint.
 */
export function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** Distinct input addresses from a raw tx (drops nulls and duplicates). */
export function collectInputAddresses(tx: RawTxLike): string[] {
  const seen = new Set<string>();
  for (const vin of tx.vin) {
    const a = vin.prevout?.scriptPubKey?.address;
    if (typeof a === 'string' && a.length > 0) seen.add(a);
  }
  return Array.from(seen);
}

/**
 * Returns true if any input is signed with SIGHASH_SINGLE | SIGHASH_ANYONECANPAY
 * (sighash byte 0x83). Schnorr sig with explicit sighash = 65 bytes
 * (130 hex chars). The universal ACP-PSBT shape across Magisat, Magic
 * Eden ACP, and any off-fingerprint ACP marketplace / OTC tool — a
 * strong "this tx is a multi-party settlement" signal that fires
 * regardless of which fee output (if any) is present. The marketplace
 * fingerprinters (marketplaceFingerprint.ts) reclassify these as
 * `event_type='sold'` so they're already excluded from CIH-eligible
 * candidates, but the gate is kept here as defense-in-depth for
 * unmatched ACP txs.
 */
export function hasAcpInput(tx: RawTxLike): boolean {
  for (const vin of tx.vin) {
    const w = vin.txinwitness;
    if (!w || w.length === 0) continue;
    const first = w[0];
    if (typeof first === 'string' && first.length === 130 && first.endsWith('83')) {
      return true;
    }
  }
  return false;
}

/**
 * Emit canonical CIH pairs for a tx. Returns null when the tx contains a
 * blacklisted input address — in that case we suppress the whole tx
 * because the multiplexer's presence means *any* pair from that tx is
 * suspect (the multiplexer might have been the bridge between unrelated
 * counterparties).
 *
 * Returns an empty array (not null) when the tx is single-party (≤1
 * distinct input address) — distinct from blacklist suppression so the
 * caller can tell the difference.
 */
export function cihPairsFromTx(
  tx: RawTxLike,
  blacklist: ReadonlySet<string>
): Array<[string, string]> | null {
  const addrs = collectInputAddresses(tx);
  for (const a of addrs) {
    if (blacklist.has(a)) return null;
  }
  if (addrs.length < 2) return [];
  const out: Array<[string, string]> = [];
  for (let i = 0; i < addrs.length; i++) {
    for (let j = i + 1; j < addrs.length; j++) {
      out.push(canonicalPair(addrs[i], addrs[j]));
    }
  }
  return out;
}

/**
 * Map raw evidence counts to a confidence score in [0, 10000].
 *
 * Combines five signal types: cih, sx (with directional bidir gate),
 * cc (co-consolidator), cp (co-parent), and pmx (personal-MSR self-xfer
 * with a round-trip subset). Each ladder is tuned so a SINGLE strong
 * tier in any one signal can clear the public-display band (0.95+),
 * and any TWO independent mechanisms firing together push to 0.97+.
 *
 * The B1 "anchor required" rule at 9900: bidirectional pmx alone (no
 * cih, sx, cc, or cp evidence) caps at 0.95 — the cross-trader pattern
 * (two big collectors with active P2P trading) shows up here, and we
 * want the identity-fold tier to require a non-pmx anchoring signal.
 *
 * Counts are stored separately from the derived score so threshold
 * tweaks don't require recomputing edges. Run `?mode=cluster-recompute`
 * to re-derive `confidence` after a ladder change.
 *
 * Tuning history is in CLUSTERING.md §4. Calibration against Matrica
 * ground truth (2026-05-07): precision ~94% / recall ~40% at 9500;
 * precision ~94% / recall ~28% at 9700; precision ~86% / recall <1%
 * at the 9900 identity-fold band (B1 in effect).
 */
export function confidenceFromCounts(c: EdgeCounts): number {
  let p = 0;

  // CIH ladder.
  if (c.cih_count >= 1) p = Math.max(p, 0.8);
  if (c.cih_count >= 2) p = Math.max(p, 0.95);
  if (c.cih_count >= 3) p = Math.max(p, 0.98);
  if (c.cih_count >= 5) p = Math.max(p, 0.99);

  // sx ladder. Direction-aware: bidirectional flow much stronger.
  const sxAb = c.self_xfer_ab ?? 0;
  const sxBa = c.self_xfer_ba ?? 0;
  const sxBidir = Math.min(sxAb, sxBa);
  const sxTotal = c.self_xfer_count > 0 ? c.self_xfer_count : sxAb + sxBa;
  if (sxBidir >= 1) p = Math.max(p, 0.92);
  if (sxBidir >= 2) p = Math.max(p, 0.99);
  if (sxTotal >= 1) p = Math.max(p, 0.5);
  if (sxTotal >= 3) p = Math.max(p, 0.8);

  // CIH × sx combo — different mechanisms agreeing.
  if (c.cih_count >= 1 && sxBidir >= 1) p = Math.max(p, 0.99);
  if (c.cih_count >= 1 && sxTotal >= 1) p = Math.max(p, 0.95);
  if (c.cih_count >= 2 && sxTotal >= 2) p = Math.max(p, 0.99);

  // co_consolidator ladder. # of distinct hubs bridging the pair.
  const cc = c.co_cons_count ?? 0;
  if (cc >= 1) p = Math.max(p, 0.80);
  if (cc >= 2) p = Math.max(p, 0.95);
  if (cc >= 3) p = Math.max(p, 0.98);
  if (cc >= 5) p = Math.max(p, 0.99);

  // co_parent ladder. # of distinct non-MSR parents distributing to both.
  const cp = c.co_parent_count ?? 0;
  if (cp >= 1) p = Math.max(p, 0.80);
  if (cp >= 2) p = Math.max(p, 0.95);
  if (cp >= 3) p = Math.max(p, 0.98);

  // pmx ladder. One-way pmx is moderate (could be one-off OTC trade);
  // bidirectional pmx is strong. For the 0.99 identity-fold tier, we
  // use the round-trip subset as the discriminator: pmx_rt counts the
  // events where the receiver previously owned the inscription —
  // empirically ~47% for legitimate consolidation vs ~10% for cross-
  // traders. pmx_bidir ≥ 2 alone caps at 0.95 (B1 rule); reaching 0.99
  // requires either pmx_rt_count ≥ 2 (round-trip-confirmed) OR an
  // anchoring signal from another mechanism (handled by the indep
  // bonus below).
  const pmxAb = c.pmx_ab ?? 0;
  const pmxBa = c.pmx_ba ?? 0;
  const pmxBidir = Math.min(pmxAb, pmxBa);
  const pmxTotal = c.pmx_count ?? (pmxAb + pmxBa);
  const pmxRt = c.pmx_rt_count ?? 0;
  if (pmxTotal >= 1) p = Math.max(p, 0.75);
  if (pmxTotal >= 3) p = Math.max(p, 0.90);
  if (pmxBidir >= 1) p = Math.max(p, 0.95);
  if (pmxBidir >= 2 && pmxRt >= 2) p = Math.max(p, 0.99);

  // Cross-mechanism bonus. Each of {cih, sx, cc, cp, pmx} is a distinct
  // observable; two of them firing on the same pair is independent
  // confirmation. Two → 0.97; three → 0.99.
  let indep = 0;
  if (c.cih_count >= 1) indep++;
  if (sxAb + sxBa >= 1) indep++;
  if (cc >= 1) indep++;
  if (cp >= 1) indep++;
  if (pmxTotal >= 1) indep++;
  if (indep >= 2) p = Math.max(p, 0.97);
  if (indep >= 3) p = Math.max(p, 0.99);

  // B1: pmx_bidir≥2 alone clears 0.99 ONLY when round-trip confirms
  // consolidation (pmx_rt_count ≥ 2). Without round-trip evidence and
  // without an anchoring signal from another mechanism, cap at 0.95 —
  // this is the cross-trader exclusion (ApeSoda↔goot pattern).
  const onlyPmx = (c.cih_count === 0)
    && (sxAb + sxBa === 0)
    && (cc === 0)
    && (cp === 0);
  if (onlyPmx && pmxBidir >= 2 && pmxRt < 2 && p >= 0.99) p = 0.95;

  return Math.round(p * 10000);
}

/**
 * Default public-display threshold. Aligned with IDENTITY_FOLD_THRESHOLD
 * (both 9900) — peers shown in the holder-page "likely linked" panel
 * are exactly the peers folded into the leaderboard cluster. Below
 * 9900 the heuristic mixes in too many cross-trader pairs (active P2P
 * trading partners, e.g. ApeSoda↔goot) where the on-chain shape
 * resembles consolidation but the wallets are different humans.
 *
 * History: started at 9500 (~94% precision but ~6% cross-trader FPs
 * on display) — moved to 9900 after observing the 97% tier was
 * dominated by cross-trader noise on real holder profiles. Forensics
 * surfaces (future) can pass a lower minConfidence to expose more
 * candidates.
 */
export const CLUSTER_THRESHOLD = 9900;

/**
 * Threshold at which on-chain inference is treated as identity-level —
 * peers at this level are folded into holdings aggregation and
 * leaderboards alongside Matrica-confirmed siblings, AND surfaced in
 * the holder-page "likely linked" panel (CLUSTER_THRESHOLD is the
 * same value — see history note there).
 *
 * Calibration against Matrica ground truth (May 2026): 88% precision
 * (counting known auto-shell wins as TPs) with the round-trip-aware
 * B1 backoff filtering most cross-trader noise.
 *
 * Roles remain Matrica-only by design — promoting a heuristic match to
 * a Matrica role would let an attacker game the role catalog. The fold
 * is for ownership counts, not identity attestation.
 */
export const IDENTITY_FOLD_THRESHOLD = 9900;

/** Cap on per-edge evidence items kept in evidence_json. */
export const EVIDENCE_CAP = 10;

/**
 * Maximum distinct input addresses for a tx to be CIH-eligible. Above
 * this count the tx is presumed multi-party (CoinJoin, batch
 * aggregation, marketplace bulk sweep) and CIH is suppressed wholesale.
 * Empirically: ~99.9% of OMB-touching txs have ≤5 distinct inputs;
 * the >20 tail is dominated by mass-aggregation patterns.
 */
export const MAX_INPUTS_FOR_CIH = 20;

/**
 * Multi-source receiver threshold. An address that's the new_owner of
 * `transferred` events from this many or more distinct senders qualifies
 * as an MSR — historically suppressed wholesale to keep exchange /
 * custodial endpoints out of clusters. v2 keeps the suppression for the
 * sx + CIH signals (where it's working) but re-introduces a softer
 * pmx (personal-MSR self-xfer) signal for the subset of MSRs that look
 * personal — see PERSONAL_MSR_BIDIR_MIN / PERSONAL_MSR_RETENTION_MIN.
 * ~639 OMB-related addresses meet ≥5 in our corpus.
 */
export const MULTI_SOURCE_RECEIVER_THRESHOLD = 5;

// === v2 tunables (used by runClusterRecompute) ===

/** Max distinct lifetime recipients a sender can have to qualify as
 *  "monogamous" for co-consolidator pairing. ≤2 covers the typical
 *  one-shot-then-rest pattern and the rare two-hop split. */
export const MONOG_FANOUT_MAX = 2;

/** Symmetric — max distinct lifetime senders for monog-recipient (cp). */
export const MONOG_FANIN_MAX = 2;

/** Both addresses must be monog senders feeding the same hub to fire cc. */
export const COCONS_MIN_DEGREE = 2;

/** Parent must distribute to ≥this-many monog children to fire cp. */
export const PARENT_FANOUT_MIN = 2;

/** Bidirectional flow count for an MSR to be classified personal. */
export const PERSONAL_MSR_BIDIR_MIN = 3;

/** Retention rate (held-now / received) for an MSR to be classified personal. */
export const PERSONAL_MSR_RETENTION_MIN = 0.4;

/**
 * Mint wallets — duplicated from MINT_WALLETS in src/lib/db.ts because
 * that constant lives behind `server-only`. Keep these in sync. Mint
 * txs co-input from one mint wallet to N recipients; CIH would falsely
 * link every minter together if the wallet weren't blacklisted.
 */
export const MINT_WALLET_ADDRS: readonly string[] = [
  'bc1pyl6g53k220rggaukyx929qnnxqw8vzt8xrfw88muw22pnwfvqjkqreeqpw',
  'bc1p53jarhva6eg4wggv7apndndger4y4gy9s6mf3gp0rttdzensu2nq3598ur',
  'bc1pg8jywvphzeyf9fg8tsac6jq7ft2dzz7pez720r6uanumn6lyayeshg46es',
  'bc1p4a29gzwlear4csc9sz6ll97j9yl7877tasy75evq8wm6r3admtqq3m72k0',
  'bc1q86ssqhk04chjah6kkuqw3fv5wjy7v2nflyg50t',
];

/**
 * Append an evidence item to the capped trail, preserving most-recent.
 * Caller stringifies for storage.
 */
export function appendEvidence(
  existing: readonly EvidenceItem[],
  next: EvidenceItem
): EvidenceItem[] {
  // Dedup on (type,txid) — re-running backfill must not double-count.
  const out = existing.filter(e => !(e.type === next.type && e.txid === next.txid));
  out.push(next);
  if (out.length > EVIDENCE_CAP) {
    return out.slice(out.length - EVIDENCE_CAP);
  }
  return out;
}

/**
 * Accumulator for building an edge map in memory during backfill. Keys
 * are `addr_a|addr_b` with addr_a < addr_b. Caller flushes to DB with
 * a single bulk INSERT in a transaction.
 *
 * The cc / cp counts are stored as Set<bridgeAddr> during accumulation
 * so re-running the recompute on the same data doesn't double-count
 * bridges; they're flushed to integers at write time.
 */
export type EdgeAcc = Map<
  string,
  {
    addr_a: string;
    addr_b: string;
    cih_count: number;
    self_xfer_count: number;
    self_xfer_ab: number;
    self_xfer_ba: number;
    co_cons_bridges: Set<string>;
    co_parent_bridges: Set<string>;
    pmx_count: number;
    pmx_ab: number;
    pmx_ba: number;
    pmx_rt_count: number;
    pmx_rt_ab: number;
    pmx_rt_ba: number;
    evidence: EvidenceItem[];
    first_seen_at: number;
    last_seen_at: number;
  }
>;

export function edgeKey(a: string, b: string): string {
  const [x, y] = canonicalPair(a, b);
  return `${x}|${y}`;
}

/**
 * Bump an edge with one new evidence item. Mutates the accumulator in
 * place. Same shape used by both the backfill (in-memory pass) and the
 * incremental tick (which loads existing rows from DB into the map
 * before bumping).
 */
/**
 * Bump an edge with one new evidence item. For self_xfer evidence the
 * caller must pass `from`/`to` so we can record direction in canonical-
 * pair coordinates (`ab` if from=addr_a, else `ba`). Mutates `acc`.
 */
export function bumpEdge(
  acc: EdgeAcc,
  from: string,
  to: string,
  evidence: EvidenceItem
): void {
  if (from === to) return;
  const [x, y] = canonicalPair(from, to);
  const key = `${x}|${y}`;
  const ts = evidence.ts ?? 0;
  let row = acc.get(key);
  if (!row) {
    row = {
      addr_a: x,
      addr_b: y,
      cih_count: 0,
      self_xfer_count: 0,
      self_xfer_ab: 0,
      self_xfer_ba: 0,
      co_cons_bridges: new Set(),
      co_parent_bridges: new Set(),
      pmx_count: 0,
      pmx_ab: 0,
      pmx_ba: 0,
      pmx_rt_count: 0,
      pmx_rt_ab: 0,
      pmx_rt_ba: 0,
      evidence: [],
      first_seen_at: ts,
      last_seen_at: ts,
    };
    acc.set(key, row);
  }
  // Stamp direction on directional evidence so the confidence formula
  // has it without re-fetching events. CIH is symmetric; no direction.
  let stamped: EvidenceItem = evidence;
  if ((evidence.type === 'self_xfer' || evidence.type === 'pmx') && !evidence.direction) {
    stamped = { ...evidence, direction: from === x ? 'ab' : 'ba' };
  }
  // Dedup on (type,txid) — re-running backfill must not double-count.
  const dup = row.evidence.some(
    e => e.type === stamped.type && e.txid === stamped.txid
  );
  if (!dup) {
    if (stamped.type === 'cih') {
      row.cih_count += 1;
    } else if (stamped.type === 'self_xfer') {
      row.self_xfer_count += 1;
      if (stamped.direction === 'ab') row.self_xfer_ab += 1;
      else if (stamped.direction === 'ba') row.self_xfer_ba += 1;
    } else if (stamped.type === 'pmx') {
      row.pmx_count += 1;
      if (stamped.direction === 'ab') row.pmx_ab += 1;
      else if (stamped.direction === 'ba') row.pmx_ba += 1;
      if (stamped.round_trip) {
        row.pmx_rt_count += 1;
        if (stamped.direction === 'ab') row.pmx_rt_ab += 1;
        else if (stamped.direction === 'ba') row.pmx_rt_ba += 1;
      }
    }
  }
  row.evidence = appendEvidence(row.evidence, stamped);
  if (ts) {
    if (!row.first_seen_at || ts < row.first_seen_at) row.first_seen_at = ts;
    if (ts > row.last_seen_at) row.last_seen_at = ts;
  }
}

/**
 * Display-time predicate used by the holder-page "likely linked"
 * surface. Hides edges that match the cross-trader pattern: both
 * endpoints are themselves multi-source receivers AND the only signal
 * pushing them above threshold is non-round-trip pmx (i.e. they
 * actively trade with each other but no inscription has ever returned
 * to its origin). Examples from calibration: ApeSoda↔goot, JJL↔dor1tolover.
 *
 * Suppression is applied ONLY at the display reader — the underlying
 * confidence and the identity-fold cluster_anchors are unaffected.
 * Caller passes a Set of MSR addresses (from cluster_blacklist where
 * reason='auto-high-degree') so this stays framework-free.
 */
export function isCrossTraderEdge(
  e: {
    addr_a: string;
    addr_b: string;
    cih_count: number;
    self_xfer_count: number;
    co_cons_count?: number;
    co_parent_count?: number;
    pmx_count?: number;
    pmx_rt_count?: number;
  },
  msrSet: ReadonlySet<string>
): boolean {
  if (!msrSet.has(e.addr_a) || !msrSet.has(e.addr_b)) return false;
  if ((e.pmx_rt_count ?? 0) > 0) return false; // any round-trip = consolidation
  if (e.cih_count > 0) return false;            // CIH anchor → keep
  if (e.self_xfer_count > 0) return false;      // sx anchor → keep
  if ((e.co_parent_count ?? 0) > 0) return false; // cp anchor → keep
  // Both endpoints MSRs, no anchoring signal, pmx never round-tripped:
  // matches the ApeSoda↔goot trading-pair shape.
  return true;
}

/**
 * Directional sibling of isCrossTraderEdge for the listing-staging fold.
 *
 * True when the ONLY signal on an edge is one-directional, non-round-trip
 * pmx — an active trade/sale between two distinct humans, not shared
 * control. Unlike isCrossTraderEdge this does NOT require both endpoints
 * to be MSRs, because the staging pattern is asymmetric: the seller side
 * is often a normal personal wallet that simply received a purchase and
 * relisted it (e.g. goot sold OMBs to hashmaxis, who flipped them).
 *
 * Used as a fold veto: if a (source, seller) staging pair already has a
 * cluster edge of this shape, the "transfer → list within 12h" sequence
 * is a resale, not warehousing, so the pair must not fold into identity.
 */
export function isTradeShapedPmxEdge(e: {
  cih_count: number;
  self_xfer_count: number;
  co_cons_count?: number;
  co_parent_count?: number;
  pmx_count?: number;
  pmx_rt_count?: number;
}): boolean {
  if ((e.pmx_count ?? 0) === 0) return false; // no pmx → not this shape
  if ((e.pmx_rt_count ?? 0) > 0) return false; // round-trip = consolidation
  if (e.cih_count > 0) return false; // CIH anchor → genuine shared control
  if (e.self_xfer_count > 0) return false; // sx anchor → genuine shared control
  if ((e.co_cons_count ?? 0) > 0) return false; // cc anchor → keep
  if ((e.co_parent_count ?? 0) > 0) return false; // cp anchor → keep
  return true;
}

/**
 * Union-find over edges that meet the threshold — caller can use this
 * to materialize disjoint clusters from the per-edge table on demand.
 */
export class UnionFind {
  private parent = new Map<string, string>();
  private rank = new Map<string, number>();
  find(x: string): string {
    const p = this.parent.get(x);
    if (p === undefined) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
      return x;
    }
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank.get(ra) ?? 0;
    const rankB = this.rank.get(rb) ?? 0;
    if (rankA < rankB) this.parent.set(ra, rb);
    else if (rankA > rankB) this.parent.set(rb, ra);
    else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rankA + 1);
    }
  }
  /** Group all known nodes by their root. */
  groups(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    Array.from(this.parent.keys()).forEach((node) => {
      const root = this.find(node);
      let arr = out.get(root);
      if (!arr) {
        arr = [];
        out.set(root, arr);
      }
      arr.push(node);
    });
    return out;
  }
}
