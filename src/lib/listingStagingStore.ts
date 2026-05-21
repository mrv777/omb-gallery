import 'server-only';

import { getDb } from './db';
import { recomputeClusterAnchors } from './clusterStore';
import { log } from './log';
import { EXCLUDED_OWNERS } from './walletLabels';

const STREAM = 'listing_staging';
const COLLECTION = 'omb';
const FAST_WINDOW_SEC = 12 * 60 * 60;
const EVIDENCE_CAP = 10;

type TriggerType = 'active_listing' | 'listed_event' | 'sold_event';
type TriggerGroup = 'listing' | 'sale';
type ValidationKind = 'same_real_profile' | 'different_real_profile' | 'auto_shell' | 'unknown';
type SuppressionReason =
  | 'blacklisted_endpoint'
  | 'different_real_profile'
  | 'already_known_same'
  | 'insufficient_repeated_12h';

type TriggerRow = {
  trigger_type: TriggerType;
  inscription_number: number;
  seller: string | null;
  trigger_ts: number;
  trigger_event_id: number | null;
  trigger_ref: string | null;
  trigger_marketplace: string | null;
  trigger_price_sats: number | null;
  prev_event_id: number;
  prev_event_type: string;
  prev_marketplace: string | null;
  source: string | null;
  prev_new_owner: string | null;
  prev_ts: number;
  prev_txid: string;
};

export type ListingStagingEvidenceItem = {
  trigger_type: TriggerType;
  trigger_group: TriggerGroup;
  inscription_number: number;
  trigger_ts: number;
  trigger_event_id: number | null;
  trigger_ref: string | null;
  trigger_marketplace: string | null;
  trigger_price_sats: number | null;
  prev_event_id: number;
  prev_txid: string;
  prev_ts: number;
  gap_sec: number;
};

type CandidateEvidence = ListingStagingEvidenceItem & {
  source: string;
  seller: string;
};

type Profile = {
  user_id: string;
  username: string | null;
  avatar_url: string | null;
  is_auto_shell: boolean;
};

type PairAcc = {
  source: string;
  seller: string;
  evidence: CandidateEvidence[];
};

type StagingEdgeWrite = {
  source_wallet: string;
  seller_wallet: string;
  eligible_for_fold: number;
  suppression_reason: SuppressionReason | null;
  evidence_count: number;
  distinct_inscriptions: number;
  fast_12h_evidence_count: number;
  fast_12h_distinct_inscriptions: number;
  active_listing_count: number;
  listed_event_count: number;
  sold_count: number;
  listing_count: number;
  sale_count: number;
  min_gap_sec: number;
  median_gap_sec: number;
  max_gap_sec: number;
  fast_12h_median_gap_sec: number | null;
  validation_kind: ValidationKind;
  existing_cluster_confidence: number | null;
  evidence_json: string;
  first_seen_at: number;
  last_seen_at: number;
};

export type ListingStagingRecomputeResult = {
  mode: 'listing-staging-recompute';
  evidence_rows: number;
  pairs_written: number;
  eligible_edges: number;
  suppressed_blacklist: number;
  suppressed_conflicts: number;
  suppressed_known_same: number;
  suppressed_insufficient: number;
  anchors: {
    components: number;
    members: number;
    skipped_split_clusters: number;
  };
  duration_ms: number;
  skipped?: 'concurrent';
  error?: string;
};

export type ListingStagingLinkRow = {
  source_wallet: string;
  seller_wallet: string;
  evidence_count: number;
  distinct_inscriptions: number;
  fast_12h_evidence_count: number;
  fast_12h_distinct_inscriptions: number;
  listing_count: number;
  sale_count: number;
  active_listing_count: number;
  listed_event_count: number;
  sold_count: number;
  min_gap_sec: number;
  median_gap_sec: number;
  max_gap_sec: number;
  fast_12h_median_gap_sec: number | null;
  validation_kind: ValidationKind;
  existing_cluster_confidence: number | null;
  evidence: ListingStagingEvidenceItem[];
  first_seen_at: number;
  last_seen_at: number;
  source_matrica: { user_id: string; username: string | null; avatar_url: string | null } | null;
  seller_matrica: { user_id: string; username: string | null; avatar_url: string | null } | null;
};

