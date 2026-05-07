#!/usr/bin/env node
/* eslint-disable */
// Step 1 audit: characterize FPs and FNs at thresholds 9500 and 9900
// against the v1 stored edges in wallet_cluster_edges.
//
// Outputs:
//   - threshold-summary.json: TP/FP/autoshell/unknown counts per threshold
//   - fp-detail.json: every real FP with usernames, edge counts, evidence txids
//   - recall-by-user.json: per multi-wallet user, pairs detected vs missed
//
// Pure read-only — touches /tmp/app-snap.db.

const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');

const DB_PATH = process.env.OMB_DB_PATH || '/tmp/app-snap.db';
const OUT_DIR = path.resolve(__dirname);

const db = new Database(DB_PATH, { readonly: true });

function isAutoShellUsername(u) {
  if (!u) return true;
  if (/^bc1[a-z0-9]{20,}/i.test(u)) return true;
  if (/^0x[a-fA-F0-9]{40}/.test(u)) return true;
  return false;
}

const links = db.prepare(`
  SELECT wl.wallet_addr, wl.matrica_user_id, mu.username, mu.avatar_url
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
  userInfo.set(r.matrica_user_id, { username: r.username, avatar_url: r.avatar_url });
  if (isAutoShellUsername(r.username)) autoShellUsers.add(r.matrica_user_id);
}
console.log(`Linked wallets: ${links.length}; users: ${userToWallets.size}; auto-shell users: ${autoShellUsers.size}`);

// Multi-wallet groups (recall denominator).
let multiWalletUsers = 0;
let totalPairs = 0;
for (const w of userToWallets.values()) {
  if (w.length >= 2) {
    multiWalletUsers++;
    totalPairs += (w.length * (w.length - 1)) / 2;
  }
}
console.log(`Multi-wallet users: ${multiWalletUsers}, total pairs: ${totalPairs}`);

const allEdges = db.prepare(`
  SELECT addr_a, addr_b, confidence, cih_count, self_xfer_count,
         self_xfer_ab, self_xfer_ba, evidence_json, last_seen_at
    FROM wallet_cluster_edges
`).all();
console.log(`Total v1 edges: ${allEdges.length}`);

// === Per-threshold breakdown ===
const thresholds = [8500, 9000, 9300, 9500, 9700, 9800, 9900, 9950];
const summary = [];

// Build edge index by wallet for recall calc.
const edgesByAddr = new Map();
for (const e of allEdges) {
  const ka = edgesByAddr.get(e.addr_a) || [];
  ka.push(e); edgesByAddr.set(e.addr_a, ka);
  const kb = edgesByAddr.get(e.addr_b) || [];
  kb.push(e); edgesByAddr.set(e.addr_b, kb);
}

const fpDetailByThreshold = {};
for (const th of thresholds) {
  let tp = 0, fp = 0, autoshell = 0, unk = 0, pairs = 0;
  const fpList = [];
  for (const e of allEdges) {
    if (e.confidence < th) continue;
    pairs++;
    const ua = walletToUser.get(e.addr_a);
    const ub = walletToUser.get(e.addr_b);
    if (ua && ub) {
      if (ua === ub) tp++;
      else if (autoShellUsers.has(ua) || autoShellUsers.has(ub)) autoshell++;
      else {
        fp++;
        fpList.push({
          addr_a: e.addr_a, addr_b: e.addr_b,
          confidence: e.confidence,
          cih_count: e.cih_count,
          self_xfer_count: e.self_xfer_count,
          self_xfer_ab: e.self_xfer_ab, self_xfer_ba: e.self_xfer_ba,
          ua, ub,
          username_a: (userInfo.get(ua) || {}).username,
          username_b: (userInfo.get(ub) || {}).username,
          evidence: JSON.parse(e.evidence_json || '[]').slice(0, 5),
        });
      }
    } else {
      unk++;
    }
  }

  // Recall: union-find at this threshold.
  const parent = new Map();
  const find = (x) => {
    let p = parent.get(x);
    if (p === undefined) { parent.set(x, x); return x; }
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  const union = (a, b) => {
    const ra = find(a); const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const e of allEdges) {
    if (e.confidence >= th) union(e.addr_a, e.addr_b);
  }
  let recoveredPairs = 0;
  for (const wallets of userToWallets.values()) {
    if (wallets.length < 2) continue;
    for (let i = 0; i < wallets.length; i++) {
      for (let j = i + 1; j < wallets.length; j++) {
        if (find(wallets[i]) === find(wallets[j])) recoveredPairs++;
      }
    }
  }

  const known = tp + fp;
  const realPrecision = known === 0 ? null : tp / known;
  const recall = totalPairs === 0 ? null : recoveredPairs / totalPairs;
  summary.push({
    threshold: th, pairs, tp, fp, autoshell, unk,
    real_precision: realPrecision,
    recall,
    recovered_pairs: recoveredPairs,
    total_matrica_pairs: totalPairs,
  });
  fpDetailByThreshold[th] = fpList;
  console.log(
    `th=${th}: pairs=${pairs} tp=${tp} fp=${fp} auto=${autoshell} unk=${unk} ` +
    `precision=${realPrecision === null ? 'n/a' : (realPrecision*100).toFixed(2)+'%'} ` +
    `recall=${recall === null ? 'n/a' : (recall*100).toFixed(2)+'%'} (${recoveredPairs}/${totalPairs})`
  );
}

fs.writeFileSync(path.join(OUT_DIR, 'threshold-summary.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(OUT_DIR, 'fp-detail.json'), JSON.stringify(fpDetailByThreshold, null, 2));

// === Recall by user — which multi-wallet users are we missing? ===
const recallByUser = [];
for (const [uid, wallets] of userToWallets) {
  if (wallets.length < 2) continue;
  const userPairs = (wallets.length * (wallets.length - 1)) / 2;
  for (const th of [9500, 9900]) {
    const parent = new Map();
    const find = (x) => {
      let p = parent.get(x);
      if (p === undefined) { parent.set(x, x); return x; }
      if (p === x) return x;
      const r = find(p);
      parent.set(x, r);
      return r;
    };
    const union = (a, b) => {
      const ra = find(a); const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    for (const e of allEdges) {
      if (e.confidence >= th) union(e.addr_a, e.addr_b);
    }
  }
}
// (Per-user recall block redone simpler below)

const perUser = [];
for (const [uid, wallets] of userToWallets) {
  if (wallets.length < 2) continue;
  for (const th of [9500, 9900]) {
    // BFS from each wallet using v1 edges ≥ th
    // But we want pairwise recovered count among this user's wallets.
    const set = new Set(wallets);
    const found = new Set();
    // Build subgraph adjacency just within wallets of this user.
    const subAdj = new Map();
    for (const e of allEdges) {
      if (e.confidence < th) continue;
      if (set.has(e.addr_a) || set.has(e.addr_b)) {
        if (!subAdj.has(e.addr_a)) subAdj.set(e.addr_a, []);
        if (!subAdj.has(e.addr_b)) subAdj.set(e.addr_b, []);
        subAdj.get(e.addr_a).push(e.addr_b);
        subAdj.get(e.addr_b).push(e.addr_a);
      }
    }
    // For each wallet, BFS through ALL edges (not just within set), but
    // we count pairs that end up reachable. Since we want true recall,
    // walking through arbitrary intermediates is OK.
    const parent = new Map();
    const find = (x) => {
      let p = parent.get(x);
      if (p === undefined) { parent.set(x, x); return x; }
      if (p === x) return x;
      const r = find(p);
      parent.set(x, r);
      return r;
    };
    const union = (a, b) => {
      const ra = find(a); const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    for (const e of allEdges) {
      if (e.confidence >= th) union(e.addr_a, e.addr_b);
    }
    let recovered = 0;
    for (let i = 0; i < wallets.length; i++)
      for (let j = i + 1; j < wallets.length; j++)
        if (find(wallets[i]) === find(wallets[j])) recovered++;
    const userPairs = (wallets.length * (wallets.length - 1)) / 2;
    perUser.push({
      threshold: th,
      user_id: uid,
      username: (userInfo.get(uid) || {}).username,
      auto_shell: autoShellUsers.has(uid),
      n_wallets: wallets.length,
      total_pairs: userPairs,
      recovered_pairs: recovered,
      recall: userPairs === 0 ? 0 : recovered / userPairs,
    });
  }
}

fs.writeFileSync(path.join(OUT_DIR, 'recall-by-user.json'), JSON.stringify(perUser, null, 2));

// Summarize bucketed recall.
for (const th of [9500, 9900]) {
  const rows = perUser.filter(r => r.threshold === th && !r.auto_shell);
  const usersFull = rows.filter(r => r.recall === 1).length;
  const usersZero = rows.filter(r => r.recall === 0).length;
  const usersPartial = rows.length - usersFull - usersZero;
  console.log(`\nclaimed multi-wallet users at th=${th}: ${rows.length} total`);
  console.log(`  full recall: ${usersFull}, partial: ${usersPartial}, zero: ${usersZero}`);
}

console.log('\nWrote: threshold-summary.json, fp-detail.json, recall-by-user.json');
db.close();
