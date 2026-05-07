#!/usr/bin/env node
/* eslint-disable */
// Score v2 edges (wallet_cluster_edges_v2) against Matrica ground truth.
// Mirrors 01-audit-v1.js but for v2 + adds coverage stats.

const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');

const DB_PATH = process.env.OMB_DB_PATH || '/tmp/app-v2.db';
const OUT_DIR = path.resolve(__dirname);

const db = new Database(DB_PATH, { readonly: true });

function isAutoShellUsername(u) {
  if (!u) return true;
  if (/^bc1[a-z0-9]{20,}/i.test(u)) return true;
  if (/^0x[a-fA-F0-9]{40}/.test(u)) return true;
  return false;
}

const links = db.prepare(`
  SELECT wl.wallet_addr, wl.matrica_user_id, mu.username
    FROM wallet_links wl
    LEFT JOIN matrica_users mu ON mu.user_id = wl.matrica_user_id
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
let multiUsers = 0;
for (const w of userToWallets.values()) if (w.length >= 2) {
  multiUsers++;
  totalPairs += (w.length * (w.length - 1)) / 2;
}
console.log(`Linked wallets: ${links.length}, distinct users: ${userToWallets.size}, multi-wallet users: ${multiUsers}, total Matrica pairs: ${totalPairs}`);

const edges = db.prepare(`
  SELECT addr_a, addr_b, confidence, cih_count, self_xfer_count, self_xfer_ab, self_xfer_ba,
         co_cons_count, co_parent_count, pmx_count, pmx_ab, pmx_ba
    FROM wallet_cluster_edges_v2
`).all();
console.log(`v2 edges total: ${edges.length}`);

const thresholds = [8000, 8500, 9000, 9500, 9700, 9800, 9900, 9950, 9990];
const summary = [];
const fpDetailByThreshold = {};

for (const th of thresholds) {
  let tp = 0, fp = 0, autoshell = 0, unk = 0, pairs = 0;
  const fpList = [];
  for (const e of edges) {
    if (e.confidence < th) continue;
    pairs++;
    const ua = walletToUser.get(e.addr_a);
    const ub = walletToUser.get(e.addr_b);
    if (ua && ub) {
      if (ua === ub) tp++;
      else if (autoShellUsers.has(ua) || autoShellUsers.has(ub)) autoshell++;
      else {
        fp++;
        if (fpList.length < 200) fpList.push({
          addr_a: e.addr_a, addr_b: e.addr_b, confidence: e.confidence,
          cih_count: e.cih_count, self_xfer_count: e.self_xfer_count,
          self_xfer_ab: e.self_xfer_ab, self_xfer_ba: e.self_xfer_ba,
          co_cons_count: e.co_cons_count, co_parent_count: e.co_parent_count,
          pmx_count: e.pmx_count, pmx_ab: e.pmx_ab, pmx_ba: e.pmx_ba,
          ua, ub,
          username_a: (userInfo.get(ua) || {}).username,
          username_b: (userInfo.get(ub) || {}).username,
        });
      }
    } else {
      unk++;
    }
  }
  // Recall via union-find
  const parent = new Map();
  const find = (x) => {
    let p = parent.get(x);
    if (p === undefined) { parent.set(x, x); return x; }
    if (p === x) return x;
    const r = find(p); parent.set(x, r); return r;
  };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const e of edges) if (e.confidence >= th) union(e.addr_a, e.addr_b);
  let recovered = 0;
  for (const wallets of userToWallets.values()) {
    if (wallets.length < 2) continue;
    for (let i = 0; i < wallets.length; i++)
      for (let j = i + 1; j < wallets.length; j++)
        if (find(wallets[i]) === find(wallets[j])) recovered++;
  }
  const known = tp + fp;
  const realPrecision = known === 0 ? null : tp / known;
  const recall = totalPairs === 0 ? 0 : recovered / totalPairs;
  summary.push({
    threshold: th, pairs, tp, fp, autoshell, unk,
    real_precision: realPrecision,
    recall, recovered_pairs: recovered, total_matrica_pairs: totalPairs,
  });
  fpDetailByThreshold[th] = fpList;
  console.log(
    `th=${th}: pairs=${pairs} tp=${tp} fp=${fp} auto=${autoshell} unk=${unk} ` +
    `precision=${realPrecision === null ? 'n/a' : (realPrecision*100).toFixed(2)+'%'} ` +
    `recall=${(recall*100).toFixed(2)+'%'} (${recovered}/${totalPairs})`
  );
}

fs.writeFileSync(path.join(OUT_DIR, 'v2-threshold-summary.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(OUT_DIR, 'v2-fp-detail.json'), JSON.stringify(fpDetailByThreshold, null, 2));
console.log('Wrote v2-threshold-summary.json + v2-fp-detail.json');
db.close();
