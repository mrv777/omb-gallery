#!/usr/bin/env node
/* Cross-check new-vault relaxed-rule matches against Liquidium resolution events. */
const fs = require('node:fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.OMB_DB_PATH || '/data/app.db';
const KNOWN_VAULTS_PATH = process.env.KNOWN_VAULTS_PATH || '/tmp/known-vaults.txt';
const DRYRUN_PATH = process.env.DRYRUN_PATH || '/tmp/dryrun-result.json';

const { rpcUrl, rpcAuth } = (() => {
  const u = new URL(process.env.BITCOIN_RPC_URL);
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  u.username = '';
  u.password = '';
  return {
    rpcUrl: u.toString(),
    rpcAuth: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
  };
})();

let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: rpcAuth },
    body: JSON.stringify({ jsonrpc: '1.0', id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

async function main() {
  const dryrun = JSON.parse(fs.readFileSync(DRYRUN_PATH, 'utf8'));
  const knownVaults = new Set(
    fs.readFileSync(KNOWN_VAULTS_PATH, 'utf8').split('\n').filter(Boolean)
  );
  const newVaultMatches = dryrun.new_matches.filter(m => !knownVaults.has(m.vault));
  console.error(`new-vault matches to verify: ${newVaultMatches.length}`);

  // Pull each tx, get vout[0] address (escrow).
  for (const m of newVaultMatches) {
    const tx = await rpc('getrawtransaction', [m.txid, 2]);
    m.escrow = tx.vout[0].scriptPubKey.address;
  }

  // For each escrow, query the DB for any resolution event whose raw_json
  // contains it (match on escrow_addr field exactly).
  const db = new Database(DB_PATH, { readonly: true });
  const stmt = db.prepare(
    `SELECT event_type, txid, json_extract(raw_json,'$.source') AS src
       FROM events
      WHERE event_type IN ('loan-repaid','loan-defaulted','loan-unlocked')
        AND (
          json_extract(raw_json,'$.escrow_addr') = ?
          OR json_extract(raw_json,'$.lock_addr') = ?
          OR json_extract(raw_json,'$.escrowAddr') = ?
        )`
  );

  const rows = [];
  for (const m of newVaultMatches) {
    const resolutions = stmt.all(m.escrow, m.escrow, m.escrow);
    rows.push({
      txid: m.txid,
      vault: m.vault,
      escrow: m.escrow,
      inscription: m.inscriptions[0]?.n,
      payout: m.payoutClass,
      vin: m.vinCount,
      resolutions: resolutions.length,
      resolution_sources: [...new Set(resolutions.map(r => r.src))].join(','),
    });
  }

  // Aggregate by vault.
  const byVault = new Map();
  for (const r of rows) {
    if (!byVault.has(r.vault)) byVault.set(r.vault, { matches: 0, with_resolution: 0 });
    const v = byVault.get(r.vault);
    v.matches++;
    if (r.resolutions > 0) v.with_resolution++;
  }

  console.log(
    JSON.stringify(
      {
        by_vault: [...byVault.entries()]
          .map(([vault, v]) => ({
            vault,
            matches: v.matches,
            with_resolution: v.with_resolution,
            pct_resolved: ((v.with_resolution / v.matches) * 100).toFixed(0) + '%',
          }))
          .sort((a, b) => b.matches - a.matches),
        rows,
        summary: {
          total_new_vault_matches: rows.length,
          with_resolution: rows.filter(r => r.resolutions > 0).length,
          without_resolution: rows.filter(r => r.resolutions === 0).length,
        },
      },
      null,
      2
    )
  );
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
