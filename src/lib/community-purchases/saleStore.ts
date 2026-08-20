import 'server-only';

import {
  assertCommunityVaultSalePlan,
  assertCommunityVaultSalePreflight,
  combineCommunityVaultSalePsbts,
  finalizeCommunityVaultSalePsbt,
  validateCommunityVaultSalePsbt,
} from '@drey/core/domain/community-vault/sale';
import type {
  CommunityVaultSalePlanV1,
  CommunityVaultSalePreflightV1,
} from '@drey/core/domain/community-vault/sale-contracts';
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
  type ApproveSalePayloadV1,
  type CommunityCampaignView,
  type CreateSaleOfferPayloadV1,
} from './contracts';
import { CommunityPurchaseError, getCommunityCampaign } from './store';
import { installPublicPolicyCrypto } from './dreyCrypto';
import { refreshCommunitySalePlanPreflight, type SaleOfferDependencies } from './saleOffers';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HEX_32 = /^[0-9a-f]{64}$/u;
const NONCE = /^[A-Za-z0-9._:-]{1,128}$/u;
const ACTION_WINDOW_SEC = 15 * 60;

type SaleRow = {
  campaign_id: string;
  offer_digest: string;
  plan_json: string;
  preflight_json: string;
  signing_psbt_hex: string;
  status: 'signing' | 'ready' | 'expired' | 'failed';
  expires_at_ms: number;
};

export type ReadyCommunitySale = {
  campaignId: string;
  offerDigest: string;
  transactionHex: string;
  txid: string;
};

