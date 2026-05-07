#!/usr/bin/env node
/* eslint-disable */
// What happens to the holder-page "likely linked" panel if we bump
// the display threshold from 9500 → 9700 → 9900?
//
// Reports per-Matrica-user peer-count distribution at each threshold,
// for both v2-baseline and v2 with the 9900 anchor-required tweak (B1).
// Also reports the cross-trader FP exposure at each threshold (how many
// distinct Matrica-user pairs Matrica-disagrees-on get surfaced).

const Database = require('better-sqlite3');
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
  if (!arr) { arr=[]; userToWallets.set(r.matrica_user_id, arr); }
  arr.push(r.wallet_addr);
  userInfo.set(r.matrica_user_id, { username: r.username });
  if (isAutoShellUsername(r.username)) autoShellUsers.add(r.matrica_user_id);
}

function adjAt(table, th) {
  const rows = db.prepare(`SELECT addr_a, addr_b FROM ${table} WHERE confidence >= ?`).all(th);
  const adj = new Map();
  for (const r of rows) {
    if (!adj.has(r.addr_a)) adj.set(r.addr_a, new Set());
    if (!adj.has(r.addr_b)) adj.set(r.addr_b, new Set());
    adj.get(r.addr_a).add(r.addr_b);
    adj.get(r.addr_b).add(r.addr_a);
  }
  return { adj, rows };
}

function userPeerSummary(table, th) {
  const { adj, rows } = adjAt(table, th);
  let totalPeerSuggestions = 0;
  let usersWithAny = 0;
  let usersByBucket = { '0':0, '1-3':0, '4-10':0, '11+':0 };
  for (const [, wallets] of userToWallets) {
    const set = new Set(wallets);
    const peers = new Set();
    for (const w of wallets) {
      for (const p of (adj.get(w) || [])) if (!set.has(p)) peers.add(p);
    }
    totalPeerSuggestions += peers.size;
    if (peers.size > 0) usersWithAny++;
    const k = peers.size === 0 ? '0' : peers.size <= 3 ? '1-3' : peers.size <= 10 ? '4-10' : '11+';
    usersByBucket[k]++;
  }
  // Cross-trader exposure: edges where both endpoints are claimed-Matrica-non-autoshell
  // and the two users disagree (real FP per Matrica).
  let realFp = 0;
  let fpUserPairs = new Set();
  for (const r of rows) {
    const ua = walletToUser.get(r.addr_a);
    const ub = walletToUser.get(r.addr_b);
    if (!ua || !ub || ua === ub) continue;
    if (autoShellUsers.has(ua) || autoShellUsers.has(ub)) continue;
    realFp++;
    const key = ua < ub ? `${ua}|${ub}` : `${ub}|${ua}`;
    fpUserPairs.add(key);
  }
  return { totalPeerSuggestions, usersWithAny, usersByBucket, realFp, distinctFpUserPairs: fpUserPairs.size };
}

console.log('=== DISPLAY-THRESHOLD COMPARISON ===\n');
console.log('Per-user "likely linked" peer counts on holder profile pages, varying the public threshold.\n');
console.log('| table | th | users w/ ≥1 peer | total peer suggestions | bucket: 0 / 1-3 / 4-10 / 11+ | real-FP edges | distinct-user-pair FPs |');
console.log('|-------|----|------------------|------------------------|------------------------------|---------------|------------------------|');

for (const table of ['wallet_cluster_edges', 'wallet_cluster_edges_v2']) {
  for (const th of [9500, 9700, 9900]) {
    const r = userPeerSummary(table, th);
    const tag = table === 'wallet_cluster_edges' ? 'v1' : 'v2';
    console.log(`| ${tag} | ${th} | ${r.usersWithAny} | ${r.totalPeerSuggestions} | ${r.usersByBucket['0']} / ${r.usersByBucket['1-3']} / ${r.usersByBucket['4-10']} / ${r.usersByBucket['11+']} | ${r.realFp} | ${r.distinctFpUserPairs} |`);
  }
}

// Also: show top 5 users by peer count at each threshold (v2)
console.log('\n=== TOP USERS BY DISCOVERED PEERS (v2 only) ===\n');
for (const th of [9500, 9700, 9900]) {
  const { adj } = adjAt('wallet_cluster_edges_v2', th);
  const arr = [];
  for (const [uid, wallets] of userToWallets) {
    const set = new Set(wallets);
    const peers = new Set();
    for (const w of wallets) for (const p of (adj.get(w) || [])) if (!set.has(p)) peers.add(p);
    if (peers.size > 0) arr.push({ uid, n: peers.size });
  }
  arr.sort((a,b) => b.n - a.n);
  console.log(`Top 5 @ th=${th}:`);
  for (const e of arr.slice(0,5)) {
    const u = userInfo.get(e.uid);
    const flag = autoShellUsers.has(e.uid) ? ' (auto-shell)' : '';
    console.log(`  ${e.n.toString().padStart(4)} peers — ${u && u.username || e.uid}${flag}`);
  }
  console.log('');
}

db.close();
