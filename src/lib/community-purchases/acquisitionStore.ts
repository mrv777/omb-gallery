import 'server-only';

import {
  assertCommunityVaultAcquisitionPlan,
  assertCommunityVaultAcquisitionPreflight,
  combineCommunityVaultAcquisitionPsbts,
  constructCommunityVaultAcquisitionPsbt,
  finalizeCommunityVaultAcquisitionPsbt,
  validateCommunityVaultAcquisitionPsbt,
} from '@drey/core/domain/community-vault/acquisition';
import type {
  CommunityVaultAcquisitionPlanV1,
  CommunityVaultAcquisitionPreflightV1,
} from '@drey/core/domain/community-vault/acquisition-contracts';
import {
  assertCommunityVaultPolicy,
  serializeCommunityVaultPolicy,
} from '@drey/core/domain/community-vault/policy';
import type { CommunityVaultPolicyV1 } from '@drey/core/domain/community-vault/contracts';
import { bytesToHex } from '@drey/core/domain/vault/encoding';
import { getDb } from '@/lib/db';
import { fetchInscriptionDetail, fetchOutputConfirmations } from '@/lib/ord';
import {
  COMMUNITY_PURCHASES_PROTOCOL,
  type ApproveAcquisitionPayloadV1,
  type CommunityCampaignView,
} from './contracts';
import { CommunityPurchaseError, getCommunityCampaign } from './store';
import { installPublicPolicyCrypto } from './dreyCrypto';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HEX_32 = /^[0-9a-f]{64}$/u;
const NONCE = /^[A-Za-z0-9._:-]{1,128}$/u;
const ACTION_WINDOW_SEC = 15 * 60;

type AcquisitionRow = {
  campaign_id: string;
  plan_digest: string;
  plan_json: string;
  preflight_json: string;
  signing_psbt_hex: string;
  base_psbt_hex: string;
  status: 'signing' | 'ready' | 'expired' | 'failed';
  expires_at_ms: number;
};

export type ReadyCommunityAcquisition = {
  campaignId: string;
  planDigest: string;
  transactionHex: string;
  txid: string;
  vaultOutpoint: string;
};