export function publishCommunitySale(args: {
  campaignId: string;
  policy: CommunityVaultPolicyV1;
  plan: CommunityVaultSalePlanV1;
  preflight: CommunityVaultSalePreflightV1;
  buyerFundedPsbtHex: string;
  buyerAuthorization?: {
    walletAddress: string;
    payload: CreateSaleOfferPayloadV1;
    signature: string;
  };
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
        status: string;
        inscription_id: string;
        current_outpoint: string;
        policy_json: string | null;
        policy_id: string | null;
        cap_table_hash: string | null;
        cap_table_version: number;
        active_operation_kind: string | null;
        active_operation_id: string | null;
      }
    | undefined;
  if (
    !campaign ||
    campaign.status !== 'held' ||
    !campaign.policy_json ||
    !campaign.policy_id ||
    !campaign.cap_table_hash
  ) {
    throw new CommunityPurchaseError(
      'campaign-not-held',
      'The OMB must be confirmed in its Community Vault before an offer can open.',
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
      'The sale policy differs from the frozen cap table.',
      409
    );
  }
  assertCommunityVaultSalePlan(frozen, args.plan);
  assertCommunityVaultSalePreflight({
    policy: frozen,
    plan: args.plan,
    preflight: args.preflight,
    nowMs: String(nowMs),
  });
  const vaultInput = args.plan.spendPlan.inputs[args.plan.spendPlan.vaultInputIndex];
  if (
    args.plan.campaignId !== campaign.id ||
    args.plan.inscriptionId !== campaign.inscription_id ||
    args.plan.policyId !== campaign.policy_id ||
    args.plan.capTableHash !== campaign.cap_table_hash ||
    args.plan.capTableVersion !== campaign.cap_table_version ||
    !vaultInput ||
    `${vaultInput.txid}:${vaultInput.vout}` !== campaign.current_outpoint
  ) {
    throw new CommunityPurchaseError(
      'sale-campaign-mismatch',
      'The exact offer differs from the held OMB or frozen cap table.',
      409
    );
  }
  const base = validateCommunityVaultSalePsbt(
    frozen,
    args.plan,
    normalizeHex(args.buyerFundedPsbtHex)
  );
  if (base.signedUnits.length > 0) {
    throw new CommunityPurchaseError(
      'sale-base-signatures-invalid',
      'The buyer-funded offer must not contain owner unit signatures.',
      409
    );
  }
  let existing = db
    .prepare(`SELECT * FROM community_sales WHERE campaign_id = ?`)
    .get(campaign.id) as SaleRow | undefined;
  if (existing && ['expired', 'failed'].includes(existing.status)) {
    db.prepare(`DELETE FROM community_sales WHERE campaign_id = ?`).run(campaign.id);
    existing = undefined;
  }
  if (existing) {
    if (
      existing.offer_digest !== args.plan.offerDigest ||
      existing.signing_psbt_hex !== base.psbtHex
    ) {
      throw new CommunityPurchaseError(
        'sale-already-published',
        'A different immutable funded offer is already active.',
        409
      );
    }
    db.transaction(() => {
      const operation = db
        .prepare(
          `SELECT active_operation_kind, active_operation_id FROM community_campaigns WHERE id = ?`
        )
        .get(campaign.id) as {
        active_operation_kind: string | null;
        active_operation_id: string | null;
      };
      if (operation.active_operation_kind === null) {
        db.prepare(
          `UPDATE community_campaigns SET active_operation_kind = 'sale', active_operation_id = ?, updated_at = ?
           WHERE id = ? AND active_operation_kind IS NULL`
        ).run(campaign.id, Math.floor(nowMs / 1000), campaign.id);
      } else if (
        operation.active_operation_kind !== 'sale' ||
        operation.active_operation_id !== campaign.id
      ) {
        throw new CommunityPurchaseError(
          'ownership-action-active',
          'Another ownership action is already in progress.',
          409
        );
      }
      db.prepare(
        `UPDATE community_sales SET preflight_json = ?, updated_at = ? WHERE campaign_id = ?`
      ).run(JSON.stringify(args.preflight), Math.floor(nowMs / 1000), campaign.id);
    })();
    return requireCampaign(campaign.id, Math.floor(nowMs / 1000));
  }
  const now = Math.floor(nowMs / 1000);
  db.transaction(() => {
    const locked = db
      .prepare(
        `UPDATE community_campaigns
       SET active_operation_kind = 'sale', active_operation_id = ?, updated_at = ?
       WHERE id = ? AND status = 'held' AND (
         active_operation_kind IS NULL OR
         (active_operation_kind = 'sale' AND active_operation_id = ?)
       )`
      )
      .run(campaign.id, now, campaign.id, campaign.id);
    if (locked.changes !== 1) {
      throw new CommunityPurchaseError(
        'ownership-action-active',
        'Another sale or ownership transfer is already in progress.',
        409
      );
    }
    db.prepare(
      `INSERT INTO community_sales (
         campaign_id, offer_digest, plan_json, preflight_json, signing_psbt_hex,
         status, expires_at_ms, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'signing', ?, ?, ?)`
    ).run(
      campaign.id,
      args.plan.offerDigest,
      JSON.stringify(args.plan),
      JSON.stringify(args.preflight),
      base.psbtHex,
      Number(args.plan.expiresAtMs),
      now,
      now
    );
    db.prepare(
      `INSERT INTO community_campaign_events
       (campaign_id, event_type, detail_json, created_at)
       VALUES (?, 'sale-offer-published', ?, ?)`
    ).run(
      campaign.id,
      JSON.stringify({
        offerDigest: args.plan.offerDigest,
        grossOfferSats: args.plan.grossOfferSats,
        buyerAuthorization: args.buyerAuthorization ?? null,
      }),
      now
    );
  })();
  return requireCampaign(campaign.id, now);
}

