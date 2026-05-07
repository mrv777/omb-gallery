#!/usr/bin/env node
/* eslint-disable */
// Deeper structural analysis of v2 false positives — look for a tighter
// signal that tells "same-human two hubs" apart from "two-collector
// trading partners" without just suppressing whole signal classes.
//
// Hypotheses examined:
//
//   H1: Same-human two-MSRs share many monog sub-wallets (a sub-wallet
//       sends to BOTH hubs). Cross-trader pairs share ~0-1 by chance.
//       Test: for each FP and TP at 9500+, count shared-monog-sender.
//
//   H2: Cross-trader transfers don't return — the inscription enters
//       the OTHER collector's ecosystem and stays / gets resold. Same-
//       human transfers either stay within cluster, or the collected
//       inscription was previously held by the destination (round-trip).
//       Test: for each pmx event A→B, did B ever own that inscription
//       before this event?
//
//   H3: cc-via-non-personal-MSR consolidator: cc fires on a "popular
//       trading hub" rather than a true consolidator. Test: of FPs
//       with cc≥1, how many cc bridges go through a personal-MSR-
//       classified hub vs a non-personal one?

const Database = require('better-sqlite3');
const DB_PATH = process.env.OMB_DB_PATH || '/tmp/app-v2.db';
const db = new Database(DB_PATH, { readonly: false });

function isAutoShellUsername(u) {
  if (!u) return true;
  if (/^bc1[a-z0-9]{20,}/i.test(u)) return true;
  if (/^0x[a-fA-F0-9]{40}/.test(u)) return true;
  return false;
}

const links = db.prepare(`
  SELECT wl.wallet_addr, wl.matrica_user_id, mu.username
    FROM wallet_links wl LEFT JOIN matrica_users mu ON mu.user_id = wl.matrica_user_id
   WHERE wl.matrica_user_id IS NOT NULL
`).all();
const walletToUser = new Map();
const autoShellUsers = new Set();
const userInfo = new Map();
for (const r of links) {
  walletToUser.set(r.wallet_addr, r.matrica_user_id);
  userInfo.set(r.matrica_user_id, { username: r.username });
  if (isAutoShellUsername(r.username)) autoShellUsers.add(r.matrica_user_id);
}

// Build sender→recipients fan-out and the monog set
const xfer = db.prepare(`
  SELECT old_owner AS s, new_owner AS r FROM events
   WHERE event_type='transferred' AND marketplace IS NULL
     AND old_owner IS NOT NULL AND new_owner IS NOT NULL AND old_owner != new_owner
`).all();
const senderToReceivers = new Map();
const receiverToSenders = new Map();
for (const e of xfer) {
  let s = senderToReceivers.get(e.s); if (!s) { s = new Set(); senderToReceivers.set(e.s, s); } s.add(e.r);
  let t = receiverToSenders.get(e.r); if (!t) { t = new Set(); receiverToSenders.set(e.r, t); } t.add(e.s);
}
const MSR = new Set();
for (const [a, set] of receiverToSenders) if (set.size >= 5) MSR.add(a);
const MONOG = new Set();
for (const [a, set] of senderToReceivers) if (set.size <= 2 && set.size >= 1) MONOG.add(a);

