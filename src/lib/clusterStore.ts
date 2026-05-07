import 'server-only';

import type { Statement } from 'better-sqlite3';
import { getDb } from './db';
import { bitcoindConfigured, getRawTransaction } from './bitcoind';
import {
  appendEvidence,
  bumpEdge,
  canonicalPair,
  collectInputAddresses,
  confidenceFromCounts,
  edgeKey,
  hasAcpInput,
  MAX_INPUTS_FOR_CIH,
  MINT_WALLET_ADDRS,
  MULTI_SOURCE_RECEIVER_THRESHOLD,
  type EdgeAcc,
  type EvidenceItem,
} from './cluster';
import { log } from './log';

const STREAM = 'cluster';
const COLLECTION = 'omb';

// Per-tick budget: events to walk for CIH (we fetch a raw tx per event).
// Sized to keep wallclock under 30s at prod RPC latency. The cluster mode
// is the LAST step in `auto`, so the global tick budget bounds us.
const PER_TICK_LIMIT = 200;
const RPC_CONCURRENCY = 8;

// Lag the cursor behind by this many seconds so satflow + loans + the
// fingerprint taggers have a chance to reclassify an event before we
// take it as CIH-eligible. A 'transferred' row that becomes 'sold' an
// hour later would otherwise leave a stale edge derived from a marketplace
// PSBT — which is exactly the kind of false-positive this delay prevents.
const SETTLEMENT_DELAY_SEC = 30 * 60;

type TickResult = {
  mode: 'cluster';
  scanned: number;
  edges_touched: number;
  cursor_advanced: boolean;
  duration_ms: number;
  skipped?: 'not-configured' | 'not-bootstrapped';
  error?: string;
};

let cached: {
  selectState: Statement;
  selectMaxId: Statement;
  selectCandidates: Statement;
  selectBlacklist: Statement;
  upsertBlacklist: Statement;
  selectMultiSourceReceivers: Statement;
  selectEdge: Statement;
  upsertEdge: Statement;
  updateState: Statement;
} | null = null;

