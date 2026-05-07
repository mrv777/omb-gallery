#!/usr/bin/env node
/* eslint-disable */
// v3 prototype: replace `pmx` with `pmx_rt` (round-trip pmx) — the
// subset of personal-MSR self_xfer events where the RECEIVING wallet
// previously owned the inscription. Empirically (08-deeper-analysis):
// cross-trader pmx round-trips ~10% of the time; same-human pmx
// round-trips ~47%. The signal is structural — no Matrica needed.
//
// Same is applied to direct self_xfer (the v1 signal): split into
// sx_rt (round-trip) and sx_total. v1 didn't have an FP problem at 9900
// in self_xfer, but the round-trip split still informs the formula.
//
// Writes to wallet_cluster_edges_v3 in the working snapshot copy.

const Database = require('better-sqlite3');
const DB_PATH = process.env.OMB_DB_PATH || '/tmp/app-v2.db';

const MINT_WALLET_ADDRS = [
  'bc1pyl6g53k220rggaukyx929qnnxqw8vzt8xrfw88muw22pnwfvqjkqreeqpw',
  'bc1p53jarhva6eg4wggv7apndndger4y4gy9s6mf3gp0rttdzensu2nq3598ur',
  'bc1pg8jywvphzeyf9fg8tsac6jq7ft2dzz7pez720r6uanumn6lyayeshg46es',
  'bc1p4a29gzwlear4csc9sz6ll97j9yl7877tasy75evq8wm6r3admtqq3m72k0',
  'bc1q86ssqhk04chjah6kkuqw3fv5wjy7v2nflyg50t',
];

const MONOG_FANOUT_MAX = 2;
const MONOG_FANIN_MAX = 2;
const MSR_THRESHOLD = 5;
const PERSONAL_BIDIR_MIN = 3;
const PERSONAL_RETENTION_MIN = 0.4;
const PARENT_FANOUT_MIN = 2;
const COCONS_MIN_DEGREE = 2;

const db = new Database(DB_PATH, { readonly: false });
db.exec(`
  DROP TABLE IF EXISTS wallet_cluster_edges_v3;
  CREATE TABLE wallet_cluster_edges_v3 (
    addr_a              TEXT NOT NULL,
    addr_b              TEXT NOT NULL,
    confidence          INTEGER NOT NULL,
    cih_count           INTEGER NOT NULL DEFAULT 0,
    self_xfer_count     INTEGER NOT NULL DEFAULT 0,
    self_xfer_ab        INTEGER NOT NULL DEFAULT 0,
    self_xfer_ba        INTEGER NOT NULL DEFAULT 0,
    sx_rt_count         INTEGER NOT NULL DEFAULT 0,
    sx_rt_ab            INTEGER NOT NULL DEFAULT 0,
    sx_rt_ba            INTEGER NOT NULL DEFAULT 0,
    co_cons_count       INTEGER NOT NULL DEFAULT 0,
    co_parent_count     INTEGER NOT NULL DEFAULT 0,
    pmx_count           INTEGER NOT NULL DEFAULT 0,
    pmx_ab              INTEGER NOT NULL DEFAULT 0,
    pmx_ba              INTEGER NOT NULL DEFAULT 0,
    pmx_rt_count        INTEGER NOT NULL DEFAULT 0,
    pmx_rt_ab           INTEGER NOT NULL DEFAULT 0,
    pmx_rt_ba           INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (addr_a, addr_b),
    CHECK (addr_a < addr_b)
  );
  CREATE INDEX idx_cev3_a ON wallet_cluster_edges_v3(addr_a, confidence DESC);
  CREATE INDEX idx_cev3_conf ON wallet_cluster_edges_v3(confidence DESC);
`);

const seedBlacklist = new Set(MINT_WALLET_ADDRS);

console.log('[v3] computing fan-out maps…');
const xferRows = db.prepare(`
  SELECT id, inscription_number, old_owner, new_owner, txid, block_timestamp FROM events
   WHERE event_type='transferred' AND marketplace IS NULL
     AND old_owner IS NOT NULL AND new_owner IS NOT NULL AND old_owner != new_owner
   ORDER BY id ASC
`).all();
const senderRecv = new Map();
const recvSender = new Map();
for (const r of xferRows) {
  if (seedBlacklist.has(r.old_owner) || seedBlacklist.has(r.new_owner)) continue;
  let s = senderRecv.get(r.old_owner); if (!s) { s = new Set(); senderRecv.set(r.old_owner, s); } s.add(r.new_owner);
  let t = recvSender.get(r.new_owner); if (!t) { t = new Set(); recvSender.set(r.new_owner, t); } t.add(r.old_owner);
}
const msrSet = new Set();
for (const [a, set] of recvSender) if (set.size >= MSR_THRESHOLD) msrSet.add(a);

