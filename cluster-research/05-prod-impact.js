#!/usr/bin/env node
/* eslint-disable */
// Estimate the production delta of v2 vs v1, given Matrica already
// provides authoritative wallet linkage for ~5,600 wallets / 2,728 users.
//
// Production surfaces affected:
//
//   A) cluster_anchors (identity-fold table at IDENTITY_FOLD_THRESHOLD =
//      9900). Folds unlinked wallets into a Matrica user's cluster, OR
//      creates an unlinked-only cluster. Drives:
//        - holder-profile aggregation (combines holdings across folded
//          wallets)
//        - top-holders leaderboard (counts inscriptions per anchor, not
//          per wallet)
//        - role badges (folded wallet's holdings count for role tier)
//      Components containing >1 Matrica user are SKIPPED (Matrica trumps).
//
//   B) "Likely linked wallets" advisory section on holder profile pages
//      (uses CLUSTER_THRESHOLD = 9500, ALWAYS excluding Matrica
//      siblings). This is the on-chain-only discovery surface — every
//      pair shown here is necessarily a "v2 unknown" or "Matrica-different-
//      user" edge.
//
//   C) Activity feed username overlay (uses Matrica directly + cluster
//      anchor; folded wallets inherit the anchor's @username).
//
// We compute three deltas:
//
//   1. Matrica fold extension: for each multi-wallet Matrica user, how
//      many ADDITIONAL non-Matrica-linked wallets get folded into that
//      user's component at 9900?
//   2. New unlinked-only components: components ≥9900 with no Matrica
//      member at all — pure on-chain discovery clusters.
//   3. Holder-page "likely linked" suggestions: per claimed multi-
//      wallet user, count of new on-chain-only peer suggestions surfaced
//      at 9500 (excluding Matrica siblings).

const Database = require('better-sqlite3');
const path = require('node:path');

const DB_PATH = process.env.OMB_DB_PATH || '/tmp/app-v2.db';
const db = new Database(DB_PATH, { readonly: true });

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

function buildComponents(table, th) {
  const rows = db.prepare(`SELECT addr_a, addr_b FROM ${table} WHERE confidence >= ?`).all(th);
  const parent = new Map();
  const find = (x) => { let p=parent.get(x); if(p===undefined){parent.set(x,x);return x;} if(p===x)return x; const r=find(p); parent.set(x,r); return r; };
  const union = (a,b) => { const ra=find(a); const rb=find(b); if(ra!==rb)parent.set(ra,rb); };
  for (const r of rows) union(r.addr_a, r.addr_b);
  // Group nodes by root.
  const groups = new Map();
  for (const node of parent.keys()) {
    const root = find(node);
    let g = groups.get(root);
    if (!g) { g = []; groups.set(root, g); }
    g.push(node);
  }
  return groups;
}

// ---- A) cluster_anchors at 9900 — apply production logic ----
function describeAnchors(table) {
  const groups = buildComponents(table, 9900);
  let totalComponents = 0;
  let skippedSplit = 0;
  let foldedToMatrica = 0;
  let unlinkedOnly = 0;
  let foldedMembers = 0;
  let extraMembersFolded = 0; // non-Matrica-linked wallets that get a fold
  let unlinkedOnlyMembers = 0;
  let extraByUser = new Map();
  for (const [, members] of groups) {
    if (members.length < 2) continue;
    totalComponents++;
    const matricaIds = new Set();
    let nLinked = 0;
    for (const m of members) {
      const uid = walletToUser.get(m);
      if (uid) {
        matricaIds.add(uid);
        nLinked++;
      }
    }
    if (matricaIds.size > 1) { skippedSplit++; continue; }
    if (matricaIds.size === 1) {
      foldedToMatrica++;
      foldedMembers += members.length;
      const uid = Array.from(matricaIds)[0];
      const userWallets = new Set(userToWallets.get(uid) || []);
      const newOnes = members.filter(m => !userWallets.has(m));
      extraMembersFolded += newOnes.length;
      if (newOnes.length > 0) {
        extraByUser.set(uid, (extraByUser.get(uid) || 0) + newOnes.length);
      }
    } else {
      unlinkedOnly++;
      unlinkedOnlyMembers += members.length;
    }
  }
  return {
    totalComponents, skippedSplit, foldedToMatrica, foldedMembers,
    extraMembersFolded, unlinkedOnly, unlinkedOnlyMembers,
    extraByUser,
  };
}