export function runListingStagingRecompute(): ListingStagingRecomputeResult {
  const startedAt = Date.now();
  const db = getDb();
  const base: ListingStagingRecomputeResult = {
    mode: 'listing-staging-recompute',
    evidence_rows: 0,
    pairs_written: 0,
    eligible_edges: 0,
    suppressed_blacklist: 0,
    suppressed_conflicts: 0,
    suppressed_known_same: 0,
    suppressed_insufficient: 0,
    anchors: { components: 0, members: 0, skipped_split_clusters: 0 },
    duration_ms: 0,
  };

  const lock = db
    .prepare(
      `UPDATE poll_state
          SET last_run_at = unixepoch()
        WHERE stream = ? AND collection_slug = ?
          AND (last_run_at IS NULL OR last_run_at < unixepoch() - 120)`
    )
    .run(STREAM, COLLECTION);
  if (lock.changes === 0) {
    return { ...base, skipped: 'concurrent', duration_ms: Date.now() - startedAt };
  }

  try {
    const profiles = loadProfiles();
    const cluster = loadClusterConfidence();
    const blacklisted = loadSuppressedWallets();
    const evidence = scanEvidence();
    const rows = buildRows(evidence, { profiles, cluster, blacklisted });

    const insert = db.prepare(`
      INSERT INTO wallet_staging_edges (
        source_wallet, seller_wallet, eligible_for_fold, suppression_reason,
        evidence_count, distinct_inscriptions,
        fast_12h_evidence_count, fast_12h_distinct_inscriptions,
        active_listing_count, listed_event_count, sold_count,
        listing_count, sale_count,
        min_gap_sec, median_gap_sec, max_gap_sec, fast_12h_median_gap_sec,
        validation_kind, existing_cluster_confidence,
        evidence_json, first_seen_at, last_seen_at, computed_at
      ) VALUES (
        @source_wallet, @seller_wallet, @eligible_for_fold, @suppression_reason,
        @evidence_count, @distinct_inscriptions,
        @fast_12h_evidence_count, @fast_12h_distinct_inscriptions,
        @active_listing_count, @listed_event_count, @sold_count,
        @listing_count, @sale_count,
        @min_gap_sec, @median_gap_sec, @max_gap_sec, @fast_12h_median_gap_sec,
        @validation_kind, @existing_cluster_confidence,
        @evidence_json, @first_seen_at, @last_seen_at, unixepoch()
      )
    `);

    db.transaction(() => {
      db.exec(`DELETE FROM wallet_staging_edges`);
      for (const row of rows) insert.run(row);
    })();

    const anchors = recomputeClusterAnchors();

    const result: ListingStagingRecomputeResult = {
      ...base,
      evidence_rows: evidence.length,
      pairs_written: rows.length,
      eligible_edges: rows.filter(r => r.eligible_for_fold === 1).length,
      suppressed_blacklist: rows.filter(r => r.suppression_reason === 'blacklisted_endpoint')
        .length,
      suppressed_conflicts: rows.filter(r => r.suppression_reason === 'different_real_profile')
        .length,
      suppressed_known_same: rows.filter(r => r.suppression_reason === 'already_known_same').length,
      suppressed_insufficient: rows.filter(
        r => r.suppression_reason === 'insufficient_repeated_12h'
      ).length,
      anchors,
      duration_ms: Date.now() - startedAt,
    };

    db.prepare(
      `UPDATE poll_state
          SET last_run_at = unixepoch(),
              last_status = 'ok',
              last_event_count = ?
        WHERE stream = ? AND collection_slug = ?`
    ).run(result.eligible_edges, STREAM, COLLECTION);

    log.info('poll/listing-staging', 'recompute complete', result);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare(
      `UPDATE poll_state
          SET last_run_at = unixepoch(),
              last_status = ?,
              last_event_count = 0
        WHERE stream = ? AND collection_slug = ?`
    ).run(msg, STREAM, COLLECTION);
    throw err;
  }
}