function stmts() {
  if (cached) return cached;
  const db = getDb();
  cached = {
    selectState: db.prepare(
      `SELECT last_cursor FROM poll_state WHERE stream = ? AND collection_slug = ?`
    ),
    selectMaxId: db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM events`),
    // CIH-eligible types only — sold + loan-* are PSBT-multiplexed and
    // excluded by design. created_at gate gives reclassifiers a window.
    selectCandidates: db.prepare(
      `SELECT id, txid, event_type, old_owner, new_owner, marketplace, block_timestamp
         FROM events
        WHERE id > @cursor
          AND id <= @upper
          AND event_type IN ('transferred','inscribed','mint')
          AND created_at < unixepoch() - @delay
        ORDER BY id ASC
        LIMIT @lim`
    ),
    selectBlacklist: db.prepare(`SELECT address FROM cluster_blacklist`),
    upsertBlacklist: db.prepare(
      `INSERT OR IGNORE INTO cluster_blacklist (address, reason, degree, added_at, notes)
       VALUES (?, 'mint', NULL, unixepoch(), ?)`
    ),
    // Recompute multi-source receivers each tick — cheap (groups by
    // new_owner over `transferred` rows, indexed) and lets new exchange
    // / custodian endpoints get caught without a separate backfill.
    selectMultiSourceReceivers: db.prepare(
      `SELECT new_owner
         FROM events
        WHERE event_type = 'transferred' AND marketplace IS NULL
          AND old_owner IS NOT NULL AND new_owner IS NOT NULL
          AND old_owner != new_owner
        GROUP BY new_owner
       HAVING COUNT(DISTINCT old_owner) >= @t`
    ),
    selectEdge: db.prepare(
      `SELECT cih_count, self_xfer_count, self_xfer_ab, self_xfer_ba,
              evidence_json, first_seen_at, last_seen_at
         FROM wallet_cluster_edges WHERE addr_a = ? AND addr_b = ?`
    ),
    upsertEdge: db.prepare(
      `INSERT INTO wallet_cluster_edges
         (addr_a, addr_b, confidence, cih_count, self_xfer_count,
          self_xfer_ab, self_xfer_ba, evidence_json, first_seen_at, last_seen_at)
       VALUES (@addr_a, @addr_b, @confidence, @cih_count, @self_xfer_count,
               @self_xfer_ab, @self_xfer_ba, @evidence_json, @first_seen_at, @last_seen_at)
       ON CONFLICT(addr_a, addr_b) DO UPDATE SET
         confidence      = excluded.confidence,
         cih_count       = excluded.cih_count,
         self_xfer_count = excluded.self_xfer_count,
         self_xfer_ab    = excluded.self_xfer_ab,
         self_xfer_ba    = excluded.self_xfer_ba,
         evidence_json   = excluded.evidence_json,
         first_seen_at   = MIN(wallet_cluster_edges.first_seen_at, excluded.first_seen_at),
         last_seen_at    = MAX(wallet_cluster_edges.last_seen_at, excluded.last_seen_at)`
    ),
    updateState: db.prepare(
      `UPDATE poll_state
          SET last_cursor = @c, last_run_at = unixepoch(),
              last_status = @status, last_event_count = @count
        WHERE stream = @s AND collection_slug = @col`
    ),
  };
  return cached;
}

function loadBlacklist(): Set<string> {
  const s = stmts();
  const out = new Set<string>(MINT_WALLET_ADDRS);
  for (const r of s.selectBlacklist.all() as Array<{ address: string }>) {
    out.add(r.address);
  }
  return out;
}

function loadMultiSourceReceivers(): Set<string> {
  const s = stmts();
  const out = new Set<string>();
  for (const r of s.selectMultiSourceReceivers.all({
    t: MULTI_SOURCE_RECEIVER_THRESHOLD,
  }) as Array<{ new_owner: string }>) {
    out.add(r.new_owner);
  }
  return out;
}

function seedMintBlacklist(): void {
  const s = stmts();
  const db = getDb();
  db.transaction(() => {
    for (const a of MINT_WALLET_ADDRS) {
      s.upsertBlacklist.run(a, 'mint distribution wallet');
    }
  })();
}

/**
 * Live wallet-clustering tick. Walks recent CIH-eligible events past the
 * cursor, fetches raw txs, and bumps `wallet_cluster_edges` with new CIH
 * + self-transfer-chain evidence. Idempotent on re-run within a tick
 * (evidence is deduped by (type, txid) so the upsert is a no-op).
 *
 * Cursor bootstrap: if `last_cursor` is NULL we set it to MAX(events.id)
 * and exit — operators must run scripts/backfill-cluster.js for
 * historical coverage. The warn log is the operator-facing nudge.
 */
export async function runClusterTick(): Promise<TickResult> {
  const startedAt = Date.now();
  const result: TickResult = {
    mode: 'cluster',
    scanned: 0,
    edges_touched: 0,
    cursor_advanced: false,
    duration_ms: 0,
  };

  if (!bitcoindConfigured()) {
    return { ...result, skipped: 'not-configured', duration_ms: Date.now() - startedAt };
  }

  const s = stmts();
  const db = getDb();

  seedMintBlacklist();

  const stateRow = s.selectState.get(STREAM, COLLECTION) as
    | { last_cursor: string | null }
    | undefined;
  if (!stateRow) {
    return {
      ...result,
      error: 'poll-state-row-missing',
      duration_ms: Date.now() - startedAt,
    };
  }

  let cursor: number;
  if (stateRow.last_cursor == null) {
    const max = s.selectMaxId.get() as { m: number };
    cursor = Math.max(0, max.m);
    s.updateState.run({
      c: String(cursor),
      status: 'bootstrapped',
      count: 0,
      s: STREAM,
      col: COLLECTION,
    });
    log.warn('poll/cluster', 'cursor bootstrapped — historical sweep REQUIRED', {
      cursor,
      action: 'run scripts/backfill-cluster.js once on this DB',
    });
    return {
      ...result,
      skipped: 'not-bootstrapped',
      cursor_advanced: true,
      duration_ms: Date.now() - startedAt,
    };
  }
  cursor = parseInt(stateRow.last_cursor, 10);
  if (!Number.isFinite(cursor)) cursor = 0;

  // Upper bound: tip minus a safety margin (we DON'T process events newer
  // than NOW - SETTLEMENT_DELAY because reclassifiers might still touch
  // them). The created_at gate inside the SELECT already enforces this for
  // each row; the upper id bound is for cursor advancement so we don't
  // skip past unsettled rows.
  const max = s.selectMaxId.get() as { m: number };
  const upper = max.m;

  const candidates = s.selectCandidates.all({
    cursor,
    upper,
    delay: SETTLEMENT_DELAY_SEC,
    lim: PER_TICK_LIMIT,
  }) as Array<{
    id: number;
    txid: string;
    event_type: string;
    old_owner: string | null;
    new_owner: string | null;
    marketplace: string | null;
    block_timestamp: number;
  }>;

  if (candidates.length === 0) {
    // Advance cursor up to upper (settled tip) so we don't re-scan the
    // same range, but only past rows that have actually settled. We use
    // a separate query that finds the highest id meeting the
    // created_at gate to avoid jumping past unsettled rows.
    const advanced = db
      .prepare(
        `SELECT COALESCE(MAX(id), @cursor) AS m
           FROM events
          WHERE id > @cursor AND created_at < unixepoch() - @delay`
      )
      .get({ cursor, delay: SETTLEMENT_DELAY_SEC }) as { m: number };
    if (advanced.m > cursor) {
      s.updateState.run({
        c: String(advanced.m),
        status: 'idle',
        count: 0,
        s: STREAM,
        col: COLLECTION,
      });
      result.cursor_advanced = true;
    }
    result.duration_ms = Date.now() - startedAt;
    return result;
  }

  result.scanned = candidates.length;
  const blacklist = loadBlacklist();
  const multiSource = loadMultiSourceReceivers();

  // Fetch raw txs in parallel; bounded concurrency. We need vin prevout
  // addresses + first witness element (for SIGHASH detection). The cache
  // entries record the gating decision per txid so the edge-build loop
  // doesn't re-scan inputs.
  type TxGated = {
    addrs: string[];
    /** Reason this tx is suppressed for CIH+self_xfer; null = eligible. */
    suppress:
      | null
      | 'rpc-fail'
      | 'blacklisted-input'
      | 'acp-settlement'
      | 'high-fanin';
  };
  const inputsByTxid = new Map<string, TxGated>();
  let rpcFailures = 0;
  let next = 0;
  async function worker(): Promise<void> {
    while (next < candidates.length) {
      const idx = next++;
      const c = candidates[idx];
      if (inputsByTxid.has(c.txid)) continue;
      try {
        const tx = await getRawTransaction(c.txid);
        const txLike = {
          txid: tx.txid,
          vin: tx.vin.map(v => ({
            prevout: v.prevout
              ? { scriptPubKey: { address: v.prevout.scriptPubKey?.address } }
              : undefined,
            txinwitness:
              Array.isArray(v.txinwitness) && v.txinwitness.length > 0
                ? [v.txinwitness[0]]
                : undefined,
          })),
        };
        const addrs = collectInputAddresses(txLike);
        let suppress: TxGated['suppress'] = null;
        if (hasAcpInput(txLike)) suppress = 'acp-settlement';
        else if (addrs.some(a => blacklist.has(a))) suppress = 'blacklisted-input';
        else if (addrs.length > MAX_INPUTS_FOR_CIH) suppress = 'high-fanin';
        inputsByTxid.set(c.txid, { addrs, suppress });
      } catch (err) {
        rpcFailures++;
        log.warn('poll/cluster', 'rpc fail', {
          txid: c.txid,
          error: err instanceof Error ? err.message : String(err),
        });
        inputsByTxid.set(c.txid, { addrs: [], suppress: 'rpc-fail' });
      }
    }
  }
  await Promise.all(
    Array.from({ length: RPC_CONCURRENCY }, () => worker())
  );

  // Build per-tick edge accumulator from CIH + self-xfer signals.
  const acc: EdgeAcc = new Map();
  for (const c of candidates) {
    const ts = c.block_timestamp || 0;
    const entry = inputsByTxid.get(c.txid);
    if (!entry) continue;

    // PSBT-settlement gate: a transferred event whose new_owner literally
    // appears in the spending inputs is a buyer+seller cooperative
    // settlement (rarer than ACP, but happens — older or hand-rolled
    // PSBTs). Suppress both CIH and self-xfer signals on those.
    const newOwnerInInputs =
      c.event_type === 'transferred' &&
      c.new_owner != null &&
      entry.addrs.includes(c.new_owner);
    const suppressed = entry.suppress != null || newOwnerInInputs;

    if (!suppressed && entry.addrs.length >= 2) {
      for (let i = 0; i < entry.addrs.length; i++) {
        for (let j = i + 1; j < entry.addrs.length; j++) {
          const a = entry.addrs[i];
          const b = entry.addrs[j];
          if (multiSource.has(a) || multiSource.has(b)) continue;
          bumpEdge(acc, a, b, { type: 'cih', txid: c.txid, ts });
        }
      }
    }

    if (
      !suppressed &&
      c.event_type === 'transferred' &&
      c.marketplace == null &&
      c.old_owner &&
      c.new_owner &&
      c.old_owner !== c.new_owner &&
      !blacklist.has(c.old_owner) &&
      !blacklist.has(c.new_owner) &&
      !multiSource.has(c.old_owner) &&
      !multiSource.has(c.new_owner)
    ) {
      bumpEdge(acc, c.old_owner, c.new_owner, {
        type: 'self_xfer',
        txid: c.txid,
        ts,
      });
    }
  }

  // Persist: for each edge in the accumulator, merge into the existing DB
  // row (if any) and upsert. One transaction for the whole batch.
  let touched = 0;
  const tx = db.transaction(() => {
    Array.from(acc.values()).forEach(row => {
      const existing = s.selectEdge.get(row.addr_a, row.addr_b) as
        | {
            cih_count: number;
            self_xfer_count: number;
            self_xfer_ab: number;
            self_xfer_ba: number;
            evidence_json: string;
            first_seen_at: number;
            last_seen_at: number;
          }
        | undefined;
      let cih = row.cih_count;
      let self = row.self_xfer_count;
      let selfAb = row.self_xfer_ab;
      let selfBa = row.self_xfer_ba;
      let evidence: EvidenceItem[] = [];
      let firstSeen = row.first_seen_at;
      let lastSeen = row.last_seen_at;
      if (existing) {
        cih = existing.cih_count;
        self = existing.self_xfer_count;
        selfAb = existing.self_xfer_ab;
        selfBa = existing.self_xfer_ba;
        firstSeen = Math.min(existing.first_seen_at || firstSeen, firstSeen);
        lastSeen = Math.max(existing.last_seen_at || 0, lastSeen);
        try {
          const parsed = JSON.parse(existing.evidence_json);
          if (Array.isArray(parsed)) evidence = parsed as EvidenceItem[];
        } catch {
          /* corrupt JSON — start fresh */
        }
        // Apply each new evidence item with dedup-aware bumping.
        for (const e of row.evidence) {
          const dup = evidence.some(x => x.type === e.type && x.txid === e.txid);
          if (!dup) {
            if (e.type === 'cih') {
              cih += 1;
            } else {
              self += 1;
              if (e.direction === 'ab') selfAb += 1;
              else if (e.direction === 'ba') selfBa += 1;
            }
          }
          evidence = appendEvidence(evidence, e);
        }
      } else {
        evidence = row.evidence;
      }
      s.upsertEdge.run({
        addr_a: row.addr_a,
        addr_b: row.addr_b,
        confidence: confidenceFromCounts({
          cih_count: cih,
          self_xfer_count: self,
          self_xfer_ab: selfAb,
          self_xfer_ba: selfBa,
        }),
        cih_count: cih,
        self_xfer_count: self,
        self_xfer_ab: selfAb,
        self_xfer_ba: selfBa,
        evidence_json: JSON.stringify(evidence),
        first_seen_at: firstSeen || 0,
        last_seen_at: lastSeen || 0,
      });
      touched += 1;
    });
  });
  tx();
  result.edges_touched = touched;

  // Advance cursor to the highest candidate id processed.
  const newCursor = candidates[candidates.length - 1].id;
  s.updateState.run({
    c: String(newCursor),
    status: rpcFailures > 0 ? `partial-rpc-failures=${rpcFailures}` : 'ok',
    count: touched,
    s: STREAM,
    col: COLLECTION,
  });
  result.cursor_advanced = true;
  result.duration_ms = Date.now() - startedAt;
  return result;
}

// ---------------- Readers (UI surface) ----------------

export type ClusterEdgeRow = {
  addr_a: string;
  addr_b: string;
  confidence: number;
  cih_count: number;
  self_xfer_count: number;
  evidence: EvidenceItem[];
  first_seen_at: number;
  last_seen_at: number;
};

/**
 * Returns inferred-link rows where `addr` is one of the two endpoints,
 * with confidence ≥ minConfidence (default = CLUSTER_THRESHOLD). The
 * caller's wallet appears as either addr_a or addr_b — we normalize so
 * `peer` is always the OTHER wallet.
 */
export function getInferredLinksForAddress(
  addr: string,
  minConfidence: number,
  limit = 50
): Array<{
  peer: string;
  confidence: number;
  cih_count: number;
  self_xfer_count: number;
  evidence: EvidenceItem[];
  last_seen_at: number;
}> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT addr_a, addr_b, confidence, cih_count, self_xfer_count, evidence_json, last_seen_at
         FROM wallet_cluster_edges
        WHERE (addr_a = @addr OR addr_b = @addr)
          AND confidence >= @min
        ORDER BY confidence DESC, last_seen_at DESC
        LIMIT @lim`
    )
    .all({ addr, min: minConfidence, lim: limit }) as Array<{
    addr_a: string;
    addr_b: string;
    confidence: number;
    cih_count: number;
    self_xfer_count: number;
    evidence_json: string;
    last_seen_at: number;
  }>;
  return rows.map(r => {
    let evidence: EvidenceItem[] = [];
    try {
      const parsed = JSON.parse(r.evidence_json);
      if (Array.isArray(parsed)) evidence = parsed as EvidenceItem[];
    } catch {
      /* ignore */
    }
    return {
      peer: r.addr_a === addr ? r.addr_b : r.addr_a,
      confidence: r.confidence,
      cih_count: r.cih_count,
      self_xfer_count: r.self_xfer_count,
      evidence,
      last_seen_at: r.last_seen_at,
    };
  });
}