console.log('=== A) cluster_anchors @ IDENTITY_FOLD_THRESHOLD = 9900 ===\n');
const v1A = describeAnchors('wallet_cluster_edges');
const v2A = describeAnchors('wallet_cluster_edges_v2');
console.log('| metric | v1 | v2 |');
console.log('|--------|----|----|');
console.log(`| total components ≥2 members | ${v1A.totalComponents} | ${v2A.totalComponents} |`);
console.log(`| folded to a Matrica user | ${v1A.foldedToMatrica} | ${v2A.foldedToMatrica} |`);
console.log(`| skipped (split — Matrica disagrees) | ${v1A.skippedSplit} | ${v2A.skippedSplit} |`);
console.log(`| unlinked-only components | ${v1A.unlinkedOnly} | ${v2A.unlinkedOnly} |`);
console.log(`| total members in Matrica-folded components | ${v1A.foldedMembers} | ${v2A.foldedMembers} |`);
console.log(`| **extra wallets folded to a Matrica user** | **${v1A.extraMembersFolded}** | **${v2A.extraMembersFolded}** |`);
console.log(`| members in unlinked-only components | ${v1A.unlinkedOnlyMembers} | ${v2A.unlinkedOnlyMembers} |`);

// Top users gaining extra folded wallets (v2)
console.log('\nTop 10 Matrica users gaining extra folded wallets in v2:');
const arr = Array.from(v2A.extraByUser.entries()).sort((a,b)=>b[1]-a[1]);
for (const [uid, n] of arr.slice(0, 10)) {
  const v1n = v1A.extraByUser.get(uid) || 0;
  const u = userInfo.get(uid);
  const flag = u && autoShellUsers.has(uid) ? ' (auto-shell)' : '';
  console.log(`  ${(u && u.username || uid).slice(0,40).padEnd(40)} v1: +${v1n}  v2: +${n}${flag}`);
}

// ---- B) Holder-page "likely linked" — 9500 threshold, exclude Matrica siblings ----
console.log('\n=== B) Holder-page "likely linked" peers @ 9500 (per multi-wallet Matrica user) ===\n');
console.log('Counts the per-user-displayed peer set (after grouping wallets by user, excluding their own Matrica-confirmed siblings).');

function neighborsByEdges(table, th) {
  const rows = db.prepare(`SELECT addr_a, addr_b FROM ${table} WHERE confidence >= ?`).all(th);
  const adj = new Map();
  for (const r of rows) {
    if (!adj.has(r.addr_a)) adj.set(r.addr_a, new Set());
    if (!adj.has(r.addr_b)) adj.set(r.addr_b, new Set());
    adj.get(r.addr_a).add(r.addr_b);
    adj.get(r.addr_b).add(r.addr_a);
  }
  return adj;
}

const v1Adj = neighborsByEdges('wallet_cluster_edges', 9500);
const v2Adj = neighborsByEdges('wallet_cluster_edges_v2', 9500);

let v1TotalPeers = 0, v2TotalPeers = 0;
let v1UsersWithAnyPeer = 0, v2UsersWithAnyPeer = 0;
let v1UsersByPeerCount = { '0':0, '1-3':0, '4-10':0, '11+':0 };
let v2UsersByPeerCount = { '0':0, '1-3':0, '4-10':0, '11+':0 };
for (const [uid, wallets] of userToWallets) {
  const set = new Set(wallets);
  const v1Peers = new Set();
  const v2Peers = new Set();
  for (const w of wallets) {
    for (const p of (v1Adj.get(w) || [])) if (!set.has(p)) v1Peers.add(p);
    for (const p of (v2Adj.get(w) || [])) if (!set.has(p)) v2Peers.add(p);
  }
  v1TotalPeers += v1Peers.size;
  v2TotalPeers += v2Peers.size;
  if (v1Peers.size > 0) v1UsersWithAnyPeer++;
  if (v2Peers.size > 0) v2UsersWithAnyPeer++;
  const bucket = (n) => n === 0 ? '0' : n <= 3 ? '1-3' : n <= 10 ? '4-10' : '11+';
  v1UsersByPeerCount[bucket(v1Peers.size)]++;
  v2UsersByPeerCount[bucket(v2Peers.size)]++;
}
console.log(`Total Matrica users (any wallet count): ${userToWallets.size}`);
console.log(`Users with ≥1 on-chain-only peer @ 9500:    v1=${v1UsersWithAnyPeer}   v2=${v2UsersWithAnyPeer}`);
console.log(`Total non-Matrica peer suggestions across all users: v1=${v1TotalPeers}   v2=${v2TotalPeers}`);
console.log('\nBucketed peer-count distribution:');
console.log('| peers | v1 users | v2 users |');
console.log('|-------|----------|----------|');
for (const k of ['0','1-3','4-10','11+']) {
  console.log(`| ${k} | ${v1UsersByPeerCount[k]} | ${v2UsersByPeerCount[k]} |`);
}

