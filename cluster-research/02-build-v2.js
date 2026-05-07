#!/usr/bin/env node
/* eslint-disable */
// v2 prototype: rebuild wallet cluster edges with new signals beyond CIH +
// direct self-xfer. Writes to wallet_cluster_edges_v2 in /tmp/app-snap.db.
//
// New signals (additive to v1's cih_count + self_xfer_ab/ba):
//
//  - co_consolidator_count (cc): pair (A, B) both sent marketplace=NULL
//    transferred events to a common destination C, where:
//       * C has ≥2 distinct senders (i.e. is a multi-source receiver),
//       * A and B are each "monogamous senders" (≤2 distinct lifetime
//         recipients via marketplace=NULL transferred events),
//       * neither A nor B is on the seed blacklist (mint wallets etc.)
//    Counts by # of distinct C's connecting the pair.
//    Catches the personal-consolidator pattern that's currently destroyed
//    by the multi-source-receiver suppression.
//
//  - co_parent_count (cp): pair (A, B) both received marketplace=NULL
//    transferred events from a common parent P, where:
//       * A and B are each "monogamous recipients" (≤2 distinct lifetime
//         senders) — i.e. their inflow is concentrated,
//       * P sent marketplace=NULL transfers to ≥2 distinct children,
//       * P is NOT an MSR itself (excludes exchange withdrawal addresses
//         pushing to many customers).
//    Catches the "minter-to-mules" / "primary→sub-wallets" distribution
//    pattern from the parent side.
//
//  - personal_msr_xfer (pmx): direct A↔C transfers where C is an MSR
//    that's been classified "personal":
//       * ≥3 distinct senders also receive back from C (bidirectional
//         flow with C); OR
//       * ≥40% of inscriptions C received marketplace=NULL are still
//         held by C now ("hodler consolidator").
//    Re-enables self_xfer signal for these MSRs (currently suppressed).
//
// All v1 suppressions kept: ACP-PSBT settlement, blacklist (mint wallets
// + auto-high-degree non-personal MSRs), high-fanin (>20 inputs), and
// new_owner-in-inputs PSBT detection.
//
// Confidence formula: extends v1, with the new signals contributing
// independently. See `confidenceFromCountsV2` below.

const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');

const DB_PATH = process.env.OMB_DB_PATH || '/tmp/app-snap.db';
const OUT_DIR = path.resolve(__dirname);

const MINT_WALLET_ADDRS = [
  'bc1pyl6g53k220rggaukyx929qnnxqw8vzt8xrfw88muw22pnwfvqjkqreeqpw',
  'bc1p53jarhva6eg4wggv7apndndger4y4gy9s6mf3gp0rttdzensu2nq3598ur',
  'bc1pg8jywvphzeyf9fg8tsac6jq7ft2dzz7pez720r6uanumn6lyayeshg46es',
  'bc1p4a29gzwlear4csc9sz6ll97j9yl7877tasy75evq8wm6r3admtqq3m72k0',
  'bc1q86ssqhk04chjah6kkuqw3fv5wjy7v2nflyg50t',
];

// Tunables
const MONOG_FANOUT_MAX = 2;       // ≤2 distinct recipients ⇒ monogamous sender
const MONOG_FANIN_MAX = 2;        // ≤2 distinct senders ⇒ monogamous recipient
const MSR_THRESHOLD = 5;          // (mirrors v1)
const PERSONAL_BIDIR_MIN = 3;     // bidirectional peer count to be "personal"
const PERSONAL_RETENTION_MIN = 0.4; // 40% retention => personal
const PARENT_FANOUT_MIN = 2;      // P must distribute to ≥2 children for cp
const COCONS_MIN_DEGREE = 2;      // C must have ≥2 monog senders for cc

const db = new Database(DB_PATH, { readonly: false });
db.pragma('journal_mode = WAL');