export async function refreshCommunitySale(args: {
  campaignId: string;
  now?: number;
  deps?: Partial<SaleOfferDependencies>;
}): Promise<CommunityCampaignView> {
  const now = args.now ?? Math.floor(Date.now() / 1000);
  const db = getDb();
  const row = db
    .prepare(
      `SELECT c.policy_json, c.status AS campaign_status,
              s.plan_json, s.status AS sale_status, s.expires_at_ms
       FROM community_campaigns c
       JOIN community_sales s ON s.campaign_id = c.id
       WHERE c.id = ?`
    )
    .get(args.campaignId) as
    | {
        policy_json: string | null;
        campaign_status: string;
        plan_json: string;
        sale_status: string;
        expires_at_ms: number;
      }
    | undefined;
  if (!row?.policy_json || row.campaign_status !== 'held') {
    throw new CommunityPurchaseError('sale-unavailable', 'This funded offer is unavailable.', 409);
  }
  if (row.sale_status === 'ready') return requireCampaign(args.campaignId, now);
  if (row.sale_status !== 'signing' || row.expires_at_ms <= now * 1_000) {
    expireSale(args.campaignId, now);
    throw new CommunityPurchaseError('sale-expired', 'This funded offer has closed.', 409);
  }
  const policy = JSON.parse(row.policy_json) as CommunityVaultPolicyV1;
  const plan = JSON.parse(row.plan_json) as CommunityVaultSalePlanV1;
  try {
    const preflight = await refreshCommunitySalePlanPreflight({ policy, plan, deps: args.deps });
    db.prepare(
      `UPDATE community_sales SET preflight_json = ?, updated_at = ?
       WHERE campaign_id = ? AND status = 'signing'`
    ).run(JSON.stringify(preflight), now, args.campaignId);
    return requireCampaign(args.campaignId, now);
  } catch (error) {
    if (error instanceof CommunityPurchaseError && error.code === 'sale-funds-changed') {
      db.transaction(() => {
        db.prepare(
          `UPDATE community_sales SET status = 'failed', updated_at = ?
           WHERE campaign_id = ? AND status = 'signing'`
        ).run(now, args.campaignId);
        db.prepare(
          `UPDATE community_campaigns
           SET active_operation_kind = NULL, active_operation_id = NULL, updated_at = ?
           WHERE id = ? AND active_operation_kind = 'sale'`
        ).run(now, args.campaignId);
        db.prepare(
          `INSERT INTO community_campaign_events
           (campaign_id, event_type, detail_json, created_at)
           VALUES (?, 'sale-funding-invalidated', ?, ?)`
        ).run(args.campaignId, JSON.stringify({ reason: error.code }), now);
      })();
    }
    throw error;
  }
}

export function submitCommunitySaleApproval(args: {
  campaignId: string;
  payload: ApproveSalePayloadV1;
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
  const sale = db
    .prepare(`SELECT * FROM community_sales WHERE campaign_id = ?`)
    .get(args.campaignId) as SaleRow | undefined;
  if (!campaign?.policy_json || !sale) {
    throw new CommunityPurchaseError(
      'sale-unavailable',
      'The exact funded offer is not ready for approval.',
      409
    );
  }
  if (campaign.status !== 'held' || sale.status !== 'signing' || sale.expires_at_ms <= now * 1000) {
    expireSale(args.campaignId, now);
    throw new CommunityPurchaseError('sale-expired', 'This funded offer has closed.', 409);
  }
  if (
    args.payload.capTableVersion !== campaign.cap_table_version ||
    args.payload.offerDigest !== sale.offer_digest
  ) {
    throw new CommunityPurchaseError(
      'sale-changed',
      'The funded offer changed before approval.',
      409
    );
  }
  const participant = db
    .prepare(
      `SELECT owner_id, wallet_address FROM community_participants
       WHERE campaign_id = ? AND owner_id = ?`
    )
    .get(args.campaignId, args.payload.ownerId) as
    | { owner_id: string; wallet_address: string }
    | undefined;
  if (!participant || participant.wallet_address !== args.walletAddress) {
    throw new CommunityPurchaseError(
      'owner-auth-mismatch',
      'This wallet is not a Community Vault owner.',
      403
    );
  }
  const policy = JSON.parse(campaign.policy_json) as CommunityVaultPolicyV1;
  const plan = JSON.parse(sale.plan_json) as CommunityVaultSalePlanV1;
  const validation = validateCommunityVaultSalePsbt(
    policy,
    plan,
    base64PsbtToHex(args.signedPsbtBase64)
  );
  const owner = policy.owners.find(candidate => candidate.ownerId === participant.owner_id);
  if (
    !owner ||
    JSON.stringify(validation.signedUnits) !== JSON.stringify(owner.units) ||
    validation.psbtHash !== args.payload.signedPsbtHash
  ) {
    throw new CommunityPurchaseError(
      'owner-signature-mismatch',
      'Drey did not sign every and only this owner’s numbered units.',
      409
    );
  }
  const prior = db
    .prepare(
      `SELECT psbt_hash FROM community_sale_signatures
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
      `INSERT INTO community_sale_signatures (
         campaign_id, owner_id, psbt_hash, signed_psbt_hex, signed_units_json,
         approval_payload_json, approval_signature, approval_nonce, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      args.campaignId,
      participant.owner_id,
      validation.psbtHash,
      validation.psbtHex,
      JSON.stringify(validation.signedUnits),
      JSON.stringify(args.payload),
      args.signature,
      args.payload.nonce,
      now
    );
    db.prepare(
      `INSERT INTO community_campaign_events
       (campaign_id, event_type, owner_id, detail_json, created_at)
       VALUES (?, 'sale-approved', ?, ?, ?)`
    ).run(
      args.campaignId,
      participant.owner_id,
      JSON.stringify({
        psbtHash: validation.psbtHash,
        units: validation.signedUnits,
      }),
      now
    );
  })();
  combineAvailableApprovals(args.campaignId, policy, plan, now);
  return requireCampaign(args.campaignId, now);
}