function scanEvidence(): CandidateEvidence[] {
  const rows = [...scanActiveListings(), ...scanListedEvents(), ...scanSoldEvents()];
  const evidence: CandidateEvidence[] = [];
  for (const row of rows) {
    if (!isCandidateEvidence(row)) continue;
    const gap = row.trigger_ts - row.prev_ts;
    evidence.push({
      trigger_type: row.trigger_type,
      trigger_group: triggerGroupFor(row.trigger_type),
      inscription_number: row.inscription_number,
      trigger_ts: row.trigger_ts,
      trigger_event_id: row.trigger_event_id,
      trigger_ref: row.trigger_ref,
      trigger_marketplace: row.trigger_marketplace,
      trigger_price_sats: row.trigger_price_sats,
      prev_event_id: row.prev_event_id,
      prev_txid: row.prev_txid,
      prev_ts: row.prev_ts,
      gap_sec: gap,
      source: row.source,
      seller: row.seller,
    });
  }
  return evidence;
}

function scanActiveListings(): TriggerRow[] {
  return getDb()
    .prepare(
      `
      SELECT
        'active_listing' AS trigger_type,
        al.inscription_number,
        al.seller,
        al.listed_at AS trigger_ts,
        NULL AS trigger_event_id,
        al.satflow_id AS trigger_ref,
        al.marketplace AS trigger_marketplace,
        al.price_sats AS trigger_price_sats,
        p.id AS prev_event_id,
        p.event_type AS prev_event_type,
        p.marketplace AS prev_marketplace,
        p.old_owner AS source,
        p.new_owner AS prev_new_owner,
        p.block_timestamp AS prev_ts,
        p.txid AS prev_txid
      FROM active_listings al
      JOIN events p ON p.id = (
        SELECT e.id
        FROM events e
        WHERE e.inscription_number = al.inscription_number
          AND e.event_type != 'listed'
          AND e.block_timestamp <= al.listed_at
        ORDER BY e.block_timestamp DESC, e.id DESC
        LIMIT 1
      )
      WHERE al.seller IS NOT NULL
      `
    )
    .all() as TriggerRow[];
}

function scanListedEvents(): TriggerRow[] {
  return getDb()
    .prepare(
      `
      SELECT
        'listed_event' AS trigger_type,
        t.inscription_number,
        t.old_owner AS seller,
        t.block_timestamp AS trigger_ts,
        t.id AS trigger_event_id,
        t.txid AS trigger_ref,
        t.marketplace AS trigger_marketplace,
        t.sale_price_sats AS trigger_price_sats,
        p.id AS prev_event_id,
        p.event_type AS prev_event_type,
        p.marketplace AS prev_marketplace,
        p.old_owner AS source,
        p.new_owner AS prev_new_owner,
        p.block_timestamp AS prev_ts,
        p.txid AS prev_txid
      FROM events t
      JOIN events p ON p.id = (
        SELECT e.id
        FROM events e
        WHERE e.inscription_number = t.inscription_number
          AND e.event_type != 'listed'
          AND (
            e.block_timestamp < t.block_timestamp
            OR (e.block_timestamp = t.block_timestamp AND e.id < t.id)
          )
        ORDER BY e.block_timestamp DESC, e.id DESC
        LIMIT 1
      )
      WHERE t.event_type = 'listed'
        AND t.old_owner IS NOT NULL
      `
    )
    .all() as TriggerRow[];
}

function scanSoldEvents(): TriggerRow[] {
  return getDb()
    .prepare(
      `
      SELECT
        'sold_event' AS trigger_type,
        t.inscription_number,
        t.old_owner AS seller,
        t.block_timestamp AS trigger_ts,
        t.id AS trigger_event_id,
        t.txid AS trigger_ref,
        t.marketplace AS trigger_marketplace,
        t.sale_price_sats AS trigger_price_sats,
        p.id AS prev_event_id,
        p.event_type AS prev_event_type,
        p.marketplace AS prev_marketplace,
        p.old_owner AS source,
        p.new_owner AS prev_new_owner,
        p.block_timestamp AS prev_ts,
        p.txid AS prev_txid
      FROM events t
      JOIN events p ON p.id = (
        SELECT e.id
        FROM events e
        WHERE e.inscription_number = t.inscription_number
          AND e.event_type != 'listed'
          AND (
            e.block_timestamp < t.block_timestamp
            OR (e.block_timestamp = t.block_timestamp AND e.id < t.id)
          )
        ORDER BY e.block_timestamp DESC, e.id DESC
        LIMIT 1
      )
      WHERE t.event_type = 'sold'
        AND t.old_owner IS NOT NULL
      `
    )
    .all() as TriggerRow[];
}