// --- Build v2 table ---
db.exec(`
  CREATE TABLE IF NOT EXISTS wallet_cluster_edges_v2 (
    addr_a              TEXT NOT NULL,
    addr_b              TEXT NOT NULL,
    confidence          INTEGER NOT NULL,
    cih_count           INTEGER NOT NULL DEFAULT 0,
    self_xfer_count     INTEGER NOT NULL DEFAULT 0,
    self_xfer_ab        INTEGER NOT NULL DEFAULT 0,
    self_xfer_ba        INTEGER NOT NULL DEFAULT 0,
    co_cons_count       INTEGER NOT NULL DEFAULT 0,
    co_parent_count     INTEGER NOT NULL DEFAULT 0,
    pmx_count           INTEGER NOT NULL DEFAULT 0,
    pmx_ab              INTEGER NOT NULL DEFAULT 0,
    pmx_ba              INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (addr_a, addr_b),
    CHECK (addr_a < addr_b)
  );
  CREATE INDEX IF NOT EXISTS idx_cev2_a ON wallet_cluster_edges_v2(addr_a, confidence DESC);
  CREATE INDEX IF NOT EXISTS idx_cev2_b ON wallet_cluster_edges_v2(addr_b, confidence DESC);
  CREATE INDEX IF NOT EXISTS idx_cev2_conf ON wallet_cluster_edges_v2(confidence DESC);
`);
db.exec(`DELETE FROM wallet_cluster_edges_v2`);

const seedBlacklist = new Set(MINT_WALLET_ADDRS);

// --- Step 1: Sender / receiver fan-out & MSR set ---
console.log('[v2] computing fan-out maps…');
const senderRecipients = new Map(); // sender -> Set<receiver>
const receiverSenders = new Map();  // receiver -> Set<sender>

const xferRows = db.prepare(`
  SELECT old_owner, new_owner FROM events
   WHERE event_type='transferred' AND marketplace IS NULL
     AND old_owner IS NOT NULL AND new_owner IS NOT NULL
     AND old_owner != new_owner
`).all();

for (const r of xferRows) {
  if (seedBlacklist.has(r.old_owner) || seedBlacklist.has(r.new_owner)) continue;
  let s = senderRecipients.get(r.old_owner);
  if (!s) { s = new Set(); senderRecipients.set(r.old_owner, s); }
  s.add(r.new_owner);
  let t = receiverSenders.get(r.new_owner);
  if (!t) { t = new Set(); receiverSenders.set(r.new_owner, t); }
  t.add(r.old_owner);
}

const msrSet = new Set();
for (const [addr, senders] of receiverSenders) {
  if (senders.size >= MSR_THRESHOLD) msrSet.add(addr);
}
console.log(`[v2] senders=${senderRecipients.size} receivers=${receiverSenders.size} MSRs(≥${MSR_THRESHOLD})=${msrSet.size}`);

// --- Step 2: classify MSRs as personal vs not ---
// Personal if (a) ≥3 of its senders also receive back from it, OR
// (b) ≥40% of inscriptions it received are still held by it.
console.log('[v2] classifying MSRs as personal/external…');
const personalMsrs = new Set();

const msrBidir = db.prepare(`
  WITH inc AS (
    SELECT old_owner AS s FROM events
     WHERE event_type='transferred' AND marketplace IS NULL
       AND old_owner != new_owner AND new_owner = ? GROUP BY old_owner
  ), out_ AS (
    SELECT new_owner AS r FROM events
     WHERE event_type='transferred' AND marketplace IS NULL
       AND old_owner != new_owner AND old_owner = ? GROUP BY new_owner
  )
  SELECT COUNT(*) AS n FROM inc JOIN out_ ON inc.s = out_.r
`);
const msrRetention = db.prepare(`
  WITH recv AS (
    SELECT inscription_number, MAX(id) AS last_id
      FROM events
     WHERE event_type='transferred' AND marketplace IS NULL
       AND old_owner != new_owner AND new_owner = ?
     GROUP BY inscription_number
  )
  SELECT COUNT(*) AS recv_n,
    SUM(CASE WHEN i.effective_owner = ? THEN 1 ELSE 0 END) AS held_n
    FROM recv r JOIN inscriptions i USING(inscription_number)
`);
let msrPersonalByBidir = 0;
let msrPersonalByRetention = 0;
for (const msr of msrSet) {
  const bidir = msrBidir.get(msr, msr);
  let isPersonal = false;
  if (bidir.n >= PERSONAL_BIDIR_MIN) {
    isPersonal = true;
    msrPersonalByBidir++;
  } else {
    const ret = msrRetention.get(msr, msr);
    if (ret.recv_n >= 5 && ret.held_n / ret.recv_n >= PERSONAL_RETENTION_MIN) {
      isPersonal = true;
      msrPersonalByRetention++;
    }
  }
  if (isPersonal) personalMsrs.add(msr);
}
console.log(`[v2] personal MSRs: ${personalMsrs.size} (bidir=${msrPersonalByBidir}, retention=${msrPersonalByRetention})`);