export function getReadyCommunitySale(campaignId: string): ReadyCommunitySale {
  const row = getDb()
    .prepare(
      `SELECT s.offer_digest, s.transaction_hex, s.txid, s.status,
              c.status AS campaign_status
       FROM community_sales s
       JOIN community_campaigns c ON c.id = s.campaign_id
       WHERE s.campaign_id = ?`
    )
    .get(campaignId) as
    | {
        offer_digest: string;
        transaction_hex: string | null;
        txid: string | null;
        status: string;
        campaign_status: string;
      }
    | undefined;
  if (
    !row ||
    row.status !== 'ready' ||
    row.campaign_status !== 'held' ||
    !row.transaction_hex ||
    !row.txid
  ) {
    throw new CommunityPurchaseError(
      'sale-not-ready',
      'The exact sale transaction has not reached 69 unit signatures.',
      409
    );
  }
  return {
    campaignId,
    offerDigest: row.offer_digest,
    transactionHex: row.transaction_hex,
    txid: row.txid,
  };
}

export function recordCommunitySaleBroadcast(args: {
  campaignId: string;
  txid: string;
  now?: number;
}): CommunityCampaignView {
  const now = args.now ?? Math.floor(Date.now() / 1000);
  const ready = getReadyCommunitySale(args.campaignId);
  if (args.txid !== ready.txid) {
    throw new CommunityPurchaseError(
      'broadcast-txid-mismatch',
      'The observed broadcast does not match the exact finalized sale.',
      409
    );
  }
  const db = getDb();
  const observed = db
    .prepare(
      `SELECT 1 FROM community_campaign_events
       WHERE campaign_id = ? AND event_type = 'sale-broadcast-observed'
       LIMIT 1`
    )
    .get(args.campaignId);
  if (!observed) {
    db.prepare(
      `INSERT INTO community_campaign_events
       (campaign_id, event_type, detail_json, created_at)
       VALUES (?, 'sale-broadcast-observed', ?, ?)`
    ).run(args.campaignId, JSON.stringify({ txid: args.txid }), now);
  }
  return requireCampaign(args.campaignId, now);
}

export async function confirmCommunitySaleSold(args: {
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
      `SELECT c.inscription_id, c.status AS campaign_status,
              s.plan_json, s.txid, s.status AS sale_status,
              EXISTS(
                SELECT 1 FROM community_campaign_events e
                WHERE e.campaign_id = c.id AND e.event_type = 'sale-broadcast-observed'
              ) AS broadcast_observed
       FROM community_campaigns c
       JOIN community_sales s ON s.campaign_id = c.id
       WHERE c.id = ?`
    )
    .get(args.campaignId) as
    | {
        inscription_id: string;
        campaign_status: string;
        plan_json: string;
        txid: string | null;
        sale_status: string;
        broadcast_observed: number;
      }
    | undefined;
  if (
    !row ||
    row.campaign_status !== 'held' ||
    row.sale_status !== 'ready' ||
    !row.txid ||
    row.broadcast_observed !== 1
  ) {
    throw new CommunityPurchaseError(
      'sale-not-broadcast',
      'The exact sale must be observed as broadcast before confirmation.',
      409
    );
  }
  const plan = JSON.parse(row.plan_json) as CommunityVaultSalePlanV1;
  const expectedOutpoint = `${row.txid}:${plan.spendPlan.ordinalRoute.outputIndex}`;
  const detail = await (args.fetchDetail ?? fetchInscriptionDetail)(row.inscription_id);
  const confirmations = await (args.fetchConfirmations ?? fetchOutputConfirmations)(
    expectedOutpoint
  );
  if (
    detail.inscription_id !== row.inscription_id ||
    detail.output !== expectedOutpoint ||
    detail.address !== plan.buyerDestinationAddress ||
    confirmations === null ||
    confirmations < minimumConfirmations
  ) {
    throw new CommunityPurchaseError(
      'sale-not-confirmed',
      'The Ordinal is not yet confirmed at the exact buyer output.',
      409
    );
  }
  db.transaction(() => {
    db.prepare(
      `UPDATE community_campaigns
       SET status = 'sold', current_outpoint = ?, active_operation_kind = NULL,
           active_operation_id = NULL, updated_at = ?
       WHERE id = ? AND status = 'held'`
    ).run(expectedOutpoint, now, args.campaignId);
    db.prepare(
      `INSERT INTO community_campaign_events
       (campaign_id, event_type, detail_json, created_at)
       VALUES (?, 'sale-confirmed', ?, ?)`
    ).run(
      args.campaignId,
      JSON.stringify({
        txid: row.txid,
        outpoint: expectedOutpoint,
        confirmations,
        grossOfferSats: plan.grossOfferSats,
      }),
      now
    );
  })();
  return requireCampaign(args.campaignId, now);
}

