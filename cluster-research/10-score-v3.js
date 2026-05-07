#!/usr/bin/env node
/* eslint-disable */
const Database = require('better-sqlite3');
const db = new Database(process.env.OMB_DB_PATH || '/tmp/app-v2.db', { readonly: true });

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
const autoShellUsers = new Set();
for (const r of links) {
  walletToUser.set(r.wallet_addr, r.matrica_user_id);
  let arr = userToWallets.get(r.matrica_user_id);
  if (!arr) { arr=[]; userToWallets.set(r.matrica_user_id, arr); }
  arr.push(r.wallet_addr);
  if (isAutoShellUsername(r.username)) autoShellUsers.add(r.matrica_user_id);
}
let totalPairs = 0;
for (const w of userToWallets.values()) if (w.length >= 2) totalPairs += w.length*(w.length-1)/2;

function compare(table) {
  const edges = db.prepare(`SELECT addr_a, addr_b, confidence FROM ${table}`).all();
  console.log(`\n=== ${table} (${edges.length} edges) ===`);
  console.log('| th | pairs | tp | fp | auto | unk | precision | recall |');
  console.log('|----|-------|----|----|------|-----|-----------|--------|');
  for (const th of [9000, 9500, 9700, 9900]) {
    let tp=0, fp=0, auto=0, unk=0, pairs=0;
    const parent = new Map();
    const find = (x) => { let p=parent.get(x); if(p===undefined){parent.set(x,x);return x;} if(p===x)return x; const r=find(p); parent.set(x,r); return r; };
    const union = (a,b) => { const ra=find(a); const rb=find(b); if(ra!==rb)parent.set(ra,rb); };
    for (const e of edges) {
      if (e.confidence < th) continue;
      pairs++;
      union(e.addr_a, e.addr_b);
      const ua = walletToUser.get(e.addr_a); const ub = walletToUser.get(e.addr_b);
      if (ua && ub) {
        if (ua === ub) tp++;
        else if (autoShellUsers.has(ua) || autoShellUsers.has(ub)) auto++;
        else fp++;
      } else unk++;
    }
    let recovered = 0;
    for (const wallets of userToWallets.values()) {
      if (wallets.length < 2) continue;
      for (let i=0;i<wallets.length;i++) for (let j=i+1;j<wallets.length;j++)
        if (find(wallets[i]) === find(wallets[j])) recovered++;
    }
    const prec = tp+fp ? tp/(tp+fp) : null;
    console.log(`| ${th} | ${pairs} | ${tp} | ${fp} | ${auto} | ${unk} | ${prec === null ? 'n/a' : (prec*100).toFixed(2)+'%'} | ${(recovered/totalPairs*100).toFixed(2)}% (${recovered}/${totalPairs}) |`);
  }
}
compare('wallet_cluster_edges');
compare('wallet_cluster_edges_v2');
compare('wallet_cluster_edges_v3');

// FP detail at 9500/9900 for v3
console.log('\n=== v3 FPs at 9500 (top 30 by conf) ===');
const fps = db.prepare(`
  SELECT addr_a, addr_b, confidence, cih_count, self_xfer_ab, self_xfer_ba,
         sx_rt_count, co_cons_count, co_parent_count,
         pmx_count, pmx_ab, pmx_ba, pmx_rt_count, pmx_rt_ab, pmx_rt_ba
    FROM wallet_cluster_edges_v3 WHERE confidence >= 9500
`).all();
const fpDetail = [];
for (const e of fps) {
  const ua = walletToUser.get(e.addr_a);
  const ub = walletToUser.get(e.addr_b);
  if (!ua || !ub || ua === ub) continue;
  if (autoShellUsers.has(ua) || autoShellUsers.has(ub)) continue;
  fpDetail.push(e);
}
console.log(`v3 real FPs at 9500: ${fpDetail.length}`);
for (const e of fpDetail.slice(0, 30)) {
  const parts = [];
  if (e.cih_count>0) parts.push(`cih=${e.cih_count}`);
  if (e.self_xfer_ab+e.self_xfer_ba>0) parts.push(`sx=${e.self_xfer_ab}/${e.self_xfer_ba}(rt=${e.sx_rt_count})`);
  if (e.co_cons_count>0) parts.push(`cc=${e.co_cons_count}`);
  if (e.co_parent_count>0) parts.push(`cp=${e.co_parent_count}`);
  if (e.pmx_count>0) parts.push(`pmx=${e.pmx_count}(${e.pmx_ab}/${e.pmx_ba}) rt=${e.pmx_rt_count}(${e.pmx_rt_ab}/${e.pmx_rt_ba})`);
  console.log(`  conf=${e.confidence}  ${parts.join(' ')}`);
}

db.close();