// ---- C) Effective holder-count concentration ----
// Count of distinct effective_owners after fold (v1 vs v2). The smaller
// number, the more concentration — bigger collectors are now visible
// as such on top-holders.
console.log('\n=== C) Top-holders leaderboard — effective-owner concentration ===\n');
function holdersAfterFold(table) {
  // Build per-wallet anchor-id (matrica user OR cluster anchor OR self).
  const groups = buildComponents(table, 9900);
  const walletAnchor = new Map();
  for (const [, members] of groups) {
    if (members.length < 2) continue;
    const matricaIds = new Set();
    for (const m of members) {
      const uid = walletToUser.get(m);
      if (uid) matricaIds.add(uid);
    }
    if (matricaIds.size > 1) continue;
    let anchor;
    if (matricaIds.size === 1) anchor = `matrica:${Array.from(matricaIds)[0]}`;
    else anchor = `wallet:${members.slice().sort()[0]}`;
    for (const m of members) walletAnchor.set(m, anchor);
  }
  // Pull live holders (effective_owner from inscriptions).
  const rows = db.prepare(`
    SELECT effective_owner AS owner, COUNT(*) AS n
      FROM inscriptions WHERE collection_slug='omb' AND effective_owner IS NOT NULL
     GROUP BY effective_owner
  `).all();
  const folded = new Map();
  let totalHolders = 0; let foldedHolders = 0;
  for (const r of rows) {
    totalHolders++;
    let key = walletAnchor.get(r.owner);
    if (!key) {
      // No cluster fold; look up Matrica user directly (production does this).
      const uid = walletToUser.get(r.owner);
      key = uid ? `matrica:${uid}` : `wallet:${r.owner}`;
    } else {
      foldedHolders++;
    }
    folded.set(key, (folded.get(key) || 0) + r.n);
  }
  return { distinctHolders: rows.length, distinctFoldedAnchors: folded.size, foldedHolders, top: Array.from(folded.entries()).sort((a,b)=>b[1]-a[1]).slice(0, 10) };
}
const v1H = holdersAfterFold('wallet_cluster_edges');
const v2H = holdersAfterFold('wallet_cluster_edges_v2');
console.log(`v1: ${v1H.distinctHolders} distinct effective_owners → ${v1H.distinctFoldedAnchors} top-holder anchors after fold (${v1H.foldedHolders} wallets had cluster_anchor entry)`);
console.log(`v2: ${v2H.distinctHolders} distinct effective_owners → ${v2H.distinctFoldedAnchors} top-holder anchors after fold (${v2H.foldedHolders} wallets had cluster_anchor entry)`);
console.log(`\nDelta: v2 collapses ${v1H.distinctFoldedAnchors - v2H.distinctFoldedAnchors} additional holder rows into existing anchors (Matrica users get bigger holdings totals).`);

console.log('\nTop-10 holder anchors (v2):');
for (const [k, n] of v2H.top) {
  if (k.startsWith('matrica:')) {
    const uid = k.slice('matrica:'.length);
    const u = userInfo.get(uid);
    console.log(`  ${n.toString().padStart(4)}  @${u && u.username || uid}`);
  } else {
    console.log(`  ${n.toString().padStart(4)}  ${k.slice('wallet:'.length, 'wallet:'.length+18)}…`);
  }
}

db.close();
