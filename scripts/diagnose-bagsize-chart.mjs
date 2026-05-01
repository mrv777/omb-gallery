#!/usr/bin/env node
// Diagnostic for bag-size chart anomalies. Aggregates only — never dumps
// raw rows.
//
// Usage: node scripts/diagnose-bagsize-chart.mjs <bc1...address>
//        SSH_HOST=ubuntu@51.195.63.213 (default)
//        DB_PATH=/var/lib/coolify-omb-data/app.db (default)

import { spawnSync } from 'node:child_process';

const SSH_HOST = process.env.SSH_HOST ?? 'ubuntu@51.195.63.213';
const DB_PATH = process.env.DB_PATH ?? '/var/lib/coolify-omb-data/app.db';

const address = process.argv[2];
if (!address || !/^bc1[\w]+$/.test(address)) {
  console.error('usage: diagnose-bagsize-chart.mjs <bc1-address>');
  process.exit(2);
}

function ssh(sql) {
  const r = spawnSync('ssh', [SSH_HOST, `sudo sqlite3 -separator '|' ${DB_PATH}`], {
    input: sql,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error('ssh/sqlite failed:', r.stderr);
    process.exit(1);
  }
  return r.stdout.trim();
}

// 1. Resolve Matrica wallet set
const matricaUserId = ssh(
  `SELECT matrica_user_id FROM wallet_links WHERE wallet_addr='${address}';`
);
let walletList = [address];
if (matricaUserId) {
  const siblings = ssh(
    `SELECT wallet_addr FROM wallet_links WHERE matrica_user_id='${matricaUserId}';`
  )
    .split('\n')
    .filter(Boolean);
  walletList = Array.from(new Set([address, ...siblings]));
}
const walletSqlList = walletList.map(w => `'${w}'`).join(',');
const walletValues = walletList.map(w => `('${w}')`).join(',');

// 2. Current bag size
const currentBagSize = parseInt(
  ssh(
    `SELECT COUNT(*) FROM inscriptions WHERE current_owner IN (${walletSqlList}) AND collection_slug='omb';`
  ),
  10
);

// 3. Aggregate analysis (delta walk under both sort orders, etc.)
const analysis = ssh(`
WITH wallets(w) AS (VALUES ${walletValues}),
deltas AS (
  SELECT e.id AS event_id, e.block_timestamp, +1 AS delta
  FROM events e JOIN inscriptions i ON i.inscription_number = e.inscription_number
  WHERE e.new_owner IN (SELECT w FROM wallets)
    AND e.event_type != 'listed' AND i.collection_slug = 'omb'
  UNION ALL
  SELECT e.id AS event_id, e.block_timestamp, -1 AS delta
  FROM events e JOIN inscriptions i ON i.inscription_number = e.inscription_number
  WHERE e.old_owner IN (SELECT w FROM wallets)
    AND e.event_type != 'listed' AND i.collection_slug = 'omb'
),
aggregated AS (
  SELECT event_id, MIN(block_timestamp) AS block_timestamp, SUM(delta) AS net
  FROM deltas
  GROUP BY event_id
  HAVING SUM(delta) != 0
),
walked_current AS (
  SELECT SUM(net) OVER (ORDER BY block_timestamp ASC, event_id ASC ROWS UNBOUNDED PRECEDING) AS partial
  FROM aggregated
),
walked_proposed AS (
  SELECT SUM(net) OVER (ORDER BY block_timestamp ASC, net DESC, event_id ASC ROWS UNBOUNDED PRECEDING) AS partial
  FROM aggregated
),
mixed_blocks AS (
  SELECT block_timestamp FROM aggregated GROUP BY block_timestamp
  HAVING SUM(CASE WHEN net = 1 THEN 1 ELSE 0 END) > 0
     AND SUM(CASE WHEN net = -1 THEN 1 ELSE 0 END) > 0
)
SELECT
  (SELECT COUNT(*) FROM deltas),
  (SELECT COUNT(*) FROM aggregated),
  (SELECT COUNT(*) FROM (SELECT event_id FROM deltas GROUP BY event_id HAVING SUM(delta)=0)),
  (SELECT COALESCE(SUM(net),0) FROM aggregated),
  (SELECT MIN(partial) FROM walked_current),
  (SELECT MAX(partial) FROM walked_current),
  (SELECT MIN(partial) FROM walked_proposed),
  (SELECT MAX(partial) FROM walked_proposed),
  (SELECT COUNT(*) FROM mixed_blocks)
;
`);

const cols = analysis.split('|').map(s => parseInt(s, 10));
const [
  rawRows,
  eventRows,
  internalDropped,
  sumDeltas,
  minPartialCurrent,
  maxPartialCurrent,
  minPartialProposed,
  maxPartialProposed,
  mixedBlocks,
] = cols;

const baseline = currentBagSize - sumDeltas;

console.log('=== bag-size chart diagnosis ===');
console.log('address           :', address);
console.log('matrica user id   :', matricaUserId || '(none)');
console.log('aggregated wallets:', walletList.length, walletList);
console.log('currentBagSize    :', currentBagSize, '(OMB only)');
console.log();
console.log('raw rows / events / internal dropped:', rawRows, '/', eventRows, '/', internalDropped);
console.log('sumDeltas:', sumDeltas, '  baseline (currentBag - sum):', baseline);
console.log(
  'current sort  -> running min/max:',
  baseline + minPartialCurrent,
  '/',
  baseline + maxPartialCurrent
);
console.log(
  'proposed sort -> running min/max:',
  baseline + minPartialProposed,
  '/',
  baseline + maxPartialProposed
);
console.log('same-block in/out blocks:', mixedBlocks);

// 4. Per-inscription audit: find inscriptions where our recorded deltas
//    don't reconcile with the current ownership (the source of the
//    "phantom" +1s that pull baseline negative).
//
// For each OMB inscription this user touched, compute:
//   net_delta = (#receives by user set) - (#sends by user set)
//   currently_owned = (1 if current_owner is in wallet set else 0)
// Discrepancy = net_delta - currently_owned. Should be 0 in clean data.
//   +1 means: we recorded an extra receive (or missed a send).
//   -1 means: we recorded an extra send (or missed a receive — covered
//             by end-anchoring already, so not chart-breaking).
const audit = ssh(`
WITH wallets(w) AS (VALUES ${walletValues}),
touched AS (
  SELECT DISTINCT e.inscription_number
  FROM events e
  WHERE (e.new_owner IN (SELECT w FROM wallets) OR e.old_owner IN (SELECT w FROM wallets))
    AND e.event_type != 'listed'
),
per_insc AS (
  SELECT t.inscription_number,
    (SELECT COUNT(*) FROM events e2 WHERE e2.inscription_number = t.inscription_number
       AND e2.new_owner IN (SELECT w FROM wallets) AND e2.event_type != 'listed') AS recv,
    (SELECT COUNT(*) FROM events e2 WHERE e2.inscription_number = t.inscription_number
       AND e2.old_owner IN (SELECT w FROM wallets) AND e2.event_type != 'listed') AS sent,
    (SELECT CASE WHEN i.current_owner IN (SELECT w FROM wallets) THEN 1 ELSE 0 END
       FROM inscriptions i WHERE i.inscription_number = t.inscription_number) AS owned_now,
    (SELECT i.collection_slug FROM inscriptions i WHERE i.inscription_number = t.inscription_number) AS slug
  FROM touched t
)
SELECT inscription_number, recv, sent, owned_now, recv - sent - owned_now AS discrepancy
FROM per_insc
WHERE slug = 'omb' AND (recv - sent - owned_now) != 0
ORDER BY discrepancy DESC, inscription_number ASC
LIMIT 20;
`);

console.log();
console.log('=== per-inscription discrepancies (OMB only, top 20) ===');
console.log('inscription | recv | sent | owned_now | discrepancy');
if (!audit) {
  console.log('(none — every OMB the user touched reconciles cleanly)');
} else {
  for (const line of audit.split('\n')) {
    const [num, recv, sent, owned, disc] = line.split('|');
    console.log(
      `#${num.padEnd(10)} | ${recv.padStart(4)} | ${sent.padStart(4)} | ${owned.padStart(9)} | ${disc.padStart(11)}`
    );
  }
}

// 5. For inscriptions with discrepancy > 0, look at the event rows to see
//    if the +1s are duplicates (same txid? same block?). Aggregate-only.
const dupCheck = ssh(`
WITH wallets(w) AS (VALUES ${walletValues}),
sus_inscs AS (
  SELECT t.inscription_number FROM (
    SELECT DISTINCT e.inscription_number FROM events e
    WHERE e.new_owner IN (SELECT w FROM wallets) AND e.event_type != 'listed'
  ) t
  WHERE (
    SELECT COUNT(*) FROM events e2
    WHERE e2.inscription_number = t.inscription_number
      AND e2.new_owner IN (SELECT w FROM wallets) AND e2.event_type != 'listed'
  ) > (
    SELECT COUNT(*) FROM events e3
    WHERE e3.inscription_number = t.inscription_number
      AND e3.old_owner IN (SELECT w FROM wallets) AND e3.event_type != 'listed'
  ) + (
    SELECT CASE WHEN i.current_owner IN (SELECT w FROM wallets) THEN 1 ELSE 0 END
    FROM inscriptions i WHERE i.inscription_number = t.inscription_number
  )
)
SELECT
  (SELECT COUNT(*) FROM sus_inscs) AS sus_count,
  -- For these inscriptions, count distinct txids vs total receive events.
  -- distinct_txids < receives_count → genuine duplicates.
  (SELECT COUNT(*) FROM events e
     WHERE e.inscription_number IN (SELECT inscription_number FROM sus_inscs)
       AND e.new_owner IN (SELECT w FROM wallets)
       AND e.event_type != 'listed') AS total_receives,
  (SELECT COUNT(DISTINCT e.txid || ':' || e.inscription_number) FROM events e
     WHERE e.inscription_number IN (SELECT inscription_number FROM sus_inscs)
       AND e.new_owner IN (SELECT w FROM wallets)
       AND e.event_type != 'listed') AS distinct_receive_txids,
  -- Source breakdown so we know which pipeline put them there
  (SELECT GROUP_CONCAT(DISTINCT COALESCE(json_extract(e.raw_json, '$.source'), 'null'))
     FROM events e
     WHERE e.inscription_number IN (SELECT inscription_number FROM sus_inscs)
       AND e.new_owner IN (SELECT w FROM wallets)
       AND e.event_type != 'listed') AS sources;
`);

console.log();
console.log('=== duplicate / phantom-receive analysis ===');
const [susCount, totalReceives, distinctReceiveTxids, sources] = dupCheck.split('|');
console.log('inscriptions with extra +1s:', susCount);
console.log('  total receive events    :', totalReceives);
console.log('  distinct (txid, insc)   :', distinctReceiveTxids);
console.log('  raw_json sources        :', sources);
if (parseInt(totalReceives, 10) > parseInt(distinctReceiveTxids, 10)) {
  console.log('  ⚠ same (txid, inscription) recorded multiple times → true duplicates');
} else {
  console.log('  → no txid duplication; phantoms come from missed -1 events instead');
}