/**
 * Materialize the cluster (transitive closure) containing `addr` at the
 * given threshold. BFS over edges; bounded `maxNodes` to prevent
 * runaway when a misbehaving heuristic produces a giant blob.
 */
export function getClusterForAddress(
  addr: string,
  minConfidence: number,
  maxNodes = 200
): { members: string[]; edges: number } {
  const db = getDb();
  const selectNeighbors = db.prepare(
    `SELECT addr_a, addr_b
       FROM wallet_cluster_edges
      WHERE confidence >= @min
        AND (addr_a = @addr OR addr_b = @addr)`
  );
  const visited = new Set<string>([addr]);
  const queue: string[] = [addr];
  let edges = 0;
  while (queue.length > 0 && visited.size < maxNodes) {
    const current = queue.shift() as string;
    const rows = selectNeighbors.all({ addr: current, min: minConfidence }) as Array<{
      addr_a: string;
      addr_b: string;
    }>;
    edges += rows.length;
    for (const r of rows) {
      const peer = r.addr_a === current ? r.addr_b : r.addr_a;
      if (!visited.has(peer)) {
        visited.add(peer);
        queue.push(peer);
      }
    }
  }
  return { members: Array.from(visited), edges };
}

/** Used by the canonical-pair helper from outside. */
export { canonicalPair, edgeKey };