function isCandidateEvidence(row: TriggerRow): row is TriggerRow & {
  source: string;
  seller: string;
} {
  return (
    row.prev_event_type === 'transferred' &&
    row.prev_marketplace == null &&
    row.source != null &&
    row.seller != null &&
    row.prev_new_owner === row.seller &&
    row.source !== row.seller &&
    Number.isFinite(row.trigger_ts) &&
    Number.isFinite(row.prev_ts) &&
    row.trigger_ts >= row.prev_ts
  );
}

function buildRows(
  evidence: CandidateEvidence[],
  ctx: {
    profiles: Map<string, Profile>;
    cluster: Map<string, number>;
    blacklisted: Set<string>;
  }
): StagingEdgeWrite[] {
  const byPair = new Map<string, PairAcc>();
  for (const ev of evidence) {
    const key = `${ev.source}\u0000${ev.seller}`;
    const existing = byPair.get(key);
    if (existing) {
      existing.evidence.push(ev);
    } else {
      byPair.set(key, {
        source: ev.source,
        seller: ev.seller,
        evidence: [ev],
      });
    }
  }

  const rows: StagingEdgeWrite[] = [];
  for (const pair of Array.from(byPair.values())) {
    const validation = validateProfiles(pair.source, pair.seller, ctx.profiles);
    const clusterConfidence = ctx.cluster.get(pairKey(pair.source, pair.seller)) ?? null;
    const gaps = pair.evidence.map(e => e.gap_sec).sort((a, b) => a - b);
    const fast = pair.evidence.filter(e => e.gap_sec <= FAST_WINDOW_SEC);
    const fastGaps = fast.map(e => e.gap_sec).sort((a, b) => a - b);
    const activeListingCount = pair.evidence.filter(
      e => e.trigger_type === 'active_listing'
    ).length;
    const listedEventCount = pair.evidence.filter(e => e.trigger_type === 'listed_event').length;
    const soldCount = pair.evidence.filter(e => e.trigger_type === 'sold_event').length;
    const fastDistinctInscriptions = distinctCount(fast.map(e => e.inscription_number));
    const suppression = suppressionReason({
      source: pair.source,
      seller: pair.seller,
      validation,
      clusterConfidence,
      fastDistinctInscriptions,
      blacklisted: ctx.blacklisted,
    });
    const evidenceForDisplay = fast
      .slice()
      .sort((a, b) => a.gap_sec - b.gap_sec || b.trigger_ts - a.trigger_ts)
      .slice(0, EVIDENCE_CAP)
      .map(e => ({
        trigger_type: e.trigger_type,
        trigger_group: e.trigger_group,
        inscription_number: e.inscription_number,
        trigger_ts: e.trigger_ts,
        trigger_event_id: e.trigger_event_id,
        trigger_ref: e.trigger_ref,
        trigger_marketplace: e.trigger_marketplace,
        trigger_price_sats: e.trigger_price_sats,
        prev_event_id: e.prev_event_id,
        prev_txid: e.prev_txid,
        prev_ts: e.prev_ts,
        gap_sec: e.gap_sec,
      }));

    rows.push({
      source_wallet: pair.source,
      seller_wallet: pair.seller,
      eligible_for_fold: suppression == null ? 1 : 0,
      suppression_reason: suppression,
      evidence_count: pair.evidence.length,
      distinct_inscriptions: distinctCount(pair.evidence.map(e => e.inscription_number)),
      fast_12h_evidence_count: fast.length,
      fast_12h_distinct_inscriptions: fastDistinctInscriptions,
      active_listing_count: activeListingCount,
      listed_event_count: listedEventCount,
      sold_count: soldCount,
      listing_count: activeListingCount + listedEventCount,
      sale_count: soldCount,
      min_gap_sec: gaps[0] ?? 0,
      median_gap_sec: median(gaps),
      max_gap_sec: gaps[gaps.length - 1] ?? 0,
      fast_12h_median_gap_sec: fastGaps.length > 0 ? median(fastGaps) : null,
      validation_kind: validation,
      existing_cluster_confidence: clusterConfidence,
      evidence_json: JSON.stringify(evidenceForDisplay),
      first_seen_at: Math.min(...pair.evidence.map(e => e.prev_ts)),
      last_seen_at: Math.max(...pair.evidence.map(e => e.trigger_ts)),
    });
  }
  rows.sort((a, b) => {
    const aMedian = a.fast_12h_median_gap_sec ?? Number.MAX_SAFE_INTEGER;
    const bMedian = b.fast_12h_median_gap_sec ?? Number.MAX_SAFE_INTEGER;
    return (
      b.eligible_for_fold - a.eligible_for_fold ||
      b.fast_12h_distinct_inscriptions - a.fast_12h_distinct_inscriptions ||
      b.fast_12h_evidence_count - a.fast_12h_evidence_count ||
      aMedian - bMedian ||
      a.source_wallet.localeCompare(b.source_wallet) ||
      a.seller_wallet.localeCompare(b.seller_wallet)
    );
  });
  return rows;
}