function combineAvailableApprovals(
  campaignId: string,
  policy: CommunityVaultPolicyV1,
  plan: CommunityVaultSalePlanV1,
  now: number
): void {
  const db = getDb();
  const packages = (
    db
      .prepare(
        `SELECT signed_psbt_hex FROM community_sale_signatures
         WHERE campaign_id = ? ORDER BY owner_id`
      )
      .all(campaignId) as Array<{ signed_psbt_hex: string }>
  ).map(row => row.signed_psbt_hex);
  if (packages.length === 0) return;
  const combined = combineCommunityVaultSalePsbts({ policy, plan, psbtHexes: packages });
  const validation = validateCommunityVaultSalePsbt(policy, plan, combined.psbtHex);
  if (validation.signedUnits.length < 69) {
    db.prepare(
      `UPDATE community_sales SET combined_psbt_hex = ?, updated_at = ? WHERE campaign_id = ?`
    ).run(validation.psbtHex, now, campaignId);
    return;
  }
  const finalized = finalizeCommunityVaultSalePsbt(policy, plan, validation.psbtHex);
  db.transaction(() => {
    db.prepare(
      `UPDATE community_sales
       SET status = 'ready', combined_psbt_hex = ?, transaction_hex = ?, txid = ?, updated_at = ?
       WHERE campaign_id = ? AND status = 'signing'`
    ).run(validation.psbtHex, finalized.transactionHex, finalized.txid, now, campaignId);
    db.prepare(
      `INSERT INTO community_campaign_events
       (campaign_id, event_type, detail_json, created_at)
       VALUES (?, 'sale-ready', ?, ?)`
    ).run(
      campaignId,
      JSON.stringify({
        txid: finalized.txid,
        signedUnits: finalized.signedUnits.length,
        weight: finalized.weight,
        vsize: finalized.vsize,
        feeSats: plan.spendPlan.feeSats,
      }),
      now
    );
  })();
}

function validateApprovalPayload(payload: ApproveSalePayloadV1, campaignId: string, now: number) {
  if (
    payload.protocol !== COMMUNITY_PURCHASES_PROTOCOL ||
    payload.version !== 1 ||
    payload.network !== 'mainnet' ||
    payload.action !== 'approve-sale' ||
    payload.campaignId !== campaignId ||
    !IDENTIFIER.test(payload.ownerId) ||
    !HEX_32.test(payload.offerDigest) ||
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
      'The sale approval is invalid or expired.'
    );
  }
}

function expireSale(campaignId: string, now: number) {
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `UPDATE community_sales SET status = 'expired', updated_at = ?
       WHERE campaign_id = ? AND status = 'signing'`
    ).run(now, campaignId);
    db.prepare(
      `UPDATE community_campaigns
       SET active_operation_kind = NULL, active_operation_id = NULL, updated_at = ?
       WHERE id = ? AND active_operation_kind = 'sale'`
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
    throw new CommunityPurchaseError('psbt-invalid', 'The funded sale PSBT is invalid.');
  }
  return value;
}

function requireCampaign(id: string, now: number): CommunityCampaignView {
  const campaign = getCommunityCampaign(id, now);
  if (!campaign) throw new CommunityPurchaseError('campaign-not-found', 'Campaign not found.', 404);
  return campaign;
}
