import 'server-only';

import { bitcoindConfigured, getTxOut, type TxOut } from '@/lib/bitcoind';
import { getDb } from '@/lib/db';
import { log } from '@/lib/log';
import { invalidateCommunityParticipantFunding } from './store';

const OUTPOINT = /^([0-9a-f]{64}):(0|[1-9][0-9]*)$/u;

export type CommunityFundingTickResult = {
  mode: 'community-funding';
  skipped?: 'not-configured';
  checkedOwners: number;
  checkedOutpoints: number;
  invalidatedOwners: string[];
  errors: number;
};

export async function runCommunityFundingTick(
  args: {
    fetchTxOut?: (txid: string, vout: number) => Promise<TxOut | null>;
    configured?: boolean;
    now?: number;
  } = {}
): Promise<CommunityFundingTickResult> {
  if ((args.configured ?? bitcoindConfigured()) === false) {
    return {
      mode: 'community-funding',
      skipped: 'not-configured',
      checkedOwners: 0,
      checkedOutpoints: 0,
      invalidatedOwners: [],
      errors: 0,
    };
  }
  const fetchOutput = args.fetchTxOut ?? getTxOut;
  const now = args.now ?? Math.floor(Date.now() / 1000);
  const rows = getDb()
    .prepare(
      `SELECT p.campaign_id, p.owner_id, p.funding_outpoints_json
       FROM community_participants p
       JOIN community_campaigns c ON c.id = p.campaign_id
       WHERE c.status IN ('readiness','frozen','signing')
         AND p.readiness_status = 'ready'
         AND p.funding_outpoints_json IS NOT NULL
         AND EXISTS (SELECT 1 FROM community_units u WHERE u.participant_id = p.id)
       ORDER BY p.campaign_id, p.cap_table_order, p.id`
    )
    .all() as Array<{
    campaign_id: string;
    owner_id: string;
    funding_outpoints_json: string;
  }>;
  const result: CommunityFundingTickResult = {
    mode: 'community-funding',
    checkedOwners: 0,
    checkedOutpoints: 0,
    invalidatedOwners: [],
    errors: 0,
  };
  const invalidatedCampaigns = new Set<string>();
  for (const row of rows) {
    if (invalidatedCampaigns.has(row.campaign_id)) continue;
    let outpoints: string[];
    try {
      const parsed = JSON.parse(row.funding_outpoints_json) as unknown;
      if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string'))
        throw new Error();
      outpoints = parsed;
    } catch {
      result.errors++;
      continue;
    }
    result.checkedOwners++;
    let spent = false;
    for (const outpoint of outpoints) {
      const match = OUTPOINT.exec(outpoint);
      if (!match) {
        result.errors++;
        continue;
      }
      result.checkedOutpoints++;
      try {
        if ((await fetchOutput(match[1]!, Number(match[2]))) === null) spent = true;
      } catch (error) {
        // A node or transport failure is not evidence that an owner spent BTC.
        result.errors++;
        log.warn('poll/community-funding', 'funding check failed', {
          campaign_id: row.campaign_id,
          owner_id: row.owner_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!spent) continue;
    try {
      invalidateCommunityParticipantFunding({
        campaignId: row.campaign_id,
        ownerId: row.owner_id,
        reason: 'spent',
        now,
      });
      invalidatedCampaigns.add(row.campaign_id);
      result.invalidatedOwners.push(row.owner_id);
    } catch (error) {
      result.errors++;
      log.warn('poll/community-funding', 'funding invalidation raced campaign state', {
        campaign_id: row.campaign_id,
        owner_id: row.owner_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
