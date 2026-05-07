const Database = require('better-sqlite3');
const db = new Database('/tmp/app-v2.db', { readonly: true });

const links = db.prepare(`SELECT wl.wallet_addr, wl.matrica_user_id, mu.username FROM wallet_links wl LEFT JOIN matrica_users mu ON mu.user_id = wl.matrica_user_id WHERE wl.matrica_user_id IS NOT NULL`).all();
const walletToUser = new Map();
const userToWallets = new Map();
const autoShellUsers = new Set();
const userInfo = new Map();
for (const r of links) {
  walletToUser.set(r.wallet_addr, r.matrica_user_id);
  let arr = userToWallets.get(r.matrica_user_id);
  if (!arr) { arr=[]; userToWallets.set(r.matrica_user_id, arr); }
  arr.push(r.wallet_addr);
  userInfo.set(r.matrica_user_id, { username: r.username });
  if (!r.username || /^bc1[a-z0-9]{20,}/i.test(r.username) || /^0x[a-fA-F0-9]{40}/.test(r.username)) autoShellUsers.add(r.matrica_user_id);
}

function describe(table, th) {
  const rows = db.prepare(`SELECT addr_a, addr_b FROM ${table} WHERE confidence >= ?`).all(th);
  const parent = new Map();
  const find = (x) => { let p=parent.get(x); if(p===undefined){parent.set(x,x);return x;} if(p===x)return x; const r=find(p); parent.set(x,r); return r; };
  const union = (a,b) => { const ra=find(a); const rb=find(b); if(ra!==rb)parent.set(ra,rb); };
  for (const r of rows) union(r.addr_a, r.addr_b);
  const groups = new Map();
  for (const node of parent.keys()) {
    const root = find(node);
    let g = groups.get(root); if (!g) { g = []; groups.set(root, g); }
    g.push(node);
  }
  let folded=0, extraFolded=0, unlinkedOnly=0, splitSkip=0;
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const mids = new Set();
    for (const m of members) { const u = walletToUser.get(m); if (u) mids.add(u); }
    if (mids.size > 1) { splitSkip++; continue; }
    if (mids.size === 1) {
      folded++;
      const u = Array.from(mids)[0];
      const own = new Set(userToWallets.get(u) || []);
      for (const m of members) if (!own.has(m)) extraFolded++;
    } else unlinkedOnly++;
  }
  return { folded, extraFolded, unlinkedOnly, splitSkip };
}

function peerCounts(table, th) {
  const rows = db.prepare(`SELECT addr_a, addr_b FROM ${table} WHERE confidence >= ?`).all(th);
  const adj = new Map();
  for (const r of rows) {
    if (!adj.has(r.addr_a)) adj.set(r.addr_a, new Set());
    if (!adj.has(r.addr_b)) adj.set(r.addr_b, new Set());
    adj.get(r.addr_a).add(r.addr_b);
    adj.get(r.addr_b).add(r.addr_a);
  }
  let total=0, usersWith=0;
  for (const wallets of userToWallets.values()) {
    const own = new Set(wallets); const peers = new Set();
    for (const w of wallets) for (const p of (adj.get(w)||[])) if (!own.has(p)) peers.add(p);
    total += peers.size;
    if (peers.size > 0) usersWith++;
  }
  return { total, usersWith };
}

console.log('=== Production deltas (worth-it analysis) ===\n');
console.log('| variant | extra folded | unlinked-only | users w/ peers | total peers |');
console.log('|---------|--------------|----------------|----------------|-------------|');
for (const [tag, table] of [['v1','wallet_cluster_edges'],['v2','wallet_cluster_edges_v2'],['v3','wallet_cluster_edges_v3']]) {
  const fold = describe(table, 9900);
  const peers = peerCounts(table, 9500);
  console.log(`| ${tag} | ${fold.extraFolded} | ${fold.unlinkedOnly} | ${peers.usersWith} | ${peers.total} |`);
}

// Concretely: top 10 users gaining extra folds in v2 vs v3
function extraByUser(table, th) {
  const rows = db.prepare(`SELECT addr_a, addr_b FROM ${table} WHERE confidence >= ?`).all(th);
  const parent = new Map();
  const find = (x) => { let p=parent.get(x); if(p===undefined){parent.set(x,x);return x;} if(p===x)return x; const r=find(p); parent.set(x,r); return r; };
  const union = (a,b) => { const ra=find(a); const rb=find(b); if(ra!==rb)parent.set(ra,rb); };
  for (const r of rows) union(r.addr_a, r.addr_b);
  const groups = new Map();
  for (const node of parent.keys()) {
    const root = find(node);
    let g = groups.get(root); if (!g) { g=[]; groups.set(root, g); } g.push(node);
  }
  const out = new Map();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const mids = new Set();
    for (const m of members) { const u = walletToUser.get(m); if (u) mids.add(u); }
    if (mids.size !== 1) continue;
    const u = Array.from(mids)[0];
    const own = new Set(userToWallets.get(u) || []);
    let extra = 0;
    for (const m of members) if (!own.has(m)) extra++;
    if (extra > 0) out.set(u, (out.get(u) || 0) + extra);
  }
  return out;
}

const v1Extra = extraByUser('wallet_cluster_edges', 9900);
const v2Extra = extraByUser('wallet_cluster_edges_v2', 9900);
const v3Extra = extraByUser('wallet_cluster_edges_v3', 9900);
const allUsers = new Set([...v1Extra.keys(), ...v2Extra.keys(), ...v3Extra.keys()]);
const arr = Array.from(allUsers).map(u => ({ u, v1: v1Extra.get(u)||0, v2: v2Extra.get(u)||0, v3: v3Extra.get(u)||0 }));
arr.sort((a,b) => b.v2 - a.v2);
console.log('\n=== Top users gaining extra-folded wallets (v1 vs v2 vs v3) ===');
console.log('| user | v1 | v2 | v3 |');
for (const r of arr.slice(0, 20)) {
  const u = userInfo.get(r.u);
  const flag = autoShellUsers.has(r.u) ? ' (auto-shell)' : '';
  console.log(`| ${(u && u.username || r.u).slice(0,40)}${flag} | ${r.v1} | ${r.v2} | ${r.v3} |`);
}
db.close();
