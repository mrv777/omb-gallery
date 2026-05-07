import Database from 'better-sqlite3';
const db = new Database('/tmp/app-snap-v31.db');

// Count events the inferred wallets contribute, per holder profile
const profiles = db.prepare(`
  SELECT mu.user_id, mu.username,
         (SELECT COALESCE(SUM(c), 0) FROM (
            SELECT (SELECT COUNT(*) FROM events WHERE old_owner = wl.wallet_addr OR new_owner = wl.wallet_addr) AS c
              FROM wallet_links wl WHERE wl.matrica_user_id = mu.user_id
         )) AS matrica_events,
         (SELECT COALESCE(SUM(c), 0) FROM (
            SELECT (SELECT COUNT(*) FROM events WHERE old_owner = ca.wallet_addr OR new_owner = ca.wallet_addr) AS c
              FROM cluster_anchors ca
             WHERE ca.matrica_user_id = mu.user_id
               AND ca.wallet_addr NOT IN (SELECT wallet_addr FROM wallet_links WHERE matrica_user_id = mu.user_id)
         )) AS inferred_events
    FROM matrica_users mu
   WHERE EXISTS (SELECT 1 FROM cluster_anchors WHERE matrica_user_id = mu.user_id)
   ORDER BY inferred_events DESC LIMIT 20`).all();

let withInferredEvents = 0; let totalEvents = 0;
for (const p of profiles) {
  if (p.inferred_events > 0) {
    withInferredEvents++;
    totalEvents += p.inferred_events;
    console.log(`  ${(p.username || p.user_id.slice(0,12)).padEnd(20)} matrica_events=${p.matrica_events} +inferred=${p.inferred_events}`);
  }
}
console.log(`\n${withInferredEvents} matrica users gain events from cluster fold (top 20 shown)`);
console.log(`total events folded: ${totalEvents}`);

// And the bag-size chart — does it show intermediate moves now?
const ownChanges = db.prepare(`
  SELECT COUNT(*) AS n FROM ownership_deltas od
   WHERE EXISTS (SELECT 1 FROM cluster_anchors ca WHERE ca.wallet_addr = od.owner)`).get();
console.log(`\nownership-delta rows on cluster wallets: ${ownChanges?.n || '(table missing)'}`);

db.close();