// Personal-MSR classification
console.log('[v3] classifying personal MSRs…');
const personalMsr = new Set();
const msrRetention = db.prepare(`
  WITH recv AS (
    SELECT DISTINCT inscription_number FROM events
     WHERE event_type='transferred' AND marketplace IS NULL
       AND old_owner != new_owner AND new_owner = ?
  )
  SELECT COUNT(*) AS recv_n,
    SUM(CASE WHEN i.effective_owner = ? THEN 1 ELSE 0 END) AS held_n
    FROM recv r JOIN inscriptions i USING(inscription_number)
`);
for (const c of msrSet) {
  const senders = recvSender.get(c) || new Set();
  let bidir = 0;
  for (const s of senders) if ((senderRecv.get(c) || new Set()).has(s)) bidir++;
  if (bidir >= PERSONAL_BIDIR_MIN) { personalMsr.add(c); continue; }
  const ret = msrRetention.get(c, c);
  if (ret.recv_n >= 5 && ret.held_n / ret.recv_n >= PERSONAL_RETENTION_MIN) personalMsr.add(c);
}
console.log(`[v3] msrSet=${msrSet.size} personalMsr=${personalMsr.size}`);

// Build round-trip lookup for transferred events.
// For each (id, inscription_number, new_owner), did new_owner own this
// inscription before this id?
console.log('[v3] computing round-trip flags per transferred event…');
// Pre-compute per-inscription event timeline of ownership changes.
const inscEvents = new Map(); // inscription_number -> [{id, new_owner, type}]
for (const e of db.prepare(`
  SELECT id, inscription_number, new_owner, event_type FROM events
   WHERE new_owner IS NOT NULL ORDER BY id ASC
`).all()) {
  let arr = inscEvents.get(e.inscription_number);
  if (!arr) { arr = []; inscEvents.set(e.inscription_number, arr); }
  arr.push(e);
}
function isRoundTrip(insc, beforeId, who) {
  const arr = inscEvents.get(insc);
  if (!arr) return false;
  for (const ev of arr) {
    if (ev.id >= beforeId) break;
    if (ev.new_owner === who) return true;
  }
  return false;
}

// Build edge accumulator
function canon(a, b) { return a < b ? [a, b] : [b, a]; }
const acc = new Map();
function getEdge(a, b) {
  if (a === b) return null;
  const [x, y] = canon(a, b);
  const key = `${x}|${y}`;
  let e = acc.get(key);
  if (!e) {
    e = { addr_a: x, addr_b: y,
      cih: 0, sx: 0, sx_ab: 0, sx_ba: 0,
      sx_rt: 0, sx_rt_ab: 0, sx_rt_ba: 0,
      cc: new Set(), cp: new Set(),
      pmx: 0, pmx_ab: 0, pmx_ba: 0,
      pmx_rt: 0, pmx_rt_ab: 0, pmx_rt_ba: 0 };
    acc.set(key, e);
  }
  return e;
}

// Import v1 CIH (untouched) + sx (we re-build sx_rt here)
console.log('[v3] importing v1 CIH from existing edges + recomputing sx with rt flag…');
for (const r of db.prepare(`SELECT addr_a, addr_b, cih_count FROM wallet_cluster_edges`).all()) {
  const e = getEdge(r.addr_a, r.addr_b); if (!e) continue;
  e.cih += r.cih_count;
}

// Self-transfer chain (v1 logic) — also stamp round-trip flag
let sxFires = 0, sxRt = 0;
const multiSourceReceivers = new Set(msrSet); // v1 logic suppresses sx via these
for (const r of xferRows) {
  if (seedBlacklist.has(r.old_owner) || seedBlacklist.has(r.new_owner)) continue;
  if (multiSourceReceivers.has(r.old_owner) || multiSourceReceivers.has(r.new_owner)) continue;
  const e = getEdge(r.old_owner, r.new_owner); if (!e) continue;
  e.sx += 1;
  const rt = isRoundTrip(r.inscription_number, r.id, r.new_owner);
  if (rt) { e.sx_rt += 1; sxRt++; }
  if (r.old_owner === e.addr_a) {
    e.sx_ab += 1;
    if (rt) e.sx_rt_ab += 1;
  } else {
    e.sx_ba += 1;
    if (rt) e.sx_rt_ba += 1;
  }
  sxFires++;
}
console.log(`[v3] sx events: ${sxFires}, of which round-trip: ${sxRt} (${(sxRt/sxFires*100).toFixed(1)}%)`);