export function getReadyCommunityAcquisition(campaignId: string): ReadyCommunityAcquisition {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT a.plan_digest, a.plan_json, a.transaction_hex, a.txid, a.status,
              c.status AS campaign_status
       FROM community_acquisitions a
       JOIN community_campaigns c ON c.id = a.campaign_id
       WHERE a.campaign_id = ?`
    )
    .get(campaignId) as
    | {
        plan_digest: string;
        plan_json: string;
        transaction_hex: string | null;
        txid: string | null;
        status: string;
        campaign_status: string;
      }
    | undefined;
  if (
    !row ||
    row.status !== 'ready' ||
    !row.transaction_hex ||
    !row.txid ||
    !['signing', 'broadcast'].includes(row.campaign_status)
  ) {
    throw new CommunityPurchaseError(
      'acquisition-not-ready',
      'The acquisition transaction is not ready for an authorized broadcaster.',
      409
    );
  }
  const plan = JSON.parse(row.plan_json) as CommunityVaultAcquisitionPlanV1;
  return {
    campaignId,
    planDigest: row.plan_digest,
    transactionHex: row.transaction_hex,
    txid: row.txid,
    vaultOutpoint: `${row.txid}:${plan.vaultOutputIndex}`,
  };
}

export function recordCommunityAcquisitionBroadcast(args: {
  campaignId: string;
  txid: string;
  now?: number;
}): CommunityCampaignView {
  const now = args.now ?? Math.floor(Date.now() / 1000);
  const ready = getReadyCommunityAcquisition(args.campaignId);
  if (args.txid !== ready.txid) {
    throw new CommunityPurchaseError(
      'broadcast-txid-mismatch',
      'The observed broadcast does not match the exact finalized acquisition.',
      409
    );
  }
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `UPDATE community_campaigns SET status = 'broadcast', updated_at = ?
       WHERE id = ? AND status = 'signing'`
    ).run(now, args.campaignId);
    db.prepare(
      `INSERT INTO community_campaign_events
       (campaign_id, event_type, detail_json, created_at)
       VALUES (?, 'acquisition-broadcast-observed', ?, ?)`
    ).run(args.campaignId, JSON.stringify({ txid: args.txid }), now);
  })();
  return requireCampaign(args.campaignId, now);
}

export async function confirmCommunityAcquisitionHeld(args: {
  campaignId: string;
  minimumConfirmations?: number;
  now?: number;
  fetchDetail?: typeof fetchInscriptionDetail;
  fetchConfirmations?: typeof fetchOutputConfirmations;
}): Promise<CommunityCampaignView> {
  const now = args.now ?? Math.floor(Date.now() / 1000);
  const minimumConfirmations = args.minimumConfirmations ?? 1;
  if (
    !Number.isInteger(minimumConfirmations) ||
    minimumConfirmations < 1 ||
    minimumConfirmations > 100
  ) {
    throw new CommunityPurchaseError('confirmations-invalid', 'Confirmation target is invalid.');
  }
  const db = getDb();
  const row = db
    .prepare(
      `SELECT c.inscription_id, c.status, c.vault_address, a.plan_json, a.txid, a.status AS acquisition_status
       FROM community_campaigns c
       JOIN community_acquisitions a ON a.campaign_id = c.id
       WHERE c.id = ?`
    )
    .get(args.campaignId) as
    | {
        inscription_id: string;
        status: string;
        vault_address: string | null;
        plan_json: string;
        txid: string | null;
        acquisition_status: string;
      }
    | undefined;
  if (
    !row ||
    row.status !== 'broadcast' ||
    row.acquisition_status !== 'ready' ||
    !row.txid ||
    !row.vault_address
  ) {
    throw new CommunityPurchaseError(
      'acquisition-not-broadcast',
      'The exact acquisition must be observed as broadcast before confirmation.',
      409
    );
  }
  const plan = JSON.parse(row.plan_json) as CommunityVaultAcquisitionPlanV1;
  const expectedOutpoint = `${row.txid}:${plan.vaultOutputIndex}`;
  const detail = await (args.fetchDetail ?? fetchInscriptionDetail)(row.inscription_id);
  const confirmations = await (args.fetchConfirmations ?? fetchOutputConfirmations)(
    expectedOutpoint
  );
  if (
    detail.inscription_id !== row.inscription_id ||
    detail.output !== expectedOutpoint ||
    detail.address !== row.vault_address ||
    confirmations === null ||
    confirmations < minimumConfirmations
  ) {
    throw new CommunityPurchaseError(
      'acquisition-not-confirmed',
      'The Ordinal is not yet confirmed at the exact Community Vault output.',
      409
    );
  }
  db.transaction(() => {
    db.prepare(
      `UPDATE community_campaigns
       SET status = 'held', current_outpoint = ?, updated_at = ?
       WHERE id = ? AND status = 'broadcast'`
    ).run(expectedOutpoint, now, args.campaignId);
    db.prepare(
      `INSERT INTO community_campaign_events
       (campaign_id, event_type, detail_json, created_at)
       VALUES (?, 'acquisition-confirmed', ?, ?)`
    ).run(
      args.campaignId,
      JSON.stringify({ txid: row.txid, outpoint: expectedOutpoint, confirmations }),
      now
    );
  })();
  return requireCampaign(args.campaignId, now);
}

export function publishCommunityAcquisition(args: {
  campaignId: string;
  policy: CommunityVaultPolicyV1;
  plan: CommunityVaultAcquisitionPlanV1;
  preflight: CommunityVaultAcquisitionPreflightV1;
  basePsbtHex: string;
  nowMs?: number;
}): CommunityCampaignView {
  installPublicPolicyCrypto();
  const nowMs = args.nowMs ?? Date.now();
  const db = getDb();
  const campaign = db
    .prepare(`SELECT * FROM community_campaigns WHERE id = ?`)
    .get(args.campaignId) as
    | {
        id: string;
        status: CommunityCampaignView['status'];
        source: 'listed' | 'creator-fronted';
        policy_json: string | null;
        policy_id: string | null;
        cap_table_hash: string | null;
        cap_table_version: number;
        expires_at: number;
        marketplace: string | null;
        listing_id: string | null;
        source_fingerprint: string;
        landed_cost_sats: number;
        max_landed_cost_sats: number;
      }
    | undefined;
  if (!campaign || !campaign.policy_json || !campaign.policy_id || !campaign.cap_table_hash) {
    throw new CommunityPurchaseError('campaign-not-frozen', 'The cap table is not frozen.', 409);
  }
  if (campaign.status !== 'frozen' && campaign.status !== 'signing') {
    throw new CommunityPurchaseError(
      'campaign-not-signable',
      'This campaign is not accepting an acquisition plan.',
      409
    );
  }
  const frozen = JSON.parse(campaign.policy_json) as CommunityVaultPolicyV1;
  assertCommunityVaultPolicy(frozen);
  assertCommunityVaultPolicy(args.policy);
  if (
    bytesToHex(serializeCommunityVaultPolicy(frozen)) !==
    bytesToHex(serializeCommunityVaultPolicy(args.policy))
  ) {
    throw new CommunityPurchaseError(
      'policy-mismatch',
      'The acquisition policy differs from the frozen cap table.',
      409
    );
  }
  assertCommunityVaultAcquisitionPlan(frozen, args.plan);
  assertCommunityVaultAcquisitionPreflight({
    policy: frozen,
    plan: args.plan,
    preflight: args.preflight,
    nowMs: String(nowMs),
  });
  if (
    args.plan.campaignId !== campaign.id ||
    args.plan.source !== campaign.source ||
    args.plan.capTableVersion !== campaign.cap_table_version ||
    args.plan.policyId !== campaign.policy_id ||
    args.plan.capTableHash !== campaign.cap_table_hash ||
    Number(args.plan.expiresAtMs) > campaign.expires_at * 1000
  ) {
    throw new CommunityPurchaseError(
      'plan-campaign-mismatch',
      'The exact acquisition plan differs from this campaign.',
      409
    );
  }
  if (
    BigInt(args.plan.totalEconomicCostSats) > BigInt(campaign.max_landed_cost_sats) ||
    (campaign.source === 'listed' &&
      (args.plan.listedTerms?.marketplaceId !== campaign.marketplace ||
        args.plan.listedTerms.listingId !== campaign.listing_id ||
        args.plan.listedTerms.listingFingerprintHex !== campaign.source_fingerprint ||
        args.plan.listedTerms.maximumLandedCostSats !== String(campaign.max_landed_cost_sats))) ||
    (campaign.source === 'creator-fronted' &&
      args.plan.frontedTerms?.verifiedLandedCostSats !== String(campaign.landed_cost_sats))
  ) {
    throw new CommunityPurchaseError(
      'acquisition-economics-mismatch',
      'The acquisition economics differ from the campaign’s verified source and maximum.',
      409
    );
  }
  assertCommittedFundingInputs(db, campaign.id, args.plan);
  const signingPsbtHex = constructCommunityVaultAcquisitionPsbt(frozen, args.plan);
  const base = validateCommunityVaultAcquisitionPsbt(
    frozen,
    args.plan,
    normalizeHex(args.basePsbtHex)
  );
  const baseOwnerSignatures = base.signedInputIndexes.filter(
    index => args.plan.inputs[index]?.ownerId !== null
  );
  if (
    baseOwnerSignatures.length > 0 ||
    (args.plan.source === 'listed' &&
      !base.signedInputIndexes.includes(args.plan.assetInputIndex)) ||
    (args.plan.source === 'creator-fronted' && base.signedInputIndexes.length > 0)
  ) {
    throw new CommunityPurchaseError(
      'base-signature-profile-invalid',
      args.plan.source === 'listed'
        ? 'The listed acquisition must contain only the seller asset signature.'
        : 'The creator-fronted acquisition must begin unsigned.',
      409
    );
  }
  const existing = db
    .prepare(`SELECT * FROM community_acquisitions WHERE campaign_id = ?`)
    .get(campaign.id) as AcquisitionRow | undefined;
  if (existing) {
    if (
      existing.plan_digest !== args.plan.planDigest ||
      existing.base_psbt_hex !== base.psbtHex ||
      existing.preflight_json !== JSON.stringify(args.preflight)
    ) {
      throw new CommunityPurchaseError(
        'acquisition-already-published',
        'A different immutable acquisition plan is already signing.',
        409
      );
    }
    return requireCampaign(campaign.id, Math.floor(nowMs / 1000));
  }
  const now = Math.floor(nowMs / 1000);
  db.transaction(() => {
    db.prepare(
      `INSERT INTO community_acquisitions (
         campaign_id, plan_digest, plan_json, preflight_json, signing_psbt_hex,
         base_psbt_hex, status, expires_at_ms, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'signing', ?, ?, ?)`
    ).run(
      campaign.id,
      args.plan.planDigest,
      JSON.stringify(args.plan),
      JSON.stringify(args.preflight),
      signingPsbtHex,
      base.psbtHex,
      Number(args.plan.expiresAtMs),
      now,
      now
    );
    db.prepare(
      `UPDATE community_campaigns SET status = 'signing', updated_at = ? WHERE id = ?`
    ).run(now, campaign.id);
    db.prepare(
      `INSERT INTO community_campaign_events
       (campaign_id, event_type, detail_json, created_at)
       VALUES (?, 'acquisition-published', ?, ?)`
    ).run(
      campaign.id,
      JSON.stringify({ planDigest: args.plan.planDigest, source: args.plan.source }),
      now
    );
  })();
  return requireCampaign(campaign.id, now);
}

function assertCommittedFundingInputs(
  db: ReturnType<typeof getDb>,
  campaignId: string,
  plan: CommunityVaultAcquisitionPlanV1
): void {
  const rows = db
    .prepare(
      `SELECT p.owner_id, p.funding_outpoints_json
       FROM community_participants p
       WHERE p.campaign_id = ? AND p.readiness_status = 'ready'
         AND EXISTS (SELECT 1 FROM community_units u WHERE u.participant_id = p.id)
       ORDER BY p.cap_table_order, p.id`
    )
    .all(campaignId) as Array<{ owner_id: string; funding_outpoints_json: string | null }>;
  for (const row of rows) {
    const committed = parseCommittedOutpoints(row.funding_outpoints_json);
    const planned = plan.inputs
      .filter(input => input.ownerId === row.owner_id)
      .map(input => `${input.txid}:${input.vout}`)
      .toSorted();
    if (JSON.stringify(planned) !== JSON.stringify(committed)) {
      throw new CommunityPurchaseError(
        'funding-commitment-mismatch',
        `The acquisition inputs for ${row.owner_id} differ from readiness. Restart readiness.`,
        409
      );
    }
  }
}

function parseCommittedOutpoints(raw: string | null): string[] {
  try {
    const parsed = JSON.parse(raw ?? '') as unknown;
    if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string'))
      throw new Error();
    return (parsed as string[]).toSorted();
  } catch {
    throw new CommunityPurchaseError(
      'funding-commitment-invalid',
      'A selected owner does not have a valid readiness commitment.',
      409
    );
  }
}

export function submitCommunityAcquisitionApproval(args: {
  campaignId: string;
  payload: ApproveAcquisitionPayloadV1;
  signature: string;
  walletAddress: string;
  signedPsbtBase64: string;
  now?: number;
}): CommunityCampaignView {
  installPublicPolicyCrypto();
  const now = args.now ?? Math.floor(Date.now() / 1000);
  validateApprovalPayload(args.payload, args.campaignId, now);
  const db = getDb();
  const campaign = db
    .prepare(`SELECT policy_json, cap_table_version, status FROM community_campaigns WHERE id = ?`)
    .get(args.campaignId) as
    | { policy_json: string | null; cap_table_version: number; status: string }
    | undefined;
  const acquisition = db
    .prepare(`SELECT * FROM community_acquisitions WHERE campaign_id = ?`)
    .get(args.campaignId) as AcquisitionRow | undefined;
  if (!campaign?.policy_json || !acquisition) {
    throw new CommunityPurchaseError(
      'acquisition-unavailable',
      'The exact acquisition is not ready for approval.',
      409
    );
  }
  if (
    campaign.status !== 'signing' ||
    acquisition.status !== 'signing' ||
    acquisition.expires_at_ms <= now * 1000
  ) {
    expireAcquisition(args.campaignId, now);
    throw new CommunityPurchaseError(
      'acquisition-expired',
      'This acquisition approval window has closed.',
      409
    );
  }
  if (
    args.payload.capTableVersion !== campaign.cap_table_version ||
    args.payload.planDigest !== acquisition.plan_digest
  ) {
    throw new CommunityPurchaseError(
      'acquisition-plan-changed',
      'The acquisition changed before approval.',
      409
    );
  }
  const participant = db
    .prepare(
      `SELECT owner_id, wallet_address FROM community_participants
       WHERE campaign_id = ? AND owner_id = ? AND readiness_status = 'ready'`
    )
    .get(args.campaignId, args.payload.ownerId) as
    | { owner_id: string; wallet_address: string }
    | undefined;
  if (!participant || participant.wallet_address !== args.walletAddress) {
    throw new CommunityPurchaseError(
      'owner-auth-mismatch',
      'This wallet is not the selected Community Vault owner.',
      403
    );
  }
  const policy = JSON.parse(campaign.policy_json) as CommunityVaultPolicyV1;
  const plan = JSON.parse(acquisition.plan_json) as CommunityVaultAcquisitionPlanV1;
  const signedPsbtHex = base64PsbtToHex(args.signedPsbtBase64);
  const validation = validateCommunityVaultAcquisitionPsbt(policy, plan, signedPsbtHex);
  const expectedIndexes = plan.inputs
    .map((input, index) => (input.ownerId === participant.owner_id ? index : -1))
    .filter(index => index >= 0);
  if (
    expectedIndexes.length === 0 ||
    JSON.stringify(validation.signedInputIndexes) !== JSON.stringify(expectedIndexes) ||
    validation.psbtHash !== args.payload.signedPsbtHash
  ) {
    throw new CommunityPurchaseError(
      'owner-signature-mismatch',
      'Drey did not sign every and only this owner’s acquisition inputs.',
      409
    );
  }
  const prior = db
    .prepare(
      `SELECT psbt_hash FROM community_acquisition_signatures
       WHERE campaign_id = ? AND owner_id = ?`
    )
    .get(args.campaignId, participant.owner_id) as { psbt_hash: string } | undefined;
  if (prior) {
    if (prior.psbt_hash !== validation.psbtHash) {
      throw new CommunityPurchaseError(
        'owner-already-approved',
        'This owner already approved a different signature package.',
        409
      );
    }
    return requireCampaign(args.campaignId, now);
  }
  db.transaction(() => {
    db.prepare(
      `INSERT INTO community_acquisition_signatures (
         campaign_id, owner_id, psbt_hash, signed_psbt_hex, signed_indexes_json,
         approval_payload_json, approval_signature, approval_nonce, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      args.campaignId,
      participant.owner_id,
      validation.psbtHash,
      validation.psbtHex,
      JSON.stringify(validation.signedInputIndexes),
      JSON.stringify(args.payload),
      args.signature,
      args.payload.nonce,
      now
    );
    db.prepare(
      `INSERT INTO community_campaign_events
       (campaign_id, event_type, owner_id, detail_json, created_at)
       VALUES (?, 'acquisition-approved', ?, ?, ?)`
    ).run(
      args.campaignId,
      participant.owner_id,
      JSON.stringify({
        psbtHash: validation.psbtHash,
        inputIndexes: validation.signedInputIndexes,
      }),
      now
    );
  })();
  combineAvailableApprovals(args.campaignId, policy, plan, acquisition, now);
  return requireCampaign(args.campaignId, now);
}

