#!/usr/bin/env node
/* eslint-disable */
// Test multiple v2 confidence-formula variants to address the cross-
// trader FP class (e.g. ApeSoda↔goot, JJL↔dor1tolover). All variants
// share the same edge data already stored in wallet_cluster_edges_v2;
// only the score → threshold mapping changes, plus optional flags that
// gate certain raw counts via MSR membership.
//
// Variants tested:
//
//   B0: current v2 formula (baseline; the 02-build-v2 ladder)
//
//   B1: 9900-band tighten — bidirectional pmx alone caps at 0.95;
//       reaching 0.99 requires another signal (cih, sx, cc, OR cp).
//       Targets the ApeSoda↔goot identity-fold FP class.
//
//   B2: B1 + MSR-pair pmx suppression — when both endpoints are
//       (any) MSRs, drop pmx contribution entirely (cap as if pmx=0).
//       Targets cross-trader pmx between hubs.
//
//   B3: B1 + MSR-pair cc-via-non-personal-hub gate — when both
//       endpoints are themselves MSRs AND the cc connects only via
//       non-personal-MSR hubs (i.e. "popular but not really
//       consolidator" trading hubs), drop cc to 0. Requires we know
//       the personal-MSR classification of each cc bridge — fed in
//       via a side table.
//
//   B4: B1 + indep bonus tightening — to count toward the indep≥2
//       cross-mechanism bonus, the family-signal must be "strong":
//         cc ≥ 2, OR cp ≥ 2, OR cc=1+cp=1, OR pmx_bidir ≥ 1, OR pmx ≥ 3
//       (cc=1 alone or pmx=1 alone is no longer enough to be the second
//       independent mechanism).
//
//   B5: B1 + B4 + MSR-pair pmx suppression — the union.

const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');

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
const userToWallets = new Map();
const userInfo = new Map();
const autoShellUsers = new Set();
for (const r of links) {
  walletToUser.set(r.wallet_addr, r.matrica_user_id);
  let arr = userToWallets.get(r.matrica_user_id);
  if (!arr) { arr = []; userToWallets.set(r.matrica_user_id, arr); }
  arr.push(r.wallet_addr);
  userInfo.set(r.matrica_user_id, { username: r.username });
  if (isAutoShellUsername(r.username)) autoShellUsers.add(r.matrica_user_id);
}
let totalPairs = 0;
for (const w of userToWallets.values()) if (w.length >= 2) totalPairs += w.length*(w.length-1)/2;

// MSR set (mirror of build-v2's logic)
const msrSet = new Set();
const recvCount = db.prepare(`
  SELECT new_owner, COUNT(DISTINCT old_owner) AS n
    FROM events
   WHERE event_type='transferred' AND marketplace IS NULL
     AND old_owner IS NOT NULL AND new_owner IS NOT NULL AND old_owner != new_owner
   GROUP BY new_owner HAVING n >= 5
`).all();
for (const r of recvCount) msrSet.add(r.new_owner);
console.log(`MSRs: ${msrSet.size}`);

const edges = db.prepare(`
  SELECT addr_a, addr_b, cih_count, self_xfer_count, self_xfer_ab, self_xfer_ba,
         co_cons_count, co_parent_count, pmx_count, pmx_ab, pmx_ba
    FROM wallet_cluster_edges_v2
`).all();