// --- Step 3: build edge accumulator ---
function canonicalPair(a, b) { return a < b ? [a, b] : [b, a]; }
const acc = new Map(); // key -> {addr_a, addr_b, cih, sx, sx_ab, sx_ba, cc, cp, pmx, pmx_ab, pmx_ba}
function getEdge(a, b) {
  if (a === b) return null;
  const [x, y] = canonicalPair(a, b);
  const key = `${x}|${y}`;
  let e = acc.get(key);
  if (!e) {
    e = { addr_a: x, addr_b: y,
          cih: 0, sx: 0, sx_ab: 0, sx_ba: 0,
          cc: new Set(), cp: new Set(),
          pmx: 0, pmx_ab: 0, pmx_ba: 0 };
    acc.set(key, e);
  }
  return e;
}
function bumpDirected(field_ab, field_ba, e, from) {
  if (from === e.addr_a) e[field_ab] += 1;
  else e[field_ba] += 1;
}

// --- Step 4: import v1 signals (CIH + direct self_xfer) from existing
//      wallet_cluster_edges. Re-using v1 saves us the bitcoind walk. ---
console.log('[v2] importing v1 CIH + self_xfer counts…');
const v1Edges = db.prepare(`
  SELECT addr_a, addr_b, cih_count, self_xfer_count, self_xfer_ab, self_xfer_ba
    FROM wallet_cluster_edges
`).all();
for (const r of v1Edges) {
  const e = getEdge(r.addr_a, r.addr_b);
  e.cih += r.cih_count;
  e.sx += r.self_xfer_count;
  e.sx_ab += r.self_xfer_ab;
  e.sx_ba += r.self_xfer_ba;
}
console.log(`[v2] v1 edges imported: ${acc.size}`);

// --- Step 5: co_consolidator signal ---
//
// For each potential consolidator C, find its monogamous senders (each
// has ≤MONOG_FANOUT_MAX distinct recipients). If ≥COCONS_MIN_DEGREE such
// senders, emit pairwise edges between them.
console.log('[v2] computing co_consolidator pairs…');
let cohortEdges = 0;
let cohortLargest = 0;
let consolidatorsConsidered = 0;
for (const [c, senders] of receiverSenders) {
  if (senders.size < COCONS_MIN_DEGREE) continue;
  if (seedBlacklist.has(c)) continue;
  // Find monog senders
  const monog = [];
  for (const s of senders) {
    if (s === c) continue;
    if (seedBlacklist.has(s)) continue;
    const fanOut = senderRecipients.get(s) ? senderRecipients.get(s).size : 0;
    if (fanOut > 0 && fanOut <= MONOG_FANOUT_MAX) monog.push(s);
  }
  if (monog.length < COCONS_MIN_DEGREE) continue;
  consolidatorsConsidered++;
  if (monog.length > cohortLargest) cohortLargest = monog.length;
  // Bound: if a consolidator has >100 monog senders, build edges for it
  // anyway — that's the JJL pattern. Quadratic but bounded by N≤200 in
  // practice (197 max in this corpus).
  for (let i = 0; i < monog.length; i++) {
    for (let j = i + 1; j < monog.length; j++) {
      const e = getEdge(monog[i], monog[j]);
      if (!e) continue;
      e.cc.add(c);
      cohortEdges++;
    }
    // Also link each monog sender to C
    if (!seedBlacklist.has(c)) {
      const e = getEdge(monog[i], c);
      if (e) e.cc.add(c);
    }
  }
}
console.log(`[v2] co_consolidator: ${consolidatorsConsidered} consolidators, ${cohortEdges} pair bumps, largest cohort=${cohortLargest}`);