function combineAvailableApprovals(
  campaignId: string,
  policy: CommunityVaultPolicyV1,
  plan: CommunityVaultAcquisitionPlanV1,
  acquisition: AcquisitionRow,
  now: number
): void {
  const db = getDb();
  const packages = (
    db
      .prepare(
        `SELECT signed_psbt_hex FROM community_acquisition_signatures
       WHERE campaign_id = ? ORDER BY owner_id`
      )
      .all(campaignId) as Array<{ signed_psbt_hex: string }>
  ).map(row => row.signed_psbt_hex);
  const base = validateCommunityVaultAcquisitionPsbt(policy, plan, acquisition.base_psbt_hex);
  if (base.signedInputIndexes.length > 0) packages.push(base.psbtHex);
  if (packages.length === 0) return;
  const combined = combineCommunityVaultAcquisitionPsbts({
    policy,
    plan,
    psbtHexes: packages,
  });
  if (combined.signedInputIndexes.length !== plan.inputs.length) {
    db.prepare(
      `UPDATE community_acquisitions
       SET combined_psbt_hex = ?, updated_at = ? WHERE campaign_id = ?`
    ).run(combined.psbtHex, now, campaignId);
    return;
  }
  const finalized = finalizeCommunityVaultAcquisitionPsbt({
    policy,
    plan,
    psbtHex: combined.psbtHex,
  });
  db.transaction(() => {
    db.prepare(
      `UPDATE community_acquisitions
       SET status = 'ready', combined_psbt_hex = ?, transaction_hex = ?, txid = ?, updated_at = ?
       WHERE campaign_id = ? AND status = 'signing'`
    ).run(finalized.psbtHex, finalized.transactionHex, finalized.txid, now, campaignId);
    db.prepare(
      `INSERT INTO community_campaign_events
       (campaign_id, event_type, detail_json, created_at)
       VALUES (?, 'acquisition-ready', ?, ?)`
    ).run(
      campaignId,
      JSON.stringify({
        txid: finalized.txid,
        weight: finalized.weight,
        vsize: finalized.vsize,
        feeSats: finalized.feeSats,
      }),
      now
    );
  })();
}

