import 'server-only';

// Estimated expiration date/time for currently-active Liquidium loans.
//
// **This is explicitly a heuristic, not a chain-fingerprint.** BIP-341 hides
// the escrow's tap-tree until script-path spend, so we can never derive an
// active loan's exact CSV from chain (ONCHAIN_TAGGING.md §2.3). What we *can*
// observe historically: every `loan-defaulted` event reveals the default
// leaf, and the leaf encodes the term length. Across ~482 prod defaults, two
// stable patterns hold:
//
//   1. Term lengths cluster on a tight discrete menu (empirically 7/10/12/
//      14/16/30d, with 30d being the max product term and ≥96% of all
//      observations on those rungs).
//   2. Lender vaults specialize: most run 75–92% of one term across their
//      history. So `lender_vault → modal_term_days` is a high-coverage
//      predictor: ~92% of currently-active loans share a vault we've already
//      seen default.
//
// Estimator output carries a `estimated_basis` tag and `estimated_sample_count`
// so callers can communicate uncertainty in the UI. NEVER persist the
// estimate to events.raw_json or any DB column that might later be confused
// for ground truth — it stays a derived value, recomputed lazily.
//
// Source data: every `loan-defaulted` event whose raw_json carries either:
//   - leaf_script_hex (modern Liquidium) → parse + decode BIP-112 OP_CSV
//   - timelock_value + timelock_kind/opcode (legacy v3 detector) → already
//     parsed at write time; we only need to interpret as relative-CSV or
//     absolute-CLTV-against-origination
//
// Cached in-process for 5 min; corpus grows slowly (~1 default per day on
// prod), so a stale cache costs nothing meaningful.
//
// Re-validation tool: `scripts/research-loan-terms.js` (read-only, idempotent).
// Run when you want to sanity-check that vaults still specialize on one term
// and the menu hasn't shifted.

import { getDb } from './db';

const CACHE_TTL_MS = 5 * 60 * 1000;

// ---------- BIP-112 OP_CSV decoder ----------
// Per BIP-112 (relative timelock encoding):
//   bit 31 (0x80000000) = disable
//   bit 22 (0x00400000) = time-based (units of 512s)
//   bits 0..15          = magnitude
function decodeCsvField(value: number): { kind: 'time'; seconds: number } | { kind: 'blocks'; blocks: number } | null {
  if (value & 0x80000000) return null;
  const magnitude = value & 0x0000ffff;
  if (value & 0x00400000) return { kind: 'time', seconds: magnitude * 512 };
  return { kind: 'blocks', blocks: magnitude };
}

// Modern Liquidium default leaf:
//   <push N-byte timelock> b275 <push 32 pkA> ad <push 32 pkB> ac
// Returns the raw little-endian timelock as a Number, or null.
function parseModernDefaultLeafCsv(scriptHex: string): number | null {
  if (typeof scriptHex !== 'string' || scriptHex.length < 12) return null;
  const opByte = parseInt(scriptHex.slice(0, 2), 16);
  let dataLen: number;
  let dataStart: number;
  if (opByte >= 0x01 && opByte <= 0x4b) {
    dataLen = opByte;
    dataStart = 2;
  } else if (opByte === 0x4c) {
    dataLen = parseInt(scriptHex.slice(2, 4), 16);
    dataStart = 4;
  } else if (opByte === 0x4d) {
    const lo = scriptHex.slice(2, 4);
    const hi = scriptHex.slice(4, 6);
    dataLen = parseInt(hi + lo, 16);
    dataStart = 6;
  } else {
    return null;
  }
  if (dataLen <= 0 || dataLen > 5) return null;
  const dataBytesEnd = dataStart + dataLen * 2;
  if (scriptHex.slice(dataBytesEnd, dataBytesEnd + 4).toLowerCase() !== 'b275') return null;
  let n = 0;
  for (let i = 0; i < dataLen; i++) {
    const b = parseInt(scriptHex.slice(dataStart + i * 2, dataStart + i * 2 + 2), 16);
    n += b * Math.pow(2, i * 8);
  }
  return n;
}