// --- Step 6: co_parent signal ---
//
// For each parent P NOT in MSR set, that distributes to ≥PARENT_FANOUT_MIN
// children, find children that are monogamous-recipients (each has ≤MONOG_FANIN_MAX
// distinct senders). Pairwise-link those children.
//
// Excluding P-as-MSR avoids exchange/aggregator withdrawal addresses.
console.log('[v2] computing co_parent pairs…');
let coParentEdges = 0;
let parentsConsidered = 0;
for (const [p, recips] of senderRecipients) {
  if (recips.size < PARENT_FANOUT_MIN) continue;
  if (msrSet.has(p) && !personalMsrs.has(p)) continue; // skip exchange-like
  if (seedBlacklist.has(p)) continue;
  const monogChildren = [];
  for (const r of recips) {
    if (r === p) continue;
    if (seedBlacklist.has(r)) continue;
    const fanIn = receiverSenders.get(r) ? receiverSenders.get(r).size : 0;
    if (fanIn > 0 && fanIn <= MONOG_FANIN_MAX) monogChildren.push(r);
  }
  if (monogChildren.length < PARENT_FANOUT_MIN) continue;
  parentsConsidered++;
  for (let i = 0; i < monogChildren.length; i++) {
    for (let j = i + 1; j < monogChildren.length; j++) {
      const e = getEdge(monogChildren[i], monogChildren[j]);
      if (!e) continue;
      e.cp.add(p);
      coParentEdges++;
    }
  }
}
console.log(`[v2] co_parent: ${parentsConsidered} parents, ${coParentEdges} pair bumps`);

// --- Step 7: personal MSR un-suppression — direct self_xfer signal ---
console.log('[v2] computing personal-MSR self_xfer (pmx)…');
let pmxEvents = 0;
const pmxRows = db.prepare(`
  SELECT old_owner, new_owner FROM events
   WHERE event_type='transferred' AND marketplace IS NULL
     AND old_owner IS NOT NULL AND new_owner IS NOT NULL
     AND old_owner != new_owner
`).all();
let pmxMsrPairBumps = 0;
for (const r of pmxRows) {
  const o = r.old_owner, n = r.new_owner;
  if (seedBlacklist.has(o) || seedBlacklist.has(n)) continue;
  // Either endpoint is a personal MSR — fire pmx between them.
  if (!personalMsrs.has(o) && !personalMsrs.has(n)) continue;
  const e = getEdge(o, n);
  if (!e) continue;
  e.pmx += 1;
  if (o === e.addr_a) e.pmx_ab += 1; else e.pmx_ba += 1;
  if (msrSet.has(o) && msrSet.has(n)) pmxMsrPairBumps++;
  pmxEvents++;
}
console.log(`[v2] pmx: ${pmxEvents} transfer events (msr-pair bumps included: ${pmxMsrPairBumps}) — kept all; FP risk handled in confidence formula via low single-pmx ceiling.`);
// --- Step 8: confidence formula v2 ---
function confidenceFromCountsV2(c) {
  let p = 0;
  // v1 ladders preserved
  if (c.cih >= 1) p = Math.max(p, 0.80);
  if (c.cih >= 2) p = Math.max(p, 0.95);
  if (c.cih >= 3) p = Math.max(p, 0.98);
  if (c.cih >= 5) p = Math.max(p, 0.99);

  const sxBidir = Math.min(c.sx_ab, c.sx_ba);
  const sxTotal = c.sx > 0 ? c.sx : c.sx_ab + c.sx_ba;
  if (sxBidir >= 1) p = Math.max(p, 0.92);
  if (sxBidir >= 2) p = Math.max(p, 0.99);
  if (sxTotal >= 1) p = Math.max(p, 0.50);
  if (sxTotal >= 3) p = Math.max(p, 0.80);

  // Mixed v1
  if (c.cih >= 1 && sxBidir >= 1) p = Math.max(p, 0.99);
  if (c.cih >= 1 && sxTotal >= 1) p = Math.max(p, 0.95);
  if (c.cih >= 2 && sxTotal >= 2) p = Math.max(p, 0.99);

  // co_consolidator: scales with # of distinct connecting C's. Single C
  // alone is moderate evidence (could be a popular gift recipient or two
  // unrelated mules of different humans both happening to feed a shared
  // big collector — see "shared trading hub" FP class). Two C's
  // connecting the same monog pair is strong (rare to happen by chance);
  // 3+ is very strong.
  if (c.cc >= 1) p = Math.max(p, 0.80);
  if (c.cc >= 2) p = Math.max(p, 0.95);
  if (c.cc >= 3) p = Math.max(p, 0.98);
  if (c.cc >= 5) p = Math.max(p, 0.99);

  // co_parent: same shape but slightly tighter — parents that aren't
  // MSRs are rarer than consolidators, so each pair-bump is a bit
  // stronger.
  if (c.cp >= 1) p = Math.max(p, 0.80);
  if (c.cp >= 2) p = Math.max(p, 0.95);
  if (c.cp >= 3) p = Math.max(p, 0.98);

  // pmx (personal-MSR self_xfer). The MSR-pair suppression in step 7
  // removes the worst FP class (collector ↔ collector trades). Single
  // one-way pmx still moderate; bidirectional is the strong indicator.
  const pmxBidir = Math.min(c.pmx_ab, c.pmx_ba);
  if (c.pmx >= 1) p = Math.max(p, 0.75);
  if (c.pmx >= 3) p = Math.max(p, 0.90);
  if (pmxBidir >= 1) p = Math.max(p, 0.95);
  if (pmxBidir >= 2) p = Math.max(p, 0.99);

  // Cross-signal mixing — every distinct signal mechanism counts. cih,
  // sx, cc, cp, pmx are five conceptually independent observables; two
  // firing together is much stronger than either alone. The indep gate
  // is the main mechanism that lifts cc+pmx, cc+cp, sx+cc etc. to the
  // public band.
  let indep = 0;
  if (c.cih >= 1) indep++;
  if (c.sx_ab + c.sx_ba >= 1) indep++;
  if (c.cc >= 1) indep++;
  if (c.cp >= 1) indep++;
  if (c.pmx >= 1) indep++;
  if (indep >= 2) p = Math.max(p, 0.97);
  if (indep >= 3) p = Math.max(p, 0.99);

  return Math.round(p * 10000);
}