function suppressionReason(args: {
  source: string;
  seller: string;
  validation: ValidationKind;
  clusterConfidence: number | null;
  fastDistinctInscriptions: number;
  blacklisted: Set<string>;
}): SuppressionReason | null {
  if (args.blacklisted.has(args.source) || args.blacklisted.has(args.seller)) {
    return 'blacklisted_endpoint';
  }
  if (args.validation === 'different_real_profile') return 'different_real_profile';
  if (args.validation === 'same_real_profile' || (args.clusterConfidence ?? 0) >= 9500) {
    return 'already_known_same';
  }
  if (args.fastDistinctInscriptions < 2) return 'insufficient_repeated_12h';
  return null;
}

function validateProfiles(
  source: string,
  seller: string,
  profiles: Map<string, Profile>
): ValidationKind {
  const sourceProfile = profiles.get(source) ?? null;
  const sellerProfile = profiles.get(seller) ?? null;

  if (sourceProfile && sellerProfile) {
    if (sourceProfile.is_auto_shell || sellerProfile.is_auto_shell) return 'auto_shell';
    return sourceProfile.user_id === sellerProfile.user_id
      ? 'same_real_profile'
      : 'different_real_profile';
  }
  if (sourceProfile?.is_auto_shell || sellerProfile?.is_auto_shell) return 'auto_shell';
  return 'unknown';
}

function loadProfiles(): Map<string, Profile> {
  const profiles = new Map<string, Profile>();
  const rows = getDb()
    .prepare(
      `
      SELECT wl.wallet_addr, wl.matrica_user_id, mu.username, mu.avatar_url
      FROM wallet_links wl
      LEFT JOIN matrica_users mu ON mu.user_id = wl.matrica_user_id
      WHERE wl.matrica_user_id IS NOT NULL
      `
    )
    .all() as Array<{
    wallet_addr: string;
    matrica_user_id: string;
    username: string | null;
    avatar_url: string | null;
  }>;
  for (const row of rows) {
    profiles.set(row.wallet_addr, {
      user_id: row.matrica_user_id,
      username: row.username,
      avatar_url: row.avatar_url,
      is_auto_shell: isAutoShellUsername(row.username),
    });
  }
  return profiles;
}

function loadClusterConfidence(): Map<string, number> {
  const out = new Map<string, number>();
  const rows = getDb()
    .prepare(`SELECT addr_a, addr_b, confidence FROM wallet_cluster_edges`)
    .all() as Array<{ addr_a: string; addr_b: string; confidence: number }>;
  for (const row of rows) out.set(pairKey(row.addr_a, row.addr_b), row.confidence);
  return out;
}

function loadSuppressedWallets(): Set<string> {
  const out = new Set<string>(EXCLUDED_OWNERS);
  const rows = getDb()
    .prepare(`SELECT address FROM cluster_blacklist WHERE reason != 'auto-high-degree'`)
    .all() as Array<{
    address: string;
  }>;
  for (const row of rows) out.add(row.address);
  return out;
}