// Decode one default event's raw_json → term in days, or null if undecodable.
function decodeTermDays(
  rawJsonText: string | null,
  originationTs: number | null,
  AVG_BLOCK_SEC = 600
): number | null {
  if (!rawJsonText) return null;
  let rj: Record<string, unknown>;
  try {
    rj = JSON.parse(rawJsonText) as Record<string, unknown>;
  } catch {
    return null;
  }

  // Path A: modern detector — parse leaf hex directly.
  if (typeof rj.leaf_script_hex === 'string') {
    const csv = parseModernDefaultLeafCsv(rj.leaf_script_hex);
    if (csv != null) {
      const dec = decodeCsvField(csv);
      if (dec?.kind === 'time') return dec.seconds / 86400;
      if (dec?.kind === 'blocks') return (dec.blocks * AVG_BLOCK_SEC) / 86400;
    }
  }

  // Path B: legacy v3 detector — already parsed.
  if (typeof rj.timelock_value === 'number') {
    const v = rj.timelock_value;
    const opcode = rj.timelock_opcode;
    const kind = rj.timelock_kind;
    if (opcode === 'CSV') {
      const dec = decodeCsvField(v);
      if (dec?.kind === 'time') return dec.seconds / 86400;
      if (dec?.kind === 'blocks') return (dec.blocks * AVG_BLOCK_SEC) / 86400;
    } else if (opcode === 'CLTV') {
      if (kind === 'timestamp' && typeof originationTs === 'number') {
        return (v - originationTs) / 86400;
      }
      // CLTV-blocks: would need origination block height. Skip.
    }
  }
  return null;
}

// ---------- Stats cache ----------

type VaultStats = {
  vault: string;
  modeDays: number;
  sampleCount: number;
  minDays: number;
  maxDays: number;
  termCounts: Map<number, number>;
};

type StatsCache = {
  perVault: Map<string, VaultStats>;
  global: { modeDays: number; sampleCount: number } | null;
  builtAt: number;
};

let cache: StatsCache | null = null;

// Round to nearest day, snapping to the nearest known menu rung if very close.
const KNOWN_RUNGS = [1, 2, 7, 10, 12, 14, 15, 16, 18, 30];
function snapToMenu(days: number): number {
  const r = Math.round(days);
  for (const rung of KNOWN_RUNGS) {
    if (Math.abs(r - rung) <= 1) return rung;
  }
  return r;
}

function buildStats(): StatsCache {
  const db = getDb();
  // Pull all decoded-defaults: join to their origination event by escrow_addr
  // (same key both detectors use). LEFT JOIN so legacy-CSV defaults — whose
  // term is decodable without origination_ts — don't get dropped.
  const rows = db
    .prepare(
      `SELECT
         d.raw_json AS default_raw_json,
         o.block_timestamp AS origination_ts,
         json_extract(d.raw_json,'$.lender_addr')   AS d_lender,
         json_extract(o.raw_json,'$.lender_addr')   AS o_lender
       FROM events d
       LEFT JOIN events o
         ON o.event_type = 'loan-originated'
        AND json_extract(o.raw_json,'$.escrow_addr') = json_extract(d.raw_json,'$.escrow_addr')
       WHERE d.event_type = 'loan-defaulted'`
    )
    .all() as Array<{
    default_raw_json: string | null;
    origination_ts: number | null;
    d_lender: string | null;
    o_lender: string | null;
  }>;

  const perVault = new Map<string, VaultStats>();
  const globalCounts = new Map<number, number>();

  for (const r of rows) {
    const days = decodeTermDays(r.default_raw_json, r.origination_ts);
    if (days == null || days <= 0 || days > 365) continue;
    const snapped = snapToMenu(days);
    const vault = r.o_lender ?? r.d_lender;

    globalCounts.set(snapped, (globalCounts.get(snapped) ?? 0) + 1);
    if (!vault) continue;

    let v = perVault.get(vault);
    if (!v) {
      v = {
        vault,
        modeDays: snapped,
        sampleCount: 0,
        minDays: snapped,
        maxDays: snapped,
        termCounts: new Map(),
      };
      perVault.set(vault, v);
    }
    v.termCounts.set(snapped, (v.termCounts.get(snapped) ?? 0) + 1);
    v.sampleCount++;
    if (snapped < v.minDays) v.minDays = snapped;
    if (snapped > v.maxDays) v.maxDays = snapped;
  }

  // Compute mode per vault (largest count wins; tie → larger term wins so we
  // err on the conservative "loan still has time" side).
  perVault.forEach(v => {
    let bestN = 0;
    let bestDays = v.modeDays;
    v.termCounts.forEach((n, days) => {
      if (n > bestN || (n === bestN && days > bestDays)) {
        bestN = n;
        bestDays = days;
      }
    });
    v.modeDays = bestDays;
  });

  let globalMode: { modeDays: number; sampleCount: number } | null = null;
  if (globalCounts.size > 0) {
    let bestN = 0;
    let bestDays = 30;
    let total = 0;
    globalCounts.forEach((n, days) => {
      total += n;
      if (n > bestN || (n === bestN && days > bestDays)) {
        bestN = n;
        bestDays = days;
      }
    });
    globalMode = { modeDays: bestDays, sampleCount: total };
  }

  return { perVault, global: globalMode, builtAt: Date.now() };
}