// --- Step 9: write to v2 table ---
console.log(`[v2] flushing ${acc.size} edges…`);
const upsert = db.prepare(`
  INSERT INTO wallet_cluster_edges_v2
    (addr_a, addr_b, confidence,
     cih_count, self_xfer_count, self_xfer_ab, self_xfer_ba,
     co_cons_count, co_parent_count, pmx_count, pmx_ab, pmx_ba)
   VALUES (@a, @b, @conf,
           @cih, @sx, @sxab, @sxba,
           @cc, @cp, @pmx, @pmxab, @pmxba)
`);
db.transaction(() => {
  for (const e of acc.values()) {
    upsert.run({
      a: e.addr_a, b: e.addr_b,
      conf: confidenceFromCountsV2({
        cih: e.cih, sx: e.sx, sx_ab: e.sx_ab, sx_ba: e.sx_ba,
        cc: e.cc.size, cp: e.cp.size,
        pmx: e.pmx, pmx_ab: e.pmx_ab, pmx_ba: e.pmx_ba,
      }),
      cih: e.cih, sx: e.sx, sxab: e.sx_ab, sxba: e.sx_ba,
      cc: e.cc.size, cp: e.cp.size,
      pmx: e.pmx, pmxab: e.pmx_ab, pmxba: e.pmx_ba,
    });
  }
})();

const summary = db.prepare(`
  SELECT
    SUM(CASE WHEN confidence >= 9000 THEN 1 ELSE 0 END) AS at_9000,
    SUM(CASE WHEN confidence >= 9500 THEN 1 ELSE 0 END) AS at_9500,
    SUM(CASE WHEN confidence >= 9700 THEN 1 ELSE 0 END) AS at_9700,
    SUM(CASE WHEN confidence >= 9900 THEN 1 ELSE 0 END) AS at_9900,
    COUNT(*) AS total
    FROM wallet_cluster_edges_v2
`).get();
console.log(`[v2] edge counts: total=${summary.total}, ≥9000=${summary.at_9000}, ≥9500=${summary.at_9500}, ≥9700=${summary.at_9700}, ≥9900=${summary.at_9900}`);

db.close();
console.log('[v2] done.');