// Confidence formulas
function confB0(c) {
  let p = 0;
  if (c.cih_count >= 1) p = Math.max(p, 0.80);
  if (c.cih_count >= 2) p = Math.max(p, 0.95);
  if (c.cih_count >= 3) p = Math.max(p, 0.98);
  if (c.cih_count >= 5) p = Math.max(p, 0.99);
  const sxBidir = Math.min(c.self_xfer_ab, c.self_xfer_ba);
  const sxTotal = c.self_xfer_count > 0 ? c.self_xfer_count : c.self_xfer_ab + c.self_xfer_ba;
  if (sxBidir >= 1) p = Math.max(p, 0.92);
  if (sxBidir >= 2) p = Math.max(p, 0.99);
  if (sxTotal >= 1) p = Math.max(p, 0.50);
  if (sxTotal >= 3) p = Math.max(p, 0.80);
  if (c.cih_count >= 1 && sxBidir >= 1) p = Math.max(p, 0.99);
  if (c.cih_count >= 1 && sxTotal >= 1) p = Math.max(p, 0.95);
  if (c.cih_count >= 2 && sxTotal >= 2) p = Math.max(p, 0.99);

  if (c.co_cons_count >= 1) p = Math.max(p, 0.80);
  if (c.co_cons_count >= 2) p = Math.max(p, 0.95);
  if (c.co_cons_count >= 3) p = Math.max(p, 0.98);
  if (c.co_cons_count >= 5) p = Math.max(p, 0.99);
  if (c.co_parent_count >= 1) p = Math.max(p, 0.80);
  if (c.co_parent_count >= 2) p = Math.max(p, 0.95);
  if (c.co_parent_count >= 3) p = Math.max(p, 0.98);
  const pmxBidir = Math.min(c.pmx_ab, c.pmx_ba);
  if (c.pmx_count >= 1) p = Math.max(p, 0.75);
  if (c.pmx_count >= 3) p = Math.max(p, 0.90);
  if (pmxBidir >= 1) p = Math.max(p, 0.95);
  if (pmxBidir >= 2) p = Math.max(p, 0.99);
  let indep = 0;
  if (c.cih_count >= 1) indep++;
  if (c.self_xfer_ab + c.self_xfer_ba >= 1) indep++;
  if (c.co_cons_count >= 1) indep++;
  if (c.co_parent_count >= 1) indep++;
  if (c.pmx_count >= 1) indep++;
  if (indep >= 2) p = Math.max(p, 0.97);
  if (indep >= 3) p = Math.max(p, 0.99);
  return Math.round(p * 10000);
}

// B1: same as B0 but pmx_bidir≥2 alone tops at 0.95 — needs anchoring signal for 0.99
function confB1(c) {
  let p = confB0(c);
  // If we got to 0.99 and the ONLY way was pmx_bidir≥2 (no other signal),
  // back off to 0.95.
  const pmxBidir = Math.min(c.pmx_ab, c.pmx_ba);
  const onlyPmx = (c.cih_count === 0)
    && (c.self_xfer_ab + c.self_xfer_ba === 0)
    && (c.co_cons_count === 0)
    && (c.co_parent_count === 0);
  if (onlyPmx && pmxBidir >= 2 && p >= 9900) p = 9500;
  // Also require an anchoring signal for the indep≥3 bonus to cross 9900 with pmx in the mix
  // Already handled by onlyPmx clause.
  return p;
}

function isMsr(addr) { return msrSet.has(addr); }

function confB2(addr_a, addr_b, c) {
  // MSR-pair pmx suppression: if both addr_a and addr_b are MSRs, treat
  // pmx_count/pmx_ab/pmx_ba as 0 in the formula.
  if (isMsr(addr_a) && isMsr(addr_b)) {
    const c2 = { ...c, pmx_count: 0, pmx_ab: 0, pmx_ba: 0 };
    return confB1(c2);
  }
  return confB1(c);
}

function confB4(c) {
  // B1 + tighter indep bonus: cc=1 alone or pmx=1 alone don't count.
  let p = 0;
  if (c.cih_count >= 1) p = Math.max(p, 0.80);
  if (c.cih_count >= 2) p = Math.max(p, 0.95);
  if (c.cih_count >= 3) p = Math.max(p, 0.98);
  if (c.cih_count >= 5) p = Math.max(p, 0.99);
  const sxBidir = Math.min(c.self_xfer_ab, c.self_xfer_ba);
  const sxTotal = c.self_xfer_count > 0 ? c.self_xfer_count : c.self_xfer_ab + c.self_xfer_ba;
  if (sxBidir >= 1) p = Math.max(p, 0.92);
  if (sxBidir >= 2) p = Math.max(p, 0.99);
  if (sxTotal >= 1) p = Math.max(p, 0.50);
  if (sxTotal >= 3) p = Math.max(p, 0.80);
  if (c.cih_count >= 1 && sxBidir >= 1) p = Math.max(p, 0.99);
  if (c.cih_count >= 1 && sxTotal >= 1) p = Math.max(p, 0.95);
  if (c.cih_count >= 2 && sxTotal >= 2) p = Math.max(p, 0.99);
  if (c.co_cons_count >= 1) p = Math.max(p, 0.80);
  if (c.co_cons_count >= 2) p = Math.max(p, 0.95);
  if (c.co_cons_count >= 3) p = Math.max(p, 0.98);
  if (c.co_cons_count >= 5) p = Math.max(p, 0.99);
  if (c.co_parent_count >= 1) p = Math.max(p, 0.80);
  if (c.co_parent_count >= 2) p = Math.max(p, 0.95);
  if (c.co_parent_count >= 3) p = Math.max(p, 0.98);
  const pmxBidir = Math.min(c.pmx_ab, c.pmx_ba);
  if (c.pmx_count >= 1) p = Math.max(p, 0.75);
  if (c.pmx_count >= 3) p = Math.max(p, 0.90);
  if (pmxBidir >= 1) p = Math.max(p, 0.95);
  if (pmxBidir >= 2) p = Math.max(p, 0.99);

  // Tighter indep bonus: family signal must be "strong"
  let indep = 0;
  if (c.cih_count >= 1) indep++;
  if (c.self_xfer_ab + c.self_xfer_ba >= 1) indep++;
  const familyStrong = (c.co_cons_count >= 2)
    || (c.co_parent_count >= 2)
    || (c.co_cons_count >= 1 && c.co_parent_count >= 1)
    || (pmxBidir >= 1)
    || (c.pmx_count >= 3);
  if (familyStrong) indep++;
  if (indep >= 2) p = Math.max(p, 0.97);
  if (indep >= 3) p = Math.max(p, 0.99);

  // B1's pmx-bidir-alone backoff still applies
  const onlyPmx = (c.cih_count === 0)
    && (c.self_xfer_ab + c.self_xfer_ba === 0)
    && (c.co_cons_count === 0)
    && (c.co_parent_count === 0);
  if (onlyPmx && pmxBidir >= 2 && p >= 0.99) p = 0.95;
  return Math.round(p * 10000);
}