function getStats(): StatsCache {
  if (!cache || Date.now() - cache.builtAt > CACHE_TTL_MS) {
    cache = buildStats();
  }
  return cache;
}

export function invalidateLoanExpirationCache(): void {
  cache = null;
}

// ---------- Public estimator ----------

export type LoanExpirationEstimate = {
  /** Unix seconds of the estimated expiration. */
  estimated_expiration_ts: number;
  /** Term length in days that the estimate assumes. */
  estimated_term_days: number;
  /** 'vault' = derived from this lender vault's prior defaults.
   *  'global' = no per-vault data, used the corpus-wide mode.
   *  'unknown' = no prior defaults at all (cold start). */
  estimated_basis: 'vault' | 'global' | 'unknown';
  /** Number of historical defaults backing the term choice. */
  estimated_sample_count: number;
  /** Min/max term observed for this vault (or globally if no vault data).
   *  Identical to estimated_term_days when there's a single sample. */
  estimated_term_min_days: number | null;
  estimated_term_max_days: number | null;
  /** `estimated_expiration_ts < server-now`. Stamped at estimate-build time
   *  so callers (server components) don't need to call Date.now() themselves —
   *  the React lint plugin flags impure calls inside component bodies. */
  is_overdue: boolean;
};

export function estimateLoanExpiration(input: {
  originationTs: number | null;
  lenderVault: string | null;
}): LoanExpirationEstimate | null {
  if (input.originationTs == null) return null;

  const stats = getStats();
  const v = input.lenderVault ? stats.perVault.get(input.lenderVault) : null;
  const nowSec = Math.floor(Date.now() / 1000);

  if (v && v.sampleCount > 0) {
    const ts = input.originationTs + v.modeDays * 86400;
    return {
      estimated_expiration_ts: ts,
      estimated_term_days: v.modeDays,
      estimated_basis: 'vault',
      estimated_sample_count: v.sampleCount,
      estimated_term_min_days: v.minDays,
      estimated_term_max_days: v.maxDays,
      is_overdue: ts < nowSec,
    };
  }

  if (stats.global) {
    const ts = input.originationTs + stats.global.modeDays * 86400;
    return {
      estimated_expiration_ts: ts,
      estimated_term_days: stats.global.modeDays,
      estimated_basis: 'global',
      estimated_sample_count: stats.global.sampleCount,
      estimated_term_min_days: null,
      estimated_term_max_days: null,
      is_overdue: ts < nowSec,
    };
  }

  const ts = input.originationTs + 30 * 86400;
  return {
    estimated_expiration_ts: ts,
    estimated_term_days: 30,
    estimated_basis: 'unknown',
    estimated_sample_count: 0,
    estimated_term_min_days: null,
    estimated_term_max_days: null,
    is_overdue: ts < nowSec,
  };
}

export const _internal = {
  parseModernDefaultLeafCsv,
  decodeCsvField,
  decodeTermDays,
  snapToMenu,
};