function validateApprovalPayload(
  payload: ApproveAcquisitionPayloadV1,
  campaignId: string,
  now: number
): void {
  if (
    payload.protocol !== COMMUNITY_PURCHASES_PROTOCOL ||
    payload.version !== 1 ||
    payload.network !== 'mainnet' ||
    payload.action !== 'approve-acquisition' ||
    payload.campaignId !== campaignId ||
    !IDENTIFIER.test(payload.ownerId) ||
    !HEX_32.test(payload.planDigest) ||
    !HEX_32.test(payload.signedPsbtHash) ||
    !NONCE.test(payload.nonce) ||
    !Number.isInteger(payload.capTableVersion) ||
    payload.capTableVersion < 1 ||
    !Number.isInteger(payload.approvedAt) ||
    !Number.isInteger(payload.expiresAt) ||
    payload.approvedAt > now + 60 ||
    payload.expiresAt < now ||
    payload.expiresAt - payload.approvedAt > ACTION_WINDOW_SEC
  ) {
    throw new CommunityPurchaseError(
      'approval-invalid',
      'The acquisition approval request is invalid or expired.'
    );
  }
}

function expireAcquisition(campaignId: string, now: number): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `UPDATE community_acquisitions SET status = 'expired', updated_at = ?
       WHERE campaign_id = ? AND status = 'signing'`
    ).run(now, campaignId);
    db.prepare(
      `UPDATE community_campaigns SET status = 'failed', updated_at = ?
       WHERE id = ? AND status = 'signing'`
    ).run(now, campaignId);
  })();
}

function base64PsbtToHex(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1_500_000 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    throw new CommunityPurchaseError('psbt-invalid', 'Drey returned an invalid PSBT.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    throw new CommunityPurchaseError('psbt-invalid', 'Drey returned a non-canonical PSBT.');
  }
  return bytes.toString('hex');
}

function normalizeHex(value: string): string {
  if (!/^(?:[0-9a-f]{2})+$/u.test(value) || value.length > 4_000_000) {
    throw new CommunityPurchaseError('psbt-invalid', 'The acquisition PSBT is invalid.');
  }
  return value;
}

function requireCampaign(id: string, now: number): CommunityCampaignView {
  const campaign = getCommunityCampaign(id, now);
  if (!campaign) throw new CommunityPurchaseError('campaign-not-found', 'Campaign not found.', 404);
  return campaign;
}
