// On-chain wallet clustering — pure heuristics, framework-free.
//
// Imported from both the runtime poll tick (via clusterStore.ts) and the
// host-side backfill scripts. Keep this file free of `server-only` and DB
// imports so node CLI scripts can use it directly.
//
// v1 covers two heuristics:
//
//   1. Common-input ownership (CIH). Multiple non-blacklisted addresses
//      co-spent in one tx are presumed same-owner. Excluded:
//
//        - Inputs whose address is on the blacklist (mint wallets, auto-
//          detected high-degree multiplexers, manual operator entries).
//        - Whole txs that are marketplace settlements (event_type='sold')
//          or Liquidium loan moves (event_type='loan-*'), because those
//          PSBTs splice unrelated buyer/seller (or borrower/Liquidium)
//          inputs into one tx. Caller filters by event_type before
//          handing txids in here — see clusterStore.ts.
//
//   2. Self-transfer chain. A `transferred` event with old_owner !=
//      new_owner, no marketplace tag, no loan classification, is the
//      classic OMB-postage move ("I'm consolidating my collection from
//      cold to hot"). The new_owner doesn't have to co-sign on chain so
//      this catches pairs that CIH wouldn't.
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
  type: 'cih' | 'self_xfer';
  txid: string;
  /** Block timestamp (seconds), if known — only used for display ordering. */
  ts?: number;
  /**
   * For self_xfer evidence: which direction the OMB moved (in canonical
   * pair order, where addr_a < addr_b). 'ab' = old_owner=addr_a, new_owner=addr_b.
   * Omitted for cih evidence (CIH is symmetric).
   */
  direction?: 'ab' | 'ba';
};

export type EdgeCounts = {
  cih_count: number;
  /** Total self-xfer count = self_xfer_ab + self_xfer_ba. Kept for back-compat. */
  self_xfer_count: number;
  /** Direction-split self-xfers (canonical-pair order, addr_a < addr_b). */
  self_xfer_ab?: number;
  self_xfer_ba?: number;
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
 * Direction-aware: a `self_xfer` count of 22, all one-way (A keeps
 * sending to B, B never reciprocates), is far weaker than 11+11
 * bidirectional. The former matches custodial / exchange / aggregator
 * deposit patterns where two distinct humans are involved; the latter
 * matches a hot/cold rebalance pattern between one human's wallets.
 * Heuristic: gate the highest self-xfer tier on `min(ab, ba) >= 1`
 * (i.e. at least one event in EACH direction). One-way flow alone
 * tops out at 0.80 — meaningful but never publicly surfaced without
 * additional CIH evidence.
 *
 * CIH ladder is unchanged from the prior calibration: 1 CIH = 0.80,
 * 5 CIH = 0.99. Mixed signals (CIH + bidirectional self-xfer) hit
 * 0.99 immediately — different mechanisms agreeing.
 *
 * Counts are stored separately from the derived score so threshold
 * tweaks don't require recomputing edges. Run `?mode=cluster`
 * with `--reset` (via the backfill script) to re-derive `confidence`
 * after a ladder change.
 */
export function confidenceFromCounts(c: EdgeCounts): number {
  let p = 0;
  if (c.cih_count >= 1) p = Math.max(p, 0.8);
  if (c.cih_count >= 2) p = Math.max(p, 0.95);
  if (c.cih_count >= 3) p = Math.max(p, 0.98);
  if (c.cih_count >= 5) p = Math.max(p, 0.99);

  const ab = c.self_xfer_ab ?? 0;
  const ba = c.self_xfer_ba ?? 0;
  const bidir = Math.min(ab, ba);
  const total = c.self_xfer_count > 0 ? c.self_xfer_count : ab + ba;

  // Bidirectional self-xfer flow — strong same-person signal.
  if (bidir >= 1) p = Math.max(p, 0.92);
  if (bidir >= 2) p = Math.max(p, 0.99);

  // Total volume — weaker by itself; one-way could be a deposit channel.
  if (total >= 1) p = Math.max(p, 0.5);
  if (total >= 3) p = Math.max(p, 0.8);
  // No higher tier from one-way alone — needs bidir or CIH to confirm.

  // Mixed signals.
  if (c.cih_count >= 1 && bidir >= 1) p = Math.max(p, 0.99);
  if (c.cih_count >= 1 && total >= 1) p = Math.max(p, 0.95);
  if (c.cih_count >= 2 && total >= 2) p = Math.max(p, 0.99);

  return Math.round(p * 10000);
}

/**
 * Default public-display threshold. 9500 = 0.95. After the auto-shell
 * reclassification + direction-aware ladder, real precision against
 * claimed-Matrica-vs-claimed-Matrica pairs is ~89% at this band
 * (1 real FP / 9 known) and ~82% at 9000. The bulk of pairs at 9500
 * have 2+ distinct CIH txs between them — strong on-chain evidence
 * Matrica simply doesn't have data for. Forensics surfaces (future
 * route) can pass a lower minConfidence to expose more.
 */
export const CLUSTER_THRESHOLD = 9500;

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
 * `transferred` events from this many or more distinct senders is
 * almost certainly an exchange / custodial / market-aggregator
 * endpoint, not a peer in any human cluster. Both CIH and self-xfer
 * signals involving such an address are suppressed. ~639 OMB-related
 * addresses meet ≥5 in our corpus; legitimate collectors top out
 * around 1-2 distinct senders per receiver.
 */
export const MULTI_SOURCE_RECEIVER_THRESHOLD = 5;

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
      evidence: [],
      first_seen_at: ts,
      last_seen_at: ts,
    };
    acc.set(key, row);
  }
  // Stamp direction on self_xfer evidence so the confidence formula has
  // it without re-fetching events. CIH is symmetric; no direction.
  let stamped: EvidenceItem = evidence;
  if (evidence.type === 'self_xfer' && !evidence.direction) {
    stamped = { ...evidence, direction: from === x ? 'ab' : 'ba' };
  }
  // Dedup on (type,txid) — re-running backfill must not double-count.
  const dup = row.evidence.some(
    e => e.type === stamped.type && e.txid === stamped.txid
  );
  if (!dup) {
    if (stamped.type === 'cih') {
      row.cih_count += 1;
    } else {
      row.self_xfer_count += 1;
      if (stamped.direction === 'ab') row.self_xfer_ab += 1;
      else if (stamped.direction === 'ba') row.self_xfer_ba += 1;
    }
  }
  row.evidence = appendEvidence(row.evidence, stamped);
  if (ts) {
    if (!row.first_seen_at || ts < row.first_seen_at) row.first_seen_at = ts;
    if (ts > row.last_seen_at) row.last_seen_at = ts;
  }
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