// co_consolidator (unchanged)
console.log('[v3] cc…');
let ccB = 0;
for (const [c, senders] of recvSender) {
  if (senders.size < COCONS_MIN_DEGREE) continue;
  if (seedBlacklist.has(c)) continue;
  const monog = [];
  for (const s of senders) {
    if (s === c || seedBlacklist.has(s)) continue;
    const fan = senderRecv.get(s) ? senderRecv.get(s).size : 0;
    if (fan >= 1 && fan <= MONOG_FANOUT_MAX) monog.push(s);
  }
  if (monog.length < COCONS_MIN_DEGREE) continue;
  for (let i = 0; i < monog.length; i++) {
    for (let j = i + 1; j < monog.length; j++) {
      const e = getEdge(monog[i], monog[j]); if (!e) continue;
      e.cc.add(c); ccB++;
    }
    const e2 = getEdge(monog[i], c); if (e2) e2.cc.add(c);
  }
}
console.log(`[v3] cc bumps: ${ccB}`);

// co_parent (unchanged)
console.log('[v3] cp…');
let cpB = 0;
for (const [p, recips] of senderRecv) {
  if (recips.size < PARENT_FANOUT_MIN) continue;
  if (msrSet.has(p) && !personalMsr.has(p)) continue;
  if (seedBlacklist.has(p)) continue;
  const monog = [];
  for (const r of recips) {
    if (r === p || seedBlacklist.has(r)) continue;
    const fan = recvSender.get(r) ? recvSender.get(r).size : 0;
    if (fan >= 1 && fan <= MONOG_FANIN_MAX) monog.push(r);
  }
  if (monog.length < PARENT_FANOUT_MIN) continue;
  for (let i = 0; i < monog.length; i++) {
    for (let j = i + 1; j < monog.length; j++) {
      const e = getEdge(monog[i], monog[j]); if (!e) continue;
      e.cp.add(p); cpB++;
    }
  }
}
console.log(`[v3] cp bumps: ${cpB}`);

// pmx with round-trip flag
console.log('[v3] pmx (with round-trip flag)…');
let pmxFires = 0, pmxRt = 0;
for (const r of xferRows) {
  const o = r.old_owner, n = r.new_owner;
  if (seedBlacklist.has(o) || seedBlacklist.has(n)) continue;
  if (!personalMsr.has(o) && !personalMsr.has(n)) continue;
  const e = getEdge(o, n); if (!e) continue;
  e.pmx += 1;
  const rt = isRoundTrip(r.inscription_number, r.id, n);
  if (rt) { e.pmx_rt += 1; pmxRt++; }
  if (o === e.addr_a) {
    e.pmx_ab += 1;
    if (rt) e.pmx_rt_ab += 1;
  } else {
    e.pmx_ba += 1;
    if (rt) e.pmx_rt_ba += 1;
  }
  pmxFires++;
}
console.log(`[v3] pmx events: ${pmxFires}, of which round-trip: ${pmxRt} (${pmxFires ? (pmxRt/pmxFires*100).toFixed(1) : 0}%)`);

