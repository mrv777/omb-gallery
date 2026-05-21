#!/usr/bin/env node
/* eslint-disable */
// Listing-staging wallet research pass.
//
// Hypothesis: some sellers move an OMB into a short-lived wallet and list/sell
// from that wallet. This script keeps the signal out of production clustering:
// it opens SQLite readonly, emits pair-level analysis JSON, and writes a short
// Markdown report for manual review.

const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.env.OMB_DB_PATH || path.join(REPO_ROOT, 'tmp', 'app-prod.db');
const OUT_DIR = __dirname;
const SUMMARY_PATH = path.join(OUT_DIR, 'listing-staging-summary.json');
const CANDIDATES_PATH = path.join(OUT_DIR, 'listing-staging-candidates.json');
const REPORT_PATH = path.join(OUT_DIR, 'LISTING_STAGING_REPORT.md');

const HOUR = 60 * 60;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const FAST_12H = 12 * HOUR;
const FAST_24H = DAY;

const TRIGGER_TYPES = ['active_listing', 'listed_event', 'sold_event'];
const GAP_BUCKETS = ['<=1h', '<=6h', '<=12h', '<=1d', '>1d'];
const CANDIDATE_CLASSES = [
  'known_same',
  'known_conflict',
  'repeated_fast_12h',
  'repeated_fast_24h',
  'single_fast_12h',
  'single_fast_24h',
  'outside_fast_window',
];
const VALIDATION_TYPES = ['same_real_profile', 'different_real_profile', 'auto_shell', 'unknown'];
const FAST_WINDOWS = [
  { key: 'fast_12h', label: '<=12h', seconds: FAST_12H },
  { key: 'fast_24h', label: '<=24h', seconds: FAST_24H },
];

function main() {
  const db = new Database(DB_PATH, {
    readonly: true,
    fileMustExist: true,
    timeout: 5000,
  });
  db.pragma('query_only = ON');

  try {
    requireTables(db, [
      'active_listings',
      'events',
      'inscriptions',
      'matrica_users',
      'wallet_cluster_edges',
      'wallet_links',
    ]);

    const startedAt = new Date();
    console.log(`[listing-staging] DB: ${DB_PATH}`);
    console.log('[listing-staging] loading reference data...');

    const profiles = loadProfiles(db);
    const clusterEdges = loadClusterEdges(db);
    const sellerStats = loadSellerStats(db);
    const ownerEventIndex = buildOwnerEventIndex(db);

    console.log('[listing-staging] scanning triggers...');
    const triggerStats = scanTriggerStats(db);
    const evidence = [
      ...scanActiveListings(db),
      ...scanListedEvents(db),
      ...scanSoldEvents(db),
    ].filter(row => isCandidateEvidence(row));

    console.log(`[listing-staging] kept evidence rows: ${evidence.length}`);
    const pairs = aggregatePairs(evidence, {
      profiles,
      clusterEdges,
      sellerStats,
      ownerEventIndex,
    });

    const summary = buildSummary({
      dbPath: DB_PATH,
      startedAt,
      generatedAt: new Date(),
      triggerStats,
      evidence,
      pairs,
      profiles,
      clusterEdges,
    });

    writeOutputs(summary, pairs);
    console.log(`[listing-staging] wrote ${path.relative(REPO_ROOT, SUMMARY_PATH)}`);
    console.log(`[listing-staging] wrote ${path.relative(REPO_ROOT, CANDIDATES_PATH)}`);
    console.log(`[listing-staging] wrote ${path.relative(REPO_ROOT, REPORT_PATH)}`);
    console.log(`[listing-staging] candidate pairs: ${pairs.length}`);
  } finally {
    db.close();
  }
}

function requireTables(db, names) {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
    .all()
    .map(row => row.name);
  const have = new Set(rows);
  const missing = names.filter(name => !have.has(name));
  if (missing.length > 0) {
    throw new Error(`missing required table(s): ${missing.join(', ')}`);
  }
}

function scanTriggerStats(db) {
  const out = {};
  out.active_listing = {
    scanned: scalar(db, `SELECT COUNT(*) FROM active_listings WHERE seller IS NOT NULL`),
  };
  out.listed_event = {
    scanned: scalar(
      db,
      `SELECT COUNT(*) FROM events WHERE event_type = 'listed' AND old_owner IS NOT NULL`
    ),
  };
  out.sold_event = {
    scanned: scalar(
      db,
      `SELECT COUNT(*) FROM events WHERE event_type = 'sold' AND old_owner IS NOT NULL`
    ),
  };
  return out;
}

function scanActiveListings(db) {
  return db
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
    .all();
}

function scanListedEvents(db) {
  return db
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
    .all();
}

function scanSoldEvents(db) {
  return db
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
    .all();
}