// Personal-MSR re-classification (mirror)
const personalMSR = new Set();
{
  for (const c of MSR) {
    // bidir: # senders that also receive from c
    const senders = receiverToSenders.get(c) || new Set();
    let bidir = 0;
    for (const s of senders) {
      if ((senderToReceivers.get(c) || new Set()).has(s)) bidir++;
    }
    if (bidir >= 3) { personalMSR.add(c); continue; }
    // retention: held / received fraction
    const recvN = senders.size; // proxy: # distinct senders
    if (recvN < 5) continue;
    const heldNow = db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT DISTINCT inscription_number FROM events
         WHERE event_type='transferred' AND marketplace IS NULL
           AND old_owner != new_owner AND new_owner=?
      ) recv JOIN inscriptions i USING(inscription_number) WHERE i.effective_owner=?
    `).get(c, c).n;
    const recvDistinct = db.prepare(`
      SELECT COUNT(DISTINCT inscription_number) AS n FROM events
       WHERE event_type='transferred' AND marketplace IS NULL
         AND old_owner != new_owner AND new_owner=?
    `).get(c).n;
    if (recvDistinct >= 5 && heldNow / recvDistinct >= 0.4) personalMSR.add(c);
  }
}
console.log(`MSR=${MSR.size} personalMSR=${personalMSR.size} monog=${MONOG.size}`);

// Pull all v2 edges ≥9500 and bucket by Matrica truth.
const edges = db.prepare(`
  SELECT addr_a, addr_b, confidence, cih_count, self_xfer_count, self_xfer_ab, self_xfer_ba,
         co_cons_count, co_parent_count, pmx_count, pmx_ab, pmx_ba
    FROM wallet_cluster_edges_v2 WHERE confidence >= 9500
`).all();

function classify(e) {
  const ua = walletToUser.get(e.addr_a);
  const ub = walletToUser.get(e.addr_b);
  if (ua && ub) {
    if (ua === ub) return 'tp';
    if (autoShellUsers.has(ua) || autoShellUsers.has(ub)) return 'auto';
    return 'fp';
  }
  return 'unk';
}

const tpList = [], fpList = [];
for (const e of edges) {
  const c = classify(e);
  if (c === 'tp') tpList.push(e);
  else if (c === 'fp') fpList.push(e);
}
console.log(`At 9500: tp=${tpList.length} fp=${fpList.length}`);

// === H1: shared-monog-sender count between endpoints ===
// For each pair, |senders(A) ∩ senders(B)| restricted to MONOG senders
function sharedMonogSenders(a, b) {
  const sa = receiverToSenders.get(a); const sb = receiverToSenders.get(b);
  if (!sa || !sb) return 0;
  const small = sa.size < sb.size ? sa : sb;
  const big = sa.size < sb.size ? sb : sa;
  let n = 0;
  for (const x of small) if (big.has(x) && MONOG.has(x)) n++;
  return n;
}

function bucket(n) {
  if (n === 0) return '0';
  if (n === 1) return '1';
  if (n <= 3) return '2-3';
  if (n <= 10) return '4-10';
  return '11+';
}

console.log('\n=== H1: shared-monog-senders distribution ===');
const tpDist = {}; const fpDist = {};
for (const e of tpList) {
  const k = bucket(sharedMonogSenders(e.addr_a, e.addr_b));
  tpDist[k] = (tpDist[k] || 0) + 1;
}
for (const e of fpList) {
  const k = bucket(sharedMonogSenders(e.addr_a, e.addr_b));
  fpDist[k] = (fpDist[k] || 0) + 1;
}
console.log('| shared | TP | FP |');
console.log('|--------|----|----|');
for (const k of ['0','1','2-3','4-10','11+']) {
  console.log(`| ${k} | ${tpDist[k]||0} | ${fpDist[k]||0} |`);
}

// === H2: pmx-event return-flow check ===
// For each pmx-touching FP edge, are the inscriptions that A→B'd
// previously owned by B?  vs TP equivalents.
function pmxReturnRate(a, b) {
  // For each marketplace=NULL transferred event A→B, count whether B previously owned that inscription_number
  const evs = db.prepare(`
    SELECT inscription_number, id, block_timestamp FROM events
     WHERE event_type='transferred' AND marketplace IS NULL
       AND old_owner=? AND new_owner=?
  `).all(a, b);
  if (evs.length === 0) return null;
  let returned = 0;
  for (const e of evs) {
    const prev = db.prepare(`
      SELECT 1 FROM events WHERE inscription_number=? AND id < ? AND new_owner=? LIMIT 1
    `).get(e.inscription_number, e.id, b);
    if (prev) returned++;
  }
  return { evs: evs.length, returned };
}

console.log('\n=== H2: directional pmx return-rate (sample) ===');
console.log('Cross-trader pattern: returned≈0 (B never owned the inscription before)');
console.log('Same-human pattern: returned > 0 fraction (cluster member round-trip)');
console.log('Sampling 12 FPs and 12 TPs at 9500…');

// Pick edges where pmx_count >= 2
const pmxFps = fpList.filter(e => e.pmx_count >= 2).slice(0, 12);
const pmxTps = tpList.filter(e => e.pmx_count >= 2).slice(0, 12);

function reportH2(label, pairs) {
  console.log(`\n  --- ${label} (${pairs.length}) ---`);
  let totalEv = 0, totalReturned = 0;
  for (const e of pairs) {
    const ab = pmxReturnRate(e.addr_a, e.addr_b);
    const ba = pmxReturnRate(e.addr_b, e.addr_a);
    const tot = (ab ? ab.evs : 0) + (ba ? ba.evs : 0);
    const ret = (ab ? ab.returned : 0) + (ba ? ba.returned : 0);
    totalEv += tot; totalReturned += ret;
    const ua = userInfo.get(walletToUser.get(e.addr_a));
    const ub = userInfo.get(walletToUser.get(e.addr_b));
    console.log(`    A=${(ua && ua.username || '?').slice(0,16).padEnd(16)} B=${(ub && ub.username || '?').slice(0,16).padEnd(16)}  events=${tot}  returned=${ret}  rate=${tot ? (ret/tot*100).toFixed(0)+'%' : 'n/a'}`);
  }
  console.log(`  TOTAL: events=${totalEv} returned=${totalReturned} = ${totalEv ? (totalReturned/totalEv*100).toFixed(1) : 0}%`);
}
reportH2('FPs', pmxFps);
reportH2('TPs', pmxTps);

// === H3: cc bridge through personal-MSR vs not ===
// We need to know which hub each cc edge bridges through. The original
// build doesn't store that, so reconstruct: for each pair (a, b), find
// shared destinations and classify each. (Expensive — sample only.)
console.log('\n=== H3: cc-bridge classification (sample) ===');
console.log('Of FPs with cc≥1, how many cc-bridge through a personal-MSR (real consolidator) vs a non-personal hub (popular trading address)?');

function ccBridgeBreakdown(a, b) {
  const sa = senderToReceivers.get(a) || new Set();
  const sb = senderToReceivers.get(b) || new Set();
  let personalCount = 0, nonPersonalCount = 0;
  for (const r of sa) {
    if (sb.has(r)) {
      // r is a destination both A and B sent to; check if it has ≥COCONS_MIN_DEGREE=2 monog senders
      const senders = receiverToSenders.get(r) || new Set();
      if (senders.size < 2) continue;
      let monogN = 0;
      for (const s of senders) if (MONOG.has(s)) monogN++;
      if (monogN < 2) continue;
      if (personalMSR.has(r)) personalCount++;
      else nonPersonalCount++;
    }
  }
  return { personalCount, nonPersonalCount };
}

const ccFps = fpList.filter(e => e.co_cons_count >= 1);
const ccTps = tpList.filter(e => e.co_cons_count >= 1);
function aggH3(pairs) {
  let viaPersonalOnly = 0, viaMixed = 0, viaNonPersonalOnly = 0, none = 0;
  for (const e of pairs) {
    const r = ccBridgeBreakdown(e.addr_a, e.addr_b);
    if (r.personalCount > 0 && r.nonPersonalCount === 0) viaPersonalOnly++;
    else if (r.personalCount > 0 && r.nonPersonalCount > 0) viaMixed++;
    else if (r.nonPersonalCount > 0) viaNonPersonalOnly++;
    else none++;
  }
  return { viaPersonalOnly, viaMixed, viaNonPersonalOnly, none, total: pairs.length };
}
const fpAgg = aggH3(ccFps);
const tpAgg = aggH3(ccTps);
console.log(`FPs (cc≥1, n=${ccFps.length}): personal-only=${fpAgg.viaPersonalOnly} mixed=${fpAgg.viaMixed} non-personal-only=${fpAgg.viaNonPersonalOnly} none=${fpAgg.none}`);
console.log(`TPs (cc≥1, n=${ccTps.length}): personal-only=${tpAgg.viaPersonalOnly} mixed=${tpAgg.viaMixed} non-personal-only=${tpAgg.viaNonPersonalOnly} none=${tpAgg.none}`);

db.close();