// === Confidence formula v3 ===
// Idea: round-trip evidence is the "strong" path; non-round-trip pmx
// gives only weak signal. Single one-way cross-trader pmx no longer
// reaches 9700 even with cc=1.
function confV3(c) {
  let p = 0;
  if (c.cih >= 1) p = Math.max(p, 0.80);
  if (c.cih >= 2) p = Math.max(p, 0.95);
  if (c.cih >= 3) p = Math.max(p, 0.98);
  if (c.cih >= 5) p = Math.max(p, 0.99);

  // sx — keep v1 ladder using TOTAL sx counts (these aren't where the
  // FPs live; round-trip subset is informational only for now)
  const sxBidir = Math.min(c.sx_ab, c.sx_ba);
  const sxTotal = c.sx > 0 ? c.sx : c.sx_ab + c.sx_ba;
  if (sxBidir >= 1) p = Math.max(p, 0.92);
  if (sxBidir >= 2) p = Math.max(p, 0.99);
  if (sxTotal >= 1) p = Math.max(p, 0.50);
  if (sxTotal >= 3) p = Math.max(p, 0.80);
  if (c.cih >= 1 && sxBidir >= 1) p = Math.max(p, 0.99);
  if (c.cih >= 1 && sxTotal >= 1) p = Math.max(p, 0.95);
  if (c.cih >= 2 && sxTotal >= 2) p = Math.max(p, 0.99);

  // cc / cp ladders unchanged
  if (c.cc >= 1) p = Math.max(p, 0.80);
  if (c.cc >= 2) p = Math.max(p, 0.95);
  if (c.cc >= 3) p = Math.max(p, 0.98);
  if (c.cc >= 5) p = Math.max(p, 0.99);
  if (c.cp >= 1) p = Math.max(p, 0.80);
  if (c.cp >= 2) p = Math.max(p, 0.95);
  if (c.cp >= 3) p = Math.max(p, 0.98);

  // pmx round-trip ladder — DOMINANT pmx tier
  const pmxRtBidir = Math.min(c.pmx_rt_ab, c.pmx_rt_ba);
  if (c.pmx_rt >= 1) p = Math.max(p, 0.85);
  if (c.pmx_rt >= 3) p = Math.max(p, 0.95);
  if (pmxRtBidir >= 1) p = Math.max(p, 0.97);
  if (pmxRtBidir >= 2) p = Math.max(p, 0.99);

  // pmx without round-trip is much weaker (cross-trader risk)
  // Total pmx caps at 0.70 alone, regardless of count or directionality.
  // Bidirectional pmx without round-trip is suspect (active P2P trader).
  if (c.pmx >= 1) p = Math.max(p, 0.60);
  if (c.pmx >= 5) p = Math.max(p, 0.70);

  // Cross-mechanism bonus — only counts pmx if there's at least 1 round-trip
  let indep = 0;
  if (c.cih >= 1) indep++;
  if (c.sx_ab + c.sx_ba >= 1) indep++;
  if (c.cc >= 1) indep++;
  if (c.cp >= 1) indep++;
  if (c.pmx_rt >= 1) indep++;     // CHANGED — was c.pmx >= 1 in v2
  if (indep >= 2) p = Math.max(p, 0.97);
  if (indep >= 3) p = Math.max(p, 0.99);
  return Math.round(p * 10000);
}

// Persist
const upsert = db.prepare(`
  INSERT INTO wallet_cluster_edges_v3
    (addr_a, addr_b, confidence,
     cih_count, self_xfer_count, self_xfer_ab, self_xfer_ba,
     sx_rt_count, sx_rt_ab, sx_rt_ba,
     co_cons_count, co_parent_count,
     pmx_count, pmx_ab, pmx_ba,
     pmx_rt_count, pmx_rt_ab, pmx_rt_ba)
  VALUES (@a,@b,@conf,@cih,@sx,@sxab,@sxba,@sxrt,@sxrtab,@sxrtba,@cc,@cp,@pmx,@pmxab,@pmxba,@pmxrt,@pmxrtab,@pmxrtba)
`);
db.transaction(() => {
  for (const e of acc.values()) {
    const conf = confV3({
      cih: e.cih, sx: e.sx, sx_ab: e.sx_ab, sx_ba: e.sx_ba,
      cc: e.cc.size, cp: e.cp.size,
      pmx: e.pmx, pmx_ab: e.pmx_ab, pmx_ba: e.pmx_ba,
      pmx_rt: e.pmx_rt, pmx_rt_ab: e.pmx_rt_ab, pmx_rt_ba: e.pmx_rt_ba,
    });
    upsert.run({
      a: e.addr_a, b: e.addr_b, conf,
      cih: e.cih, sx: e.sx, sxab: e.sx_ab, sxba: e.sx_ba,
      sxrt: e.sx_rt, sxrtab: e.sx_rt_ab, sxrtba: e.sx_rt_ba,
      cc: e.cc.size, cp: e.cp.size,
      pmx: e.pmx, pmxab: e.pmx_ab, pmxba: e.pmx_ba,
      pmxrt: e.pmx_rt, pmxrtab: e.pmx_rt_ab, pmxrtba: e.pmx_rt_ba,
    });
  }
})();

const sum = db.prepare(`
  SELECT
    SUM(CASE WHEN confidence>=9000 THEN 1 ELSE 0 END) AS at_9000,
    SUM(CASE WHEN confidence>=9500 THEN 1 ELSE 0 END) AS at_9500,
    SUM(CASE WHEN confidence>=9700 THEN 1 ELSE 0 END) AS at_9700,
    SUM(CASE WHEN confidence>=9900 THEN 1 ELSE 0 END) AS at_9900,
    COUNT(*) AS total FROM wallet_cluster_edges_v3
`).get();
console.log(`[v3] edges: total=${sum.total} ≥9000=${sum.at_9000} ≥9500=${sum.at_9500} ≥9700=${sum.at_9700} ≥9900=${sum.at_9900}`);

db.close();
