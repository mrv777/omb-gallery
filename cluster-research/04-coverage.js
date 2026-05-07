#!/usr/bin/env node
/* eslint-disable */
// Compute coverage stats for v1 vs v2 and per-user recall comparison.

const Database = require('better-sqlite3');
const fs = require('node:fs');
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

function uf() {
  const parent = new Map();
  const find = (x) => { let p=parent.get(x); if(p===undefined){parent.set(x,x);return x;} if(p===x)return x; const r=find(p); parent.set(x,r); return r; };
  const union = (a,b) => { const ra=find(a); const rb=find(b); if(ra!==rb)parent.set(ra,rb); };
  return { find, union, parent };
}

function loadUf(table, th) {
  const rows = db.prepare(`SELECT addr_a, addr_b FROM ${table} WHERE confidence >= ?`).all(th);
  const u = uf();
  for (const r of rows) u.union(r.addr_a, r.addr_b);
  return u;
}

console.log('=== v1 vs v2 SIDE-BY-SIDE CALIBRATION ===\n');
const v1All = db.prepare(`SELECT addr_a, addr_b, confidence FROM wallet_cluster_edges`).all();
const v2All = db.prepare(`SELECT addr_a, addr_b, confidence FROM wallet_cluster_edges_v2`).all();

const ths = [9000, 9500, 9700, 9900];
const rows = [];
for (const th of ths) {
  for (const [name, edges] of [['v1', v1All], ['v2', v2All]]) {
    let tp=0, fp=0, auto=0, unk=0;
    for (const e of edges) {
      if (e.confidence < th) continue;
      const ua = walletToUser.get(e.addr_a);
      const ub = walletToUser.get(e.addr_b);
      if (ua && ub) {
        if (ua === ub) tp++;
        else if (autoShellUsers.has(ua) || autoShellUsers.has(ub)) auto++;
        else fp++;
      } else unk++;
    }
    const known = tp + fp;
    const prec = known === 0 ? null : tp / known;

    const u = uf();
    for (const e of edges) if (e.confidence >= th) u.union(e.addr_a, e.addr_b);
    let recovered = 0; let total = 0;
    for (const wallets of userToWallets.values()) {
      if (wallets.length < 2) continue;
      total += wallets.length * (wallets.length - 1) / 2;
      for (let i = 0; i < wallets.length; i++)
        for (let j = i + 1; j < wallets.length; j++)
          if (u.find(wallets[i]) === u.find(wallets[j])) recovered++;
    }
    rows.push({ ver: name, th, total_edges: tp+fp+auto+unk, tp, fp, auto, unk, precision: prec, recall: recovered/total, recovered, total });
  }
}

// Markdown table
console.log('| ver | th | edges | tp | fp | auto | unk | precision | recall (pairs) |');
console.log('|-----|-----|-------|----|----|------|-----|-----------|----------------|');
for (const r of rows) {
  console.log(`| ${r.ver} | ${r.th} | ${r.total_edges} | ${r.tp} | ${r.fp} | ${r.auto} | ${r.unk} | ${r.precision === null ? 'n/a' : (r.precision*100).toFixed(2)+'%'} | ${(r.recall*100).toFixed(2)}% (${r.recovered}/${r.total}) |`);
}

// Coverage: edges where neither endpoint is in Matrica.
console.log('\n=== COVERAGE (unknown-pair edges by threshold) ===');
console.log('"Unknown" = at least one endpoint is NOT in wallet_links — these are wallets v2 surfaces that Matrica has no opinion on.');
for (const th of ths) {
  let v1unk = 0, v2unk = 0;
  for (const e of v1All) if (e.confidence >= th && !(walletToUser.get(e.addr_a) && walletToUser.get(e.addr_b))) v1unk++;
  for (const e of v2All) if (e.confidence >= th && !(walletToUser.get(e.addr_a) && walletToUser.get(e.addr_b))) v2unk++;
  console.log(`  th=${th}: v1 unknown-edges=${v1unk}  v2 unknown-edges=${v2unk}  (v2/v1 = ${v1unk === 0 ? 'inf' : (v2unk/v1unk).toFixed(1) + 'x'})`);
}

console.log('\n=== PER-USER RECALL @ th=9500 (top 20 multi-wallet users) ===');
const v2u = uf();
for (const e of v2All) if (e.confidence >= 9500) v2u.union(e.addr_a, e.addr_b);
const v1u = uf();
for (const e of v1All) if (e.confidence >= 9500) v1u.union(e.addr_a, e.addr_b);
const userRecall = [];
for (const [uid, wallets] of userToWallets) {
  if (wallets.length < 2 || autoShellUsers.has(uid)) continue;
  const userPairs = wallets.length * (wallets.length - 1) / 2;
  let v1r=0, v2r=0;
  for (let i=0;i<wallets.length;i++) for (let j=i+1;j<wallets.length;j++) {
    if (v1u.find(wallets[i]) === v1u.find(wallets[j])) v1r++;
    if (v2u.find(wallets[i]) === v2u.find(wallets[j])) v2r++;
  }
  userRecall.push({ uid, username: userInfo.get(uid).username, n: wallets.length, total: userPairs, v1: v1r, v2: v2r });
}
userRecall.sort((a,b) => b.n - a.n);
console.log('| user | n_wallets | total_pairs | v1 | v2 | v2 recall |');
console.log('|------|-----------|-------------|----|----|-----------|');
for (const u of userRecall.slice(0, 20)) {
  console.log(`| ${u.username} | ${u.n} | ${u.total} | ${u.v1} | ${u.v2} | ${(u.v2/u.total*100).toFixed(1)}% |`);
}

const fullRecallV2 = userRecall.filter(u => u.v2 === u.total).length;
const partialRecallV2 = userRecall.filter(u => u.v2 > 0 && u.v2 < u.total).length;
const zeroRecallV2 = userRecall.filter(u => u.v2 === 0).length;
const fullRecallV1 = userRecall.filter(u => u.v1 === u.total).length;
const partialRecallV1 = userRecall.filter(u => u.v1 > 0 && u.v1 < u.total).length;
const zeroRecallV1 = userRecall.filter(u => u.v1 === 0).length;
console.log(`\nv1 @ 9500: ${userRecall.length} users — full=${fullRecallV1} partial=${partialRecallV1} zero=${zeroRecallV1}`);
console.log(`v2 @ 9500: ${userRecall.length} users — full=${fullRecallV2} partial=${partialRecallV2} zero=${zeroRecallV2}`);

db.close();