function confB5(addr_a, addr_b, c) {
  // B4 + MSR-pair pmx suppression
  let useC = c;
  if (isMsr(addr_a) && isMsr(addr_b)) {
    useC = { ...c, pmx_count: 0, pmx_ab: 0, pmx_ba: 0 };
  }
  return confB4(useC);
}

function score(label, scorer) {
  const ths = [9000, 9500, 9700, 9900];
  const out = [];
  for (const th of ths) {
    let tp=0, fp=0, auto=0, unk=0, pairs=0;
    const parent = new Map();
    const find = (x) => { let p=parent.get(x); if(p===undefined){parent.set(x,x);return x;} if(p===x)return x; const r=find(p); parent.set(x,r); return r; };
    const union = (a,b) => { const ra=find(a); const rb=find(b); if(ra!==rb)parent.set(ra,rb); };
    for (const e of edges) {
      const conf = scorer(e);
      if (conf < th) continue;
      pairs++;
      const ua = walletToUser.get(e.addr_a); const ub = walletToUser.get(e.addr_b);
      if (ua && ub) {
        if (ua===ub) tp++;
        else if (autoShellUsers.has(ua)||autoShellUsers.has(ub)) auto++;
        else fp++;
      } else unk++;
      union(e.addr_a, e.addr_b);
    }
    let recovered=0;
    for (const wallets of userToWallets.values()) {
      if (wallets.length<2) continue;
      for (let i=0;i<wallets.length;i++) for (let j=i+1;j<wallets.length;j++)
        if (find(wallets[i])===find(wallets[j])) recovered++;
    }
    out.push({ label, th, pairs, tp, fp, auto, unk, prec: tp+fp ? tp/(tp+fp) : null, recall: recovered/totalPairs });
  }
  return out;
}

const variants = [
  ['B0 (baseline v2)', (e) => confB0(e)],
  ['B1 (9900 anchor required)', (e) => confB1(e)],
  ['B2 (B1 + MSR-pair pmx=0)', (e) => confB2(e.addr_a, e.addr_b, e)],
  ['B4 (B1 + tight indep bonus)', (e) => confB4(e)],
  ['B5 (B4 + MSR-pair pmx=0)', (e) => confB5(e.addr_a, e.addr_b, e)],
];

console.log('\n=== VARIANT COMPARISON ===\n');
console.log('| variant | th | pairs | tp | fp | auto | precision | recall |');
console.log('|---------|----|-------|----|----|------|-----------|--------|');
for (const [name, scorer] of variants) {
  const rows = score(name, scorer);
  for (const r of rows) {
    console.log(`| ${name} | ${r.th} | ${r.pairs} | ${r.tp} | ${r.fp} | ${r.auto} | ${r.prec === null ? 'n/a' : (r.prec*100).toFixed(2)+'%'} | ${(r.recall*100).toFixed(2)}% |`);
  }
  console.log('');
}

db.close();