export type LikelyLinkedRow = {
  /** The peer wallet (always different from any of the input wallets). */
  peer: string;
  confidence: number;
  cih_count: number;
  self_xfer_count: number;
  evidence: EvidenceItem[];
  last_seen_at: number;
  /** Matrica display info for this peer wallet, if linked. */
  matrica: { user_id: string; username: string | null; avatar_url: string | null } | null;
};

/**
 * Holder-profile helper: aggregate inferred links across a set of
 * Matrica-grouped wallets, exclude peers already in that set, fold each
 * peer's max confidence + summed counts, and join Matrica display info.
 *
 * The exclusion is the important bit — Matrica-confirmed siblings are
 * displayed elsewhere in the profile; this section is for ON-CHAIN-ONLY
 * candidates, never duplicating wallets the user already trusts.
 */
export function getLikelyLinkedForWallets(
  wallets: readonly string[],
  minConfidence: number = 9900,
  limit = 50
): LikelyLinkedRow[] {
  if (wallets.length === 0) return [];
  const db = getDb();
  const owned = new Set(wallets);

  // Per-peer aggregate. Walk each input wallet's edges, fold by peer.
  const byPeer = new Map<
    string,
    {
      confidence: number;
      cih_count: number;
      self_xfer_count: number;
      evidence: EvidenceItem[];
      last_seen_at: number;
    }
  >();

  const select = db.prepare(
    `SELECT addr_a, addr_b, confidence, cih_count, self_xfer_count, evidence_json, last_seen_at
       FROM wallet_cluster_edges
      WHERE (addr_a = @addr OR addr_b = @addr)
        AND confidence >= @min
      ORDER BY confidence DESC, last_seen_at DESC
      LIMIT 200`
  );

  for (const w of wallets) {
    const rows = select.all({ addr: w, min: minConfidence }) as Array<{
      addr_a: string;
      addr_b: string;
      confidence: number;
      cih_count: number;
      self_xfer_count: number;
      evidence_json: string;
      last_seen_at: number;
    }>;
    for (const r of rows) {
      const peer = r.addr_a === w ? r.addr_b : r.addr_a;
      if (owned.has(peer)) continue;
      let evidence: EvidenceItem[] = [];
      try {
        const parsed = JSON.parse(r.evidence_json);
        if (Array.isArray(parsed)) evidence = parsed as EvidenceItem[];
      } catch {
        /* ignore */
      }
      const existing = byPeer.get(peer);
      if (!existing) {
        byPeer.set(peer, {
          confidence: r.confidence,
          cih_count: r.cih_count,
          self_xfer_count: r.self_xfer_count,
          evidence,
          last_seen_at: r.last_seen_at,
        });
      } else {
        existing.confidence = Math.max(existing.confidence, r.confidence);
        existing.cih_count += r.cih_count;
        existing.self_xfer_count += r.self_xfer_count;
        existing.last_seen_at = Math.max(existing.last_seen_at, r.last_seen_at);
        // Append evidence items, capped — preserve most recent across folds.
        for (const e of evidence) {
          const dup = existing.evidence.some(
            x => x.type === e.type && x.txid === e.txid
          );
          if (!dup) existing.evidence.push(e);
        }
        if (existing.evidence.length > 10) {
          existing.evidence.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
          existing.evidence = existing.evidence.slice(0, 10);
        }
      }
    }
  }

  if (byPeer.size === 0) return [];

  // Join Matrica info for each peer in one statement.
  const peers = Array.from(byPeer.keys());
  const placeholders = peers.map(() => '?').join(',');
  const matricaByAddr = new Map<
    string,
    { user_id: string; username: string | null; avatar_url: string | null }
  >();
  if (peers.length > 0) {
    const rows = db
      .prepare(
        `SELECT wl.wallet_addr AS addr, mu.user_id AS user_id, mu.username AS username, mu.avatar_url AS avatar_url
           FROM wallet_links wl
           LEFT JOIN matrica_users mu ON mu.user_id = wl.matrica_user_id
          WHERE wl.matrica_user_id IS NOT NULL
            AND wl.wallet_addr IN (${placeholders})`
      )
      .all(...peers) as Array<{
      addr: string;
      user_id: string;
      username: string | null;
      avatar_url: string | null;
    }>;
    for (const r of rows) {
      matricaByAddr.set(r.addr, {
        user_id: r.user_id,
        username: r.username,
        avatar_url: r.avatar_url,
      });
    }
  }

  const out: LikelyLinkedRow[] = [];
  Array.from(byPeer.entries()).forEach(([peer, agg]) => {
    out.push({
      peer,
      confidence: agg.confidence,
      cih_count: agg.cih_count,
      self_xfer_count: agg.self_xfer_count,
      evidence: agg.evidence,
      last_seen_at: agg.last_seen_at,
      matrica: matricaByAddr.get(peer) ?? null,
    });
  });
  out.sort((a, b) => b.confidence - a.confidence || b.last_seen_at - a.last_seen_at);
  return out.slice(0, limit);
}