function isCandidateEvidence(row) {
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

function loadProfiles(db) {
  const profiles = new Map();
  const rows = db
    .prepare(
      `
      SELECT wl.wallet_addr, wl.matrica_user_id, mu.username, mu.avatar_url
      FROM wallet_links wl
      LEFT JOIN matrica_users mu ON mu.user_id = wl.matrica_user_id
      WHERE wl.matrica_user_id IS NOT NULL
      `
    )
    .all();

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

function loadClusterEdges(db) {
  const edges = new Map();
  const rows = db
    .prepare(
      `
      SELECT addr_a, addr_b, confidence,
             cih_count, self_xfer_count, self_xfer_ab, self_xfer_ba,
             co_cons_count, co_parent_count,
             pmx_count, pmx_rt_count,
             last_seen_at
      FROM wallet_cluster_edges
      `
    )
    .all();

  for (const row of rows) {
    edges.set(pairKey(row.addr_a, row.addr_b), row);
  }
  return edges;
}

function loadSellerStats(db) {
  const holdings = new Map();
  for (const row of db
    .prepare(
      `
      SELECT effective_owner AS wallet, COUNT(*) AS n
      FROM inscriptions
      WHERE collection_slug = 'omb'
        AND effective_owner IS NOT NULL
      GROUP BY effective_owner
      `
    )
    .all()) {
    holdings.set(row.wallet, row.n);
  }

  const activeListings = new Map();
  for (const row of db
    .prepare(
      `
      SELECT seller AS wallet, COUNT(*) AS n
      FROM active_listings
      WHERE seller IS NOT NULL
      GROUP BY seller
      `
    )
    .all()) {
    activeListings.set(row.wallet, row.n);
  }

  return { holdings, activeListings };
}

function buildOwnerEventIndex(db) {
  const idx = new Map();
  const rows = db
    .prepare(
      `
      SELECT id, block_timestamp, old_owner, new_owner
      FROM events
      WHERE event_type != 'listed'
      ORDER BY block_timestamp ASC, id ASC
      `
    )
    .all();

  for (const row of rows) {
    if (row.old_owner) pushOwnerEvent(idx, row.old_owner, row);
    if (row.new_owner && row.new_owner !== row.old_owner) {
      pushOwnerEvent(idx, row.new_owner, row);
    }
  }
  return idx;
}

function pushOwnerEvent(idx, wallet, row) {
  let arr = idx.get(wallet);
  if (!arr) {
    arr = [];
    idx.set(wallet, arr);
  }
  arr.push({ ts: row.block_timestamp, id: row.id });
}

function countOwnerEventsBefore(idx, wallet, ts, id) {
  const arr = idx.get(wallet);
  if (!arr) return 0;
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const ev = arr[mid];
    if (ev.ts < ts || (ev.ts === ts && ev.id < id)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function aggregatePairs(evidence, ctx) {
  const byPair = new Map();

  for (const row of evidence) {
    const key = `${row.source}\u0000${row.seller}`;
    let pair = byPair.get(key);
    if (!pair) {
      const validation = validateProfiles(row.source, row.seller, ctx.profiles);
      const edge = ctx.clusterEdges.get(pairKey(row.source, row.seller)) || null;
      const sellerPriorEvents = countOwnerEventsBefore(
        ctx.ownerEventIndex,
        row.seller,
        row.prev_ts,
        row.prev_event_id
      );

      pair = {
        pair_key: key.replace('\u0000', ' -> '),
        source: row.source,
        seller: row.seller,
        validation,
        source_profile: profileForOutput(ctx.profiles.get(row.source)),
        seller_profile: profileForOutput(ctx.profiles.get(row.seller)),
        cluster: clusterForOutput(edge),
        evidence: [],
        trigger_counts: zeroObject(TRIGGER_TYPES),
        gap_buckets: zeroObject(GAP_BUCKETS),
        inscription_numbers: new Set(),
        prev_event_ids: new Set(),
        seller_prior_events_values: [],
        seller_first_seen_evidence_count: 0,
        seller_current_holdings: ctx.sellerStats.holdings.get(row.seller) || 0,
        seller_active_listings: ctx.sellerStats.activeListings.get(row.seller) || 0,
      };
      if (sellerPriorEvents === 0) pair.seller_first_seen_evidence_count += 1;
      pair.seller_prior_events_values.push(sellerPriorEvents);
      byPair.set(key, pair);
    } else {
      const sellerPriorEvents = countOwnerEventsBefore(
        ctx.ownerEventIndex,
        row.seller,
        row.prev_ts,
        row.prev_event_id
      );
      if (sellerPriorEvents === 0) pair.seller_first_seen_evidence_count += 1;
      pair.seller_prior_events_values.push(sellerPriorEvents);
    }

    const gapSec = row.trigger_ts - row.prev_ts;
    pair.trigger_counts[row.trigger_type] += 1;
    pair.gap_buckets[gapBucket(gapSec)] += 1;
    pair.inscription_numbers.add(row.inscription_number);
    pair.prev_event_ids.add(row.prev_event_id);
    pair.evidence.push(evidenceForOutput(row, gapSec));
  }

  const out = [];
  for (const pair of byPair.values()) {
    const gaps = pair.evidence.map(e => e.gap_sec).sort((a, b) => a - b);
    const listingEvidence = pair.evidence.filter(e => e.trigger_group === 'listing');
    const saleEvidence = pair.evidence.filter(e => e.trigger_group === 'sale');
    const fastWindows = {};
    for (const window of FAST_WINDOWS) {
      fastWindows[window.key] = fastWindowStats(pair.evidence, window.seconds);
    }
    const distinctInscriptions = pair.inscription_numbers.size;
    const sellerPriorValues = pair.seller_prior_events_values;
    const classificationInput = {
      validation: pair.validation,
      cluster: pair.cluster,
      fast_12h: fastWindows.fast_12h,
      fast_24h: fastWindows.fast_24h,
    };
    const finalized = {
      pair_key: pair.pair_key,
      source: pair.source,
      seller: pair.seller,
      candidate_class: classifyPair(classificationInput),
      validation: pair.validation,
      source_profile: pair.source_profile,
      seller_profile: pair.seller_profile,
      evidence_count: pair.evidence.length,
      distinct_inscriptions: distinctInscriptions,
      distinct_prev_events: pair.prev_event_ids.size,
      active_listing_count: pair.trigger_counts.active_listing,
      listed_event_count: pair.trigger_counts.listed_event,
      sold_count: pair.trigger_counts.sold_event,
      trigger_counts: pair.trigger_counts,
      gap_buckets: pair.gap_buckets,
      min_gap_sec: gaps[0] || 0,
      median_gap_sec: median(gaps),
      max_gap_sec: gaps[gaps.length - 1] || 0,
      min_gap_label: formatDuration(gaps[0] || 0),
      median_gap_label: formatDuration(median(gaps)),
      max_gap_label: formatDuration(gaps[gaps.length - 1] || 0),
      gap_summary: {
        overall: gapStats(pair.evidence),
        listing: gapStats(listingEvidence),
        sale: gapStats(saleEvidence),
      },
      fast_windows: fastWindows,
      cluster: pair.cluster,
      seller_shape: {
        first_seen_at_staging_any: pair.seller_first_seen_evidence_count > 0,
        first_seen_at_staging_all: pair.seller_first_seen_evidence_count === pair.evidence.length,
        first_seen_evidence_count: pair.seller_first_seen_evidence_count,
        min_prior_events_before_staging: Math.min(...sellerPriorValues),
        median_prior_events_before_staging: median(sellerPriorValues),
        max_prior_events_before_staging: Math.max(...sellerPriorValues),
        current_holdings: pair.seller_current_holdings,
        active_listings: pair.seller_active_listings,
        all_current_holdings_listed:
          pair.seller_current_holdings > 0 &&
          pair.seller_current_holdings === pair.seller_active_listings,
      },
      evidence: pair.evidence.sort((a, b) => a.gap_sec - b.gap_sec || a.trigger_ts - b.trigger_ts),
    };
    out.push(finalized);
  }

  out.sort((a, b) => {
    const classDelta = classRank(a.candidate_class) - classRank(b.candidate_class);
    if (classDelta !== 0) return classDelta;
    const fastKey = a.candidate_class.includes('24h') ? 'fast_24h' : 'fast_12h';
    const aFast = a.fast_windows[fastKey]?.distinct_inscriptions ?? 0;
    const bFast = b.fast_windows[fastKey]?.distinct_inscriptions ?? 0;
    if (bFast !== aFast) return bFast - aFast;
    const aFastEvidence = a.fast_windows[fastKey]?.evidence_count ?? 0;
    const bFastEvidence = b.fast_windows[fastKey]?.evidence_count ?? 0;
    if (bFastEvidence !== aFastEvidence) return bFastEvidence - aFastEvidence;
    if (b.distinct_inscriptions !== a.distinct_inscriptions) {
      return b.distinct_inscriptions - a.distinct_inscriptions;
    }
    if (a.median_gap_sec !== b.median_gap_sec) return a.median_gap_sec - b.median_gap_sec;
    return a.pair_key.localeCompare(b.pair_key);
  });

  return out;
}

function classifyPair(args) {
  if (args.validation.kind === 'different_real_profile') return 'known_conflict';
  if (args.validation.kind === 'same_real_profile') return 'known_same';
  if ((args.cluster && args.cluster.confidence >= 9500) || false) return 'known_same';
  if (args.fast_12h.distinct_inscriptions >= 2) return 'repeated_fast_12h';
  if (args.fast_24h.distinct_inscriptions >= 2) return 'repeated_fast_24h';
  if (args.fast_12h.distinct_inscriptions === 1) return 'single_fast_12h';
  if (args.fast_24h.distinct_inscriptions === 1) return 'single_fast_24h';
  return 'outside_fast_window';
}

function validateProfiles(source, seller, profiles) {
  const sourceProfile = profiles.get(source) || null;
  const sellerProfile = profiles.get(seller) || null;

  if (sourceProfile && sellerProfile) {
    if (sourceProfile.is_auto_shell || sellerProfile.is_auto_shell) {
      return {
        kind: 'auto_shell',
        reason: 'one or both Matrica profiles look like address auto-shells',
      };
    }
    if (sourceProfile.user_id === sellerProfile.user_id) {
      return {
        kind: 'same_real_profile',
        reason: 'both wallets resolve to the same non-address Matrica profile',
      };
    }
    return {
      kind: 'different_real_profile',
      reason: 'both wallets resolve to different non-address Matrica profiles',
    };
  }

  if (
    (sourceProfile && sourceProfile.is_auto_shell) ||
    (sellerProfile && sellerProfile.is_auto_shell)
  ) {
    return {
      kind: 'auto_shell',
      reason: 'one wallet has an address-like Matrica auto-shell profile',
    };
  }

  return { kind: 'unknown', reason: 'missing real-profile linkage for one or both wallets' };
}

function profileForOutput(profile) {
  if (!profile) return null;
  return {
    user_id: profile.user_id,
    username: profile.username,
    avatar_url: profile.avatar_url,
    is_auto_shell: profile.is_auto_shell,
  };
}

function clusterForOutput(edge) {
  if (!edge) {
    return {
      confidence: null,
      at_9500: false,
      at_9900: false,
    };
  }
  return {
    confidence: edge.confidence,
    at_9500: edge.confidence >= 9500,
    at_9900: edge.confidence >= 9900,
    cih_count: edge.cih_count,
    self_xfer_count: edge.self_xfer_count,
    self_xfer_ab: edge.self_xfer_ab,
    self_xfer_ba: edge.self_xfer_ba,
    co_cons_count: edge.co_cons_count,
    co_parent_count: edge.co_parent_count,
    pmx_count: edge.pmx_count,
    pmx_rt_count: edge.pmx_rt_count,
    last_seen_at: edge.last_seen_at,
  };
}

function evidenceForOutput(row, gapSec) {
  const triggerGroup = triggerGroupFor(row.trigger_type);
  return {
    trigger_type: row.trigger_type,
    trigger_group: triggerGroup,
    inscription_number: row.inscription_number,
    trigger_ts: row.trigger_ts,
    trigger_time: iso(row.trigger_ts),
    trigger_event_id: row.trigger_event_id,
    trigger_ref: row.trigger_ref,
    trigger_marketplace: row.trigger_marketplace,
    trigger_price_sats: row.trigger_price_sats,
    prev_event_id: row.prev_event_id,
    prev_txid: row.prev_txid,
    prev_ts: row.prev_ts,
    prev_time: iso(row.prev_ts),
    gap_sec: gapSec,
    gap_label: formatDuration(gapSec),
    fast_12h: gapSec <= FAST_12H,
    fast_24h: gapSec <= FAST_24H,
  };
}

function triggerGroupFor(triggerType) {
  return triggerType === 'sold_event' ? 'sale' : 'listing';
}

function gapStats(evidence) {
  if (evidence.length === 0) {
    return {
      evidence_count: 0,
      distinct_inscriptions: 0,
      min_gap_sec: null,
      median_gap_sec: null,
      max_gap_sec: null,
      min_gap_label: null,
      median_gap_label: null,
      max_gap_label: null,
    };
  }
  const gaps = evidence.map(e => e.gap_sec).sort((a, b) => a - b);
  return {
    evidence_count: evidence.length,
    distinct_inscriptions: distinctCount(evidence, e => e.inscription_number),
    min_gap_sec: gaps[0],
    median_gap_sec: median(gaps),
    max_gap_sec: gaps[gaps.length - 1],
    min_gap_label: formatDuration(gaps[0]),
    median_gap_label: formatDuration(median(gaps)),
    max_gap_label: formatDuration(gaps[gaps.length - 1]),
  };
}

function fastWindowStats(evidence, seconds) {
  const fast = evidence.filter(e => e.gap_sec <= seconds);
  const listing = fast.filter(e => e.trigger_group === 'listing');
  const sale = fast.filter(e => e.trigger_group === 'sale');
  return {
    evidence_count: fast.length,
    distinct_inscriptions: distinctCount(fast, e => e.inscription_number),
    listing_evidence_count: listing.length,
    listing_distinct_inscriptions: distinctCount(listing, e => e.inscription_number),
    sale_evidence_count: sale.length,
    sale_distinct_inscriptions: distinctCount(sale, e => e.inscription_number),
    median_gap_sec: fast.length > 0 ? median(fast.map(e => e.gap_sec)) : null,
    median_gap_label: fast.length > 0 ? formatDuration(median(fast.map(e => e.gap_sec))) : null,
  };
}

function buildSummary(args) {
  const pairCount = args.pairs.length;
  const summary = {
    generated_at: args.generatedAt.toISOString(),
    db_path: args.dbPath,
    runtime_ms: args.generatedAt.getTime() - args.startedAt.getTime(),
    totals: {
      evidence_rows: args.evidence.length,
      candidate_pairs: pairCount,
      distinct_inscriptions: new Set(args.evidence.map(e => e.inscription_number)).size,
      matrica_linked_wallets: args.profiles.size,
      cluster_edges: args.clusterEdges.size,
    },
    trigger_stats: finalizeTriggerStats(args.triggerStats, args.evidence),
    breakdowns: {
      by_trigger_type: countBy(args.evidence, row => row.trigger_type, TRIGGER_TYPES),
      by_trigger_group: countBy(args.evidence, row => triggerGroupFor(row.trigger_type), [
        'listing',
        'sale',
      ]),
      by_gap_bucket: countBy(
        args.evidence,
        row => gapBucket(row.trigger_ts - row.prev_ts),
        GAP_BUCKETS
      ),
      by_candidate_class: countBy(args.pairs, pair => pair.candidate_class, CANDIDATE_CLASSES),
      by_validation: countBy(args.pairs, pair => pair.validation.kind, VALIDATION_TYPES),
    },
    fast_windows: buildFastWindowSummary(args.pairs),
    precision_proxy: buildPrecisionProxy(args.pairs),
    cluster_overlap: buildClusterOverlap(args.pairs),
    review_shortlists: buildReviewShortlists(args.pairs),
  };
  return summary;
}

function buildFastWindowSummary(pairs) {
  const out = {};
  for (const window of FAST_WINDOWS) {
    const rows = pairs.filter(pair => pair.fast_windows[window.key].distinct_inscriptions > 0);
    const repeated = rows.filter(pair => pair.fast_windows[window.key].distinct_inscriptions >= 2);
    const single = rows.filter(pair => pair.fast_windows[window.key].distinct_inscriptions === 1);
    const novelRepeated = repeated.filter(
      pair =>
        pair.validation.kind !== 'different_real_profile' &&
        !pair.cluster.at_9500 &&
        pair.fast_windows[window.key].distinct_inscriptions >= 2
    );

    out[window.key] = {
      label: window.label,
      seconds: window.seconds,
      pairs: rows.length,
      repeated_pairs: repeated.length,
      single_pairs: single.length,
      non_conflict_pairs: rows.filter(pair => pair.validation.kind !== 'different_real_profile')
        .length,
      non_conflict_repeated_pairs: repeated.filter(
        pair => pair.validation.kind !== 'different_real_profile'
      ).length,
      novel_non_conflict_repeated_pairs: novelRepeated.length,
      listing_pairs: rows.filter(
        pair => pair.fast_windows[window.key].listing_distinct_inscriptions > 0
      ).length,
      sale_pairs: rows.filter(pair => pair.fast_windows[window.key].sale_distinct_inscriptions > 0)
        .length,
      listing_only_pairs: rows.filter(
        pair =>
          pair.fast_windows[window.key].listing_distinct_inscriptions > 0 &&
          pair.fast_windows[window.key].sale_distinct_inscriptions === 0
      ).length,
      sale_only_pairs: rows.filter(
        pair =>
          pair.fast_windows[window.key].sale_distinct_inscriptions > 0 &&
          pair.fast_windows[window.key].listing_distinct_inscriptions === 0
      ).length,
      mixed_listing_sale_pairs: rows.filter(
        pair =>
          pair.fast_windows[window.key].listing_distinct_inscriptions > 0 &&
          pair.fast_windows[window.key].sale_distinct_inscriptions > 0
      ).length,
      validation: countBy(rows, pair => pair.validation.kind, VALIDATION_TYPES),
      candidate_classes: countBy(rows, pair => pair.candidate_class, CANDIDATE_CLASSES),
    };
  }
  return out;
}

function finalizeTriggerStats(triggerStats, evidence) {
  const kept = countBy(evidence, row => row.trigger_type, TRIGGER_TYPES);
  const out = {};
  for (const type of TRIGGER_TYPES) {
    out[type] = {
      scanned: triggerStats[type].scanned,
      kept_candidate_evidence: kept[type] || 0,
      kept_rate:
        triggerStats[type].scanned > 0
          ? Number(((kept[type] || 0) / triggerStats[type].scanned).toFixed(4))
          : 0,
    };
  }
  return out;
}

function buildPrecisionProxy(pairs) {
  const byClass = {};
  for (const cls of CANDIDATE_CLASSES) {
    byClass[cls] = zeroObject(VALIDATION_TYPES);
    byClass[cls].pair_count = 0;
    byClass[cls].labeled_real_pair_count = 0;
    byClass[cls].same_real_profile_rate = null;
  }

  for (const pair of pairs) {
    const bucket = byClass[pair.candidate_class];
    bucket.pair_count += 1;
    bucket[pair.validation.kind] += 1;
    if (
      pair.validation.kind === 'same_real_profile' ||
      pair.validation.kind === 'different_real_profile'
    ) {
      bucket.labeled_real_pair_count += 1;
    }
  }

  for (const bucket of Object.values(byClass)) {
    bucket.same_real_profile_rate =
      bucket.labeled_real_pair_count > 0
        ? Number((bucket.same_real_profile / bucket.labeled_real_pair_count).toFixed(4))
        : null;
  }

  const overall = zeroObject(VALIDATION_TYPES);
  overall.pair_count = pairs.length;
  overall.labeled_real_pair_count = 0;
  for (const pair of pairs) {
    overall[pair.validation.kind] += 1;
    if (
      pair.validation.kind === 'same_real_profile' ||
      pair.validation.kind === 'different_real_profile'
    ) {
      overall.labeled_real_pair_count += 1;
    }
  }
  overall.same_real_profile_rate =
    overall.labeled_real_pair_count > 0
      ? Number((overall.same_real_profile / overall.labeled_real_pair_count).toFixed(4))
      : null;

  return { overall, by_candidate_class: byClass };
}

function buildClusterOverlap(pairs) {
  const out = {
    overall: {
      pair_count: 0,
      cluster_edge_present: 0,
      cluster_confidence_ge_9500: 0,
      cluster_confidence_ge_9900: 0,
    },
    by_candidate_class: {},
  };
  for (const cls of CANDIDATE_CLASSES) {
    out.by_candidate_class[cls] = {
      pair_count: 0,
      cluster_edge_present: 0,
      cluster_confidence_ge_9500: 0,
      cluster_confidence_ge_9900: 0,
    };
  }

  for (const pair of pairs) {
    bumpClusterBucket(out.overall, pair);
    bumpClusterBucket(out.by_candidate_class[pair.candidate_class], pair);
  }
  return out;
}

function bumpClusterBucket(bucket, pair) {
  bucket.pair_count += 1;
  if (pair.cluster.confidence != null) bucket.cluster_edge_present += 1;
  if (pair.cluster.at_9500) bucket.cluster_confidence_ge_9500 += 1;
  if (pair.cluster.at_9900) bucket.cluster_confidence_ge_9900 += 1;
}

function buildReviewShortlists(pairs) {
  return {
    repeated_fast_12h: pairs
      .filter(pair => pair.candidate_class === 'repeated_fast_12h')
      .slice(0, 25)
      .map(shortPair),
    repeated_fast_24h: pairs
      .filter(pair => pair.candidate_class === 'repeated_fast_24h')
      .slice(0, 25)
      .map(shortPair),
    novel_repeated_fast_12h: pairs
      .filter(
        pair =>
          pair.validation.kind !== 'different_real_profile' &&
          !pair.cluster.at_9500 &&
          pair.fast_windows.fast_12h.distinct_inscriptions >= 2
      )
      .slice(0, 25)
      .map(shortPair),
    known_conflicts: pairs
      .filter(pair => pair.candidate_class === 'known_conflict')
      .slice(0, 25)
      .map(shortPair),
    known_same: pairs
      .filter(pair => pair.candidate_class === 'known_same')
      .slice(0, 25)
      .map(shortPair),
  };
}

function shortPair(pair) {
  return {
    source: pair.source,
    seller: pair.seller,
    source_label: labelWallet(pair.source, pair.source_profile),
    seller_label: labelWallet(pair.seller, pair.seller_profile),
    evidence_count: pair.evidence_count,
    distinct_inscriptions: pair.distinct_inscriptions,
    median_gap_label: pair.median_gap_label,
    listing_median_gap_label: pair.gap_summary.listing.median_gap_label,
    sale_median_gap_label: pair.gap_summary.sale.median_gap_label,
    fast_windows: pair.fast_windows,
    validation: pair.validation.kind,
    cluster_confidence: pair.cluster.confidence,
    active_listing_count: pair.active_listing_count,
    listed_event_count: pair.listed_event_count,
    sold_count: pair.sold_count,
    seller_shape: pair.seller_shape,
    sample_evidence: pair.evidence.slice(0, 5),
  };
}

function writeOutputs(summary, pairs) {
  fs.writeFileSync(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(CANDIDATES_PATH, `${JSON.stringify(pairs, null, 2)}\n`);
  fs.writeFileSync(REPORT_PATH, renderReport(summary, pairs));
}

function renderReport(summary, pairs) {
  const lines = [];
  lines.push('# Listing-staging wallet analysis');
  lines.push('');
  lines.push(`Generated: ${summary.generated_at}`);
  lines.push(`Database: \`${summary.db_path}\``);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(
    `Found **${summary.totals.evidence_rows.toLocaleString()}** candidate evidence rows across **${summary.totals.candidate_pairs.toLocaleString()}** directed source -> seller wallet pairs.`
  );
  lines.push(
    'This is a research-only signal. Real-profile Matrica conflicts take precedence over existing cluster overlap in the candidate classification.'
  );
  lines.push('');
  lines.push('## Trigger coverage');
  lines.push('');
  lines.push('| trigger | scanned | kept | kept rate |');
  lines.push('|---|---:|---:|---:|');
  for (const type of TRIGGER_TYPES) {
    const row = summary.trigger_stats[type];
    lines.push(
      `| ${type} | ${row.scanned.toLocaleString()} | ${row.kept_candidate_evidence.toLocaleString()} | ${(row.kept_rate * 100).toFixed(2)}% |`
    );
  }
  lines.push('');
  lines.push('## Candidate classes');
  lines.push('');
  lines.push(
    '| class | pairs | cluster >=9500 | cluster >=9900 | same real | diff real | auto-shell | unknown |'
  );
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const cls of CANDIDATE_CLASSES) {
    const proxy = summary.precision_proxy.by_candidate_class[cls];
    const overlap = summary.cluster_overlap.by_candidate_class[cls];
    lines.push(
      `| ${cls} | ${proxy.pair_count.toLocaleString()} | ${overlap.cluster_confidence_ge_9500.toLocaleString()} | ${overlap.cluster_confidence_ge_9900.toLocaleString()} | ${proxy.same_real_profile.toLocaleString()} | ${proxy.different_real_profile.toLocaleString()} | ${proxy.auto_shell.toLocaleString()} | ${proxy.unknown.toLocaleString()} |`
    );
  }
  lines.push('');
  lines.push('## Fast windows');
  lines.push('');
  lines.push(
    '| window | pairs | non-conflict pairs | repeated non-conflict | novel repeated non-conflict | listing pairs | sale pairs | sale-only | listing-only | mixed |'
  );
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const window of FAST_WINDOWS) {
    const row = summary.fast_windows[window.key];
    lines.push(
      `| ${row.label} | ${row.pairs.toLocaleString()} | ${row.non_conflict_pairs.toLocaleString()} | ${row.non_conflict_repeated_pairs.toLocaleString()} | ${row.novel_non_conflict_repeated_pairs.toLocaleString()} | ${row.listing_pairs.toLocaleString()} | ${row.sale_pairs.toLocaleString()} | ${row.sale_only_pairs.toLocaleString()} | ${row.listing_only_pairs.toLocaleString()} | ${row.mixed_listing_sale_pairs.toLocaleString()} |`
    );
  }
  lines.push('');
  lines.push('## Gap buckets');
  lines.push('');
  lines.push('| gap | evidence rows |');
  lines.push('|---|---:|');
  for (const bucket of GAP_BUCKETS) {
    lines.push(
      `| ${bucket} | ${(summary.breakdowns.by_gap_bucket[bucket] || 0).toLocaleString()} |`
    );
  }
  lines.push('');
  lines.push('## Precision proxy');
  lines.push('');
  lines.push(
    'The Matrica proxy only counts non-address usernames as real-profile labels. Address-like profiles are treated as auto-shells, not hard identity conflicts.'
  );
  lines.push('');
  lines.push('| validation | pairs |');
  lines.push('|---|---:|');
  for (const kind of VALIDATION_TYPES) {
    lines.push(`| ${kind} | ${summary.precision_proxy.overall[kind].toLocaleString()} |`);
  }
  lines.push('');
  lines.push(
    `Real-profile labeled precision proxy: ${formatRate(summary.precision_proxy.overall.same_real_profile_rate)} same-profile among ${summary.precision_proxy.overall.labeled_real_pair_count.toLocaleString()} labeled pairs.`
  );
  lines.push('');
  lines.push('## Cluster overlap');
  lines.push('');
  lines.push('| measure | pairs |');
  lines.push('|---|---:|');
  lines.push(
    `| existing cluster edge present | ${summary.cluster_overlap.overall.cluster_edge_present.toLocaleString()} |`
  );
  lines.push(
    `| existing confidence >=9500 | ${summary.cluster_overlap.overall.cluster_confidence_ge_9500.toLocaleString()} |`
  );
  lines.push(
    `| existing confidence >=9900 | ${summary.cluster_overlap.overall.cluster_confidence_ge_9900.toLocaleString()} |`
  );
  lines.push('');
  lines.push('## Top repeated fast 12h candidates');
  lines.push('');
  appendShortlistTable(
    lines,
    pairs.filter(p => p.candidate_class === 'repeated_fast_12h').slice(0, 15)
  );
  lines.push('');
  lines.push('## Top repeated fast 24h candidates');
  lines.push('');
  appendShortlistTable(
    lines,
    pairs.filter(p => p.candidate_class === 'repeated_fast_24h').slice(0, 15)
  );
  lines.push('');
  lines.push('## Novel repeated fast 12h candidates');
  lines.push('');
  appendShortlistTable(
    lines,
    pairs
      .filter(
        p =>
          p.validation.kind !== 'different_real_profile' &&
          !p.cluster.at_9500 &&
          p.fast_windows.fast_12h.distinct_inscriptions >= 2
      )
      .slice(0, 15)
  );
  lines.push('');
  lines.push('## Known conflicts');
  lines.push('');
  appendShortlistTable(
    lines,
    pairs.filter(p => p.candidate_class === 'known_conflict').slice(0, 15)
  );
  lines.push('');
  lines.push('## Interpretation notes');
  lines.push('');
  lines.push(
    '- `known_same` means same real Matrica user or existing cluster confidence >=9500, unless a different-real-profile conflict is present.'
  );
  lines.push(
    '- `repeated_fast_12h` requires at least two distinct inscriptions with transfer-to-listing/sale gaps <=12 hours.'
  );
  lines.push(
    '- `repeated_fast_24h` requires at least two distinct inscriptions with gaps <=24 hours, excluding pairs already in the 12h class.'
  );
  lines.push(
    '- Single fast classes mean only one distinct inscription has fast evidence; useful for review, not linkage.'
  );
  lines.push('- `outside_fast_window` has no transfer-to-listing/sale evidence within 24 hours.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function appendShortlistTable(lines, rows) {
  if (rows.length === 0) {
    lines.push('(none)');
    return;
  }
  lines.push(
    '| source | seller | evidence | inscriptions | fast 12h insc | fast 24h insc | listing median | sale median | validation | cluster | seller holdings/listed |'
  );
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|');
  for (const pair of rows) {
    lines.push(
      `| ${escapeMd(labelWallet(pair.source, pair.source_profile))} | ${escapeMd(labelWallet(pair.seller, pair.seller_profile))} | ${pair.evidence_count} | ${pair.distinct_inscriptions} | ${pair.fast_windows.fast_12h.distinct_inscriptions} | ${pair.fast_windows.fast_24h.distinct_inscriptions} | ${pair.gap_summary.listing.median_gap_label ?? ''} | ${pair.gap_summary.sale.median_gap_label ?? ''} | ${pair.validation.kind} | ${pair.cluster.confidence ?? ''} | ${pair.seller_shape.current_holdings}/${pair.seller_shape.active_listings} |`
    );
  }
}

function countBy(rows, keyFn, keys) {
  const out = zeroObject(keys);
  for (const row of rows) {
    const key = keyFn(row);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function zeroObject(keys) {
  const out = {};
  for (const key of keys) out[key] = 0;
  return out;
}

function scalar(db, sql) {
  const row = db.prepare(sql).pluck().get();
  return Number(row || 0);
}

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function gapBucket(seconds) {
  if (seconds <= HOUR) return '<=1h';
  if (seconds <= 6 * HOUR) return '<=6h';
  if (seconds <= FAST_12H) return '<=12h';
  if (seconds <= FAST_24H) return '<=1d';
  return '>1d';
}

function median(values) {
  if (!values || values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function distinctCount(rows, keyFn) {
  const values = new Set();
  for (const row of rows) values.add(keyFn(row));
  return values.size;
}

function classRank(cls) {
  const idx = CANDIDATE_CLASSES.indexOf(cls);
  return idx === -1 ? CANDIDATE_CLASSES.length : idx;
}

function isAutoShellUsername(username) {
  if (!username) return true;
  if (/^bc1[a-z0-9]{20,}/i.test(username)) return true;
  if (/^0x[a-fA-F0-9]{40}/.test(username)) return true;
  return false;
}

function labelWallet(addr, profile) {
  if (profile && profile.username && !profile.is_auto_shell) return profile.username;
  return truncateAddr(addr);
}

function truncateAddr(addr) {
  if (!addr) return '';
  if (addr.length <= 18) return addr;
  return `${addr.slice(0, 10)}...${addr.slice(-6)}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '';
  if (seconds < HOUR) return `${Math.round(seconds / 60)}m`;
  if (seconds < DAY) return `${(seconds / HOUR).toFixed(1)}h`;
  if (seconds < WEEK) return `${(seconds / DAY).toFixed(1)}d`;
  return `${(seconds / DAY).toFixed(0)}d`;
}

function formatRate(rate) {
  if (rate == null) return 'n/a';
  return `${(rate * 100).toFixed(2)}%`;
}

function iso(ts) {
  return new Date(ts * 1000).toISOString();
}

function escapeMd(value) {
  return String(value).replaceAll('|', '\\|');
}

try {
  main();
} catch (err) {
  console.error('[listing-staging] fatal:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
}