export function getListingStagingLinksForWallets(
  wallets: readonly string[],
  limit = 50
): ListingStagingLinkRow[] {
  if (wallets.length === 0) return [];
  const db = getDb();
  const rows = db
    .prepare(
      `
      SELECT
        e.*,
        smu.user_id AS source_user_id,
        smu.username AS source_username,
        smu.avatar_url AS source_avatar_url,
        tmu.user_id AS seller_user_id,
        tmu.username AS seller_username,
        tmu.avatar_url AS seller_avatar_url
      FROM wallet_staging_edges e
      LEFT JOIN wallet_links swl ON swl.wallet_addr = e.source_wallet
      LEFT JOIN matrica_users smu ON smu.user_id = swl.matrica_user_id
      LEFT JOIN wallet_links twl ON twl.wallet_addr = e.seller_wallet
      LEFT JOIN matrica_users tmu ON tmu.user_id = twl.matrica_user_id
      WHERE e.eligible_for_fold = 1
        AND (
          e.source_wallet IN (SELECT value FROM json_each(@wallets_json))
          OR e.seller_wallet IN (SELECT value FROM json_each(@wallets_json))
        )
      ORDER BY
        e.fast_12h_distinct_inscriptions DESC,
        e.fast_12h_evidence_count DESC,
        e.fast_12h_median_gap_sec ASC,
        e.last_seen_at DESC
      LIMIT @limit
      `
    )
    .all({ wallets_json: JSON.stringify(wallets), limit }) as Array<
    Omit<ListingStagingLinkRow, 'evidence' | 'source_matrica' | 'seller_matrica'> & {
      evidence_json: string;
      source_user_id: string | null;
      source_username: string | null;
      source_avatar_url: string | null;
      seller_user_id: string | null;
      seller_username: string | null;
      seller_avatar_url: string | null;
    }
  >;

  return rows.map(row => {
    let evidence: ListingStagingEvidenceItem[] = [];
    try {
      const parsed = JSON.parse(row.evidence_json);
      if (Array.isArray(parsed)) evidence = parsed as ListingStagingEvidenceItem[];
    } catch {
      /* ignore malformed evidence */
    }
    return {
      source_wallet: row.source_wallet,
      seller_wallet: row.seller_wallet,
      evidence_count: row.evidence_count,
      distinct_inscriptions: row.distinct_inscriptions,
      fast_12h_evidence_count: row.fast_12h_evidence_count,
      fast_12h_distinct_inscriptions: row.fast_12h_distinct_inscriptions,
      listing_count: row.listing_count,
      sale_count: row.sale_count,
      active_listing_count: row.active_listing_count,
      listed_event_count: row.listed_event_count,
      sold_count: row.sold_count,
      min_gap_sec: row.min_gap_sec,
      median_gap_sec: row.median_gap_sec,
      max_gap_sec: row.max_gap_sec,
      fast_12h_median_gap_sec: row.fast_12h_median_gap_sec,
      validation_kind: row.validation_kind,
      existing_cluster_confidence: row.existing_cluster_confidence,
      evidence,
      first_seen_at: row.first_seen_at,
      last_seen_at: row.last_seen_at,
      source_matrica: row.source_user_id
        ? {
            user_id: row.source_user_id,
            username: row.source_username,
            avatar_url: row.source_avatar_url,
          }
        : null,
      seller_matrica: row.seller_user_id
        ? {
            user_id: row.seller_user_id,
            username: row.seller_username,
            avatar_url: row.seller_avatar_url,
          }
        : null,
    };
  });
}

function triggerGroupFor(triggerType: TriggerType): TriggerGroup {
  return triggerType === 'sold_event' ? 'sale' : 'listing';
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function distinctCount(values: readonly number[]): number {
  return new Set(values).size;
}

function isAutoShellUsername(username: string | null): boolean {
  if (!username) return true;
  if (/^bc1[a-z0-9]{20,}/i.test(username)) return true;
  if (/^0x[a-fA-F0-9]{40}/.test(username)) return true;
  return false;
}
