import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { address, networks } from 'bitcoinjs-lib';
import {
  combineCommunityVaultPositionTransferPsbts,
  communityVaultPositionTransferSellerAuthorization,
  createCommunityVaultPositionTransferPolicy,
  finalizeCommunityVaultPositionTransferPsbt,
  validateCommunityVaultPositionTransferPsbt,
} from '@drey/core/domain/community-vault/position-transfer';
import type {
  CommunityVaultPositionTransferBuyerV1,
  CommunityVaultPositionTransferPlanV1,
  CommunityVaultPositionTransferPreflightV1,
  CommunityVaultPositionTransferSellerAuthorizationV1,
} from '@drey/core/domain/community-vault/position-transfer-contracts';
import type { CommunityVaultPolicyV1 } from '@drey/core/domain/community-vault/contracts';
import { getDb } from '@/lib/db';
import { fetchInscriptionDetail, fetchOutputConfirmations } from '@/lib/ord';
import type { BuyerSession } from '@/lib/buyerSession';
import {
  COMMUNITY_PURCHASES_PROTOCOL,
  isCommunityEnrollmentFor,
  type AcceptPositionTransferPayloadV1,
  type ApprovePositionTransferPayloadV1,
  type CommunityCampaignView,
  type CommunityPositionTransferOwnerView,
  type CommunityPositionTransferPrivateView,
  type CreatePositionTransferInvitePayloadV1,
} from './contracts';
import { CommunityPurchaseError, getCommunityCampaign } from './store';
import {
  prepareCommunityPositionTransfer,
  refreshCommunityPositionTransferPreflight,
  type PositionTransferOfferDependencies,
} from './positionTransferOffers';
import { installPublicPolicyCrypto } from './dreyCrypto';

const ACTION_WINDOW_SEC = 15 * 60;
const MAX_TRANSFER_SEC = 24 * 60 * 60;
const HEX_32 = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

type TransferStatus = CommunityPositionTransferPrivateView['status'];

type TransferRow = {
  id: string;
  campaign_id: string;
  status: TransferStatus;
  previous_policy_id: string;
  previous_cap_table_hash: string;
  previous_cap_table_version: number;
  previous_vault_outpoint: string;
  seller_participant_id: number;
  seller_owner_id: string;
  transferred_units_json: string;
  seller_price_sats: number;
  invite_token_hash: string;
  buyer_owner_id: string | null;
  buyer_identity_key: string | null;
  buyer_identity_commitment_hex: string | null;
  buyer_wallet_address: string | null;
  buyer_payout_address: string | null;
  buyer_payout_script_pubkey_hex: string | null;
  buyer_matrica_user_id: string | null;
  buyer_matrica_username: string | null;
  buyer_qualifying_inscription_number: number | null;
  buyer_root_fingerprint_hex: string | null;
  buyer_campaign_xpub: string | null;
  buyer_inferred_links_json: string | null;
  buyer_acceptance_payload_json: string | null;
  buyer_acceptance_signature: string | null;
  previous_policy_json: string;
  next_policy_json: string | null;
  seller_authorization_payload_json: string | null;
  seller_authorization_signature: string | null;
  plan_json: string | null;
  preflight_json: string | null;
  signing_psbt_hex: string | null;
  buyer_funded_psbt_hex: string | null;
  transaction_hex: string | null;
  txid: string | null;
  expires_at_ms: number;
};

export type ReadyCommunityPositionTransfer = {
  transferId: string;
  campaignId: string;
  transferDigest: string;
  transactionHex: string;
  txid: string;
};

export function createPrivatePositionTransferInvite(args: {
  payload: CreatePositionTransferInvitePayloadV1;
  signature: string;
  walletAddress: string;
  now?: number;
  random32?: () => Buffer;
}): { campaign: CommunityCampaignView; transferId: string; inviteToken: string } {
  const now = args.now ?? Math.floor(Date.now() / 1_000);
  validateCreatePayload(args.payload, now);
  const db = getDb();
  const campaign = db
    .prepare(`SELECT * FROM community_campaigns WHERE id = ?`)
    .get(args.payload.campaignId) as
    | {
        id: string;
        status: string;
        policy_id: string | null;
        cap_table_hash: string | null;
        cap_table_version: number;
        current_outpoint: string;
        policy_json: string | null;
        creator_owner_id: string;
      }
    | undefined;
  const seller = db
    .prepare(
      `SELECT p.*, json_group_array(u.unit_number) AS units_json
     FROM community_participants p
     JOIN community_units u ON u.participant_id = p.id
     WHERE p.campaign_id = ? AND p.owner_id = ?
     GROUP BY p.id`
    )
    .get(args.payload.campaignId, args.payload.sellerOwnerId) as
    | { id: number; owner_id: string; wallet_address: string; units_json: string }
    | undefined;
  if (
    !campaign ||
    campaign.status !== 'held' ||
    !campaign.policy_json ||
    !campaign.policy_id ||
    !campaign.cap_table_hash
  ) {
    throw new CommunityPurchaseError(
      'transfer-unavailable',
      'The OMB must be confirmed in its Community Vault first.',
      409
    );
  }
  if (!seller || seller.wallet_address !== args.walletAddress) {
    throw new CommunityPurchaseError(
      'seller-auth-mismatch',
      'This wallet does not own that position.',
      403
    );
  }
  if (seller.owner_id === campaign.creator_owner_id) {
    throw new CommunityPurchaseError(
      'creator-transfer-unavailable',
      'The creator position cannot be transferred in this version.',
      409
    );
  }
  const units = (JSON.parse(seller.units_json) as number[]).toSorted((a, b) => a - b);
  if (units.length < 1 || units.length > 20) {
    throw new CommunityPurchaseError(
      'position-invalid',
      'Only one complete 1–20% position can be transferred.',
      409
    );
  }
  const random32 = args.random32 ?? (() => randomBytes(32));
  if (BigInt(args.payload.sellerPriceSats) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CommunityPurchaseError('transfer-price-invalid', 'That price is too large.');
  }
  const transferId = `pt_${random32().toString('hex').slice(0, 32)}`;
  const inviteToken = random32().toString('base64url');
  const inviteHash = sha256(inviteToken);
  db.transaction(() => {
    const locked = db
      .prepare(
        `UPDATE community_campaigns
       SET active_operation_kind = 'position-transfer', active_operation_id = ?, updated_at = ?
       WHERE id = ? AND status = 'held' AND active_operation_kind IS NULL`
      )
      .run(transferId, now, campaign.id);
    if (locked.changes !== 1) {
      throw new CommunityPurchaseError(
        'ownership-action-active',
        'Another sale or ownership transfer is already in progress.',
        409
      );
    }
    db.prepare(
      `INSERT INTO community_position_transfers (
         id, campaign_id, status, previous_policy_id, previous_cap_table_hash,
         previous_cap_table_version, previous_vault_outpoint, seller_participant_id,
         seller_owner_id, transferred_units_json, seller_price_sats, invite_token_hash,
         previous_policy_json, expires_at_ms, created_at, updated_at
       ) VALUES (?, ?, 'invited', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      transferId,
      campaign.id,
      campaign.policy_id,
      campaign.cap_table_hash,
      campaign.cap_table_version,
      campaign.current_outpoint,
      seller.id,
      seller.owner_id,
      JSON.stringify(units),
      Number(args.payload.sellerPriceSats),
      inviteHash,
      campaign.policy_json,
      args.payload.expiresAt * 1_000,
      now,
      now
    );
    db.prepare(
      `INSERT INTO community_campaign_events (campaign_id, event_type, owner_id, detail_json, created_at)
       VALUES (?, 'position-transfer-invited', ?, ?, ?)`
    ).run(campaign.id, seller.owner_id, JSON.stringify({ units }), now);
  })();
  return { campaign: requireCampaign(campaign.id, now), transferId, inviteToken };
}

export async function getPrivatePositionTransferByToken(args: {
  token: string;
  session: BuyerSession | null;
  nowMs?: number;
  deps?: Partial<PositionTransferOfferDependencies>;
}): Promise<CommunityPositionTransferPrivateView> {
  const nowMs = args.nowMs ?? Date.now();
  const row = requireTransferByToken(args.token, nowMs);
  if (row.status === 'authorized' || row.status === 'signing') {
    await refreshTransfer(row, nowMs, args.deps);
  }
  return privateView(requireTransfer(row.id), args.session);
}

export function acceptPrivatePositionTransfer(args: {
  token: string;
  payload: AcceptPositionTransferPayloadV1;
  signature: string;
  session: BuyerSession;
  now?: number;
}): CommunityPositionTransferPrivateView {
  installPublicPolicyCrypto();
  const now = args.now ?? Math.floor(Date.now() / 1_000);
  validateAcceptPayload(args.payload, now);
  const db = getDb();
  const row = requireTransferByToken(args.token, now * 1_000);
  if (row.campaign_id !== args.payload.campaignId || row.id !== args.payload.transferId) {
    throw new CommunityPurchaseError(
      'invite-mismatch',
      'This invitation does not match the signed acceptance.',
      409
    );
  }
  if (row.status !== 'invited') {
    if (
      row.buyer_wallet_address === args.session.ord_addr &&
      row.buyer_acceptance_payload_json === JSON.stringify(args.payload)
    ) {
      return privateView(row, args.session);
    }
    throw new CommunityPurchaseError(
      'invite-taken',
      'This private invitation has already been accepted.',
      409
    );
  }
  if (!args.session.pay_addr || args.payload.payoutAddress !== args.session.pay_addr) {
    throw new CommunityPurchaseError(
      'buyer-payment-required',
      'Reconnect Drey with the payment address used for this purchase.',
      409
    );
  }
  if (
    !isCommunityEnrollmentFor(args.payload.enrollment, row.campaign_id, args.payload.buyerOwnerId)
  ) {
    throw new CommunityPurchaseError(
      'invalid-enrollment',
      'Paste the matching public setup package from Drey.'
    );
  }
  const campaign = db
    .prepare(`SELECT * FROM community_campaigns WHERE id = ?`)
    .get(row.campaign_id) as
    | {
        opened_at: number;
        eligibility_mode: 'anyone' | 'omb-holders-only';
        active_operation_kind: string | null;
        active_operation_id: string | null;
      }
    | undefined;
  if (
    !campaign ||
    campaign.active_operation_kind !== 'position-transfer' ||
    campaign.active_operation_id !== row.id
  ) {
    throw new CommunityPurchaseError(
      'transfer-changed',
      'This ownership transfer is no longer active.',
      409
    );
  }
  const identity = recognizedIdentity(db, args.session.ord_addr);
  const wallets = walletsForIdentity(db, identity, args.session.ord_addr);
  if (campaign.eligibility_mode === 'omb-holders-only') {
    if (
      args.payload.qualifyingInscriptionNumber == null ||
      !ownsQualifyingOmb(db, wallets, args.payload.qualifyingInscriptionNumber, campaign.opened_at)
    ) {
      throw new CommunityPurchaseError(
        'holder-proof-required',
        'Choose an unloaned OMB this identity already held.',
        403
      );
    }
  } else if (args.payload.qualifyingInscriptionNumber !== null) {
    throw new CommunityPurchaseError(
      'unexpected-holder-proof',
      'This group buy does not use a holder gate.'
    );
  }
  const conflict = db
    .prepare(
      `SELECT 1 FROM community_participants
     WHERE campaign_id = ? AND (
       owner_id = ? OR identity_key = ? OR campaign_xpub = ? OR wallet_address IN (SELECT value FROM json_each(?))
     ) LIMIT 1`
    )
    .get(
      row.campaign_id,
      args.payload.buyerOwnerId,
      identity.key,
      args.payload.enrollment.campaignRoot.campaignXpub,
      JSON.stringify(wallets)
    );
  if (conflict) {
    throw new CommunityPurchaseError(
      'buyer-already-owner',
      'This buyer identity already owns part of the group buy.',
      409
    );
  }
  const payoutScript = mainnetScript(args.payload.payoutAddress);
  const buyer: CommunityVaultPositionTransferBuyerV1 = {
    ownerId: args.payload.buyerOwnerId,
    identityCommitmentHex: sha256(`omb-community-identity-v1\0${identity.key}`),
    payoutAddress: args.payload.payoutAddress,
    payoutScriptPubKeyHex: payoutScript,
    campaignRoot: args.payload.enrollment.campaignRoot,
    qualifyingInscriptionNumber: args.payload.qualifyingInscriptionNumber,
  };
  const previousPolicy = JSON.parse(row.previous_policy_json) as CommunityVaultPolicyV1;
  const currentOutpoint = parseOutpoint(row.previous_vault_outpoint);
  const nextPolicy = createCommunityVaultPositionTransferPolicy({
    currentPolicy: previousPolicy,
    sellerOwnerId: row.seller_owner_id,
    buyer,
    currentVaultOutpoint: currentOutpoint,
  });
  const authorization = communityVaultPositionTransferSellerAuthorization({
    transferId: row.id,
    currentPolicy: previousPolicy,
    nextPolicy,
    currentVaultOutpoint: currentOutpoint,
    sellerOwnerId: row.seller_owner_id,
    buyer,
    sellerPriceSats: String(row.seller_price_sats),
    expiresAtMs: String(row.expires_at_ms),
    nonceHex: randomBytes(32).toString('hex'),
  });
  const inferred = inferredIdentityLinks(db, args.session.ord_addr);
  db.prepare(
    `UPDATE community_position_transfers SET
       status = 'buyer-accepted', buyer_owner_id = ?, buyer_identity_key = ?,
       buyer_identity_commitment_hex = ?, buyer_wallet_address = ?, buyer_payout_address = ?,
       buyer_payout_script_pubkey_hex = ?, buyer_matrica_user_id = ?, buyer_matrica_username = ?,
       buyer_qualifying_inscription_number = ?, buyer_root_fingerprint_hex = ?,
       buyer_campaign_xpub = ?, buyer_inferred_links_json = ?, buyer_acceptance_payload_json = ?,
       buyer_acceptance_signature = ?, buyer_acceptance_nonce = ?, next_policy_json = ?,
       seller_authorization_payload_json = ?, seller_authorization_nonce = ?, updated_at = ?
     WHERE id = ? AND status = 'invited'`
  ).run(
    buyer.ownerId,
    identity.key,
    buyer.identityCommitmentHex,
    args.session.ord_addr,
    buyer.payoutAddress,
    buyer.payoutScriptPubKeyHex,
    identity.matricaUserId,
    identity.username,
    buyer.qualifyingInscriptionNumber,
    buyer.campaignRoot.masterFingerprintHex,
    buyer.campaignRoot.campaignXpub,
    JSON.stringify(inferred),
    JSON.stringify(args.payload),
    args.signature,
    args.payload.nonce,
    JSON.stringify(nextPolicy),
    JSON.stringify(authorization),
    authorization.nonceHex,
    now,
    row.id
  );
  db.prepare(
    `INSERT INTO community_campaign_events (campaign_id, event_type, detail_json, created_at)
     VALUES (?, 'position-transfer-buyer-accepted', '{}', ?)`
  ).run(row.campaign_id, now);
  return privateView(requireTransfer(row.id), args.session);
}

export async function authorizePrivatePositionTransfer(args: {
  campaignId: string;
  transferId: string;
  signature: string;
  session: BuyerSession;
  nowMs?: number;
  deps?: Partial<PositionTransferOfferDependencies>;
}): Promise<CommunityPositionTransferOwnerView> {
  const nowMs = args.nowMs ?? Date.now();
  const now = Math.floor(nowMs / 1_000);
  const row = requireTransfer(args.transferId, nowMs);
  if (row.campaign_id !== args.campaignId || row.status !== 'buyer-accepted') {
    throw new CommunityPurchaseError(
      'transfer-not-authorizable',
      'The buyer must accept this invitation first.',
      409
    );
  }
  const seller = getDb()
    .prepare(`SELECT wallet_address FROM community_participants WHERE id = ? AND owner_id = ?`)
    .get(row.seller_participant_id, row.seller_owner_id) as { wallet_address: string } | undefined;
  if (!seller || seller.wallet_address !== args.session.ord_addr) {
    throw new CommunityPurchaseError(
      'seller-auth-mismatch',
      'Only the current seller can authorize this buyer.',
      403
    );
  }
  const currentPolicy = JSON.parse(row.previous_policy_json) as CommunityVaultPolicyV1;
  const nextPolicy = JSON.parse(row.next_policy_json!) as CommunityVaultPolicyV1;
  const buyer = buyerFromRow(row);
  const authorization = JSON.parse(
    row.seller_authorization_payload_json!
  ) as CommunityVaultPositionTransferSellerAuthorizationV1;
  const prepared = await prepareCommunityPositionTransfer({
    campaignId: row.campaign_id,
    inscriptionId: currentPolicy.inscriptionId,
    currentOutpoint: row.previous_vault_outpoint,
    currentPolicy,
    nextPolicy,
    transferId: row.id,
    sellerOwnerId: row.seller_owner_id,
    buyer,
    sellerPriceSats: String(row.seller_price_sats),
    expiresAtMs: String(row.expires_at_ms),
    sellerAuthorization: { payload: authorization, signature: args.signature },
    deps: args.deps,
  });
  const updated = getDb()
    .prepare(
      `UPDATE community_position_transfers SET status = 'authorized',
       seller_authorization_signature = ?, plan_json = ?, preflight_json = ?,
       signing_psbt_hex = ?, updated_at = ?
     WHERE id = ? AND status = 'buyer-accepted'`
    )
    .run(
      args.signature,
      JSON.stringify(prepared.plan),
      JSON.stringify(prepared.preflight),
      prepared.signingPsbtHex,
      now,
      row.id
    );
  if (updated.changes !== 1)
    throw new CommunityPurchaseError(
      'transfer-changed',
      'The transfer changed while it was prepared.',
      409
    );
  getDb()
    .prepare(
      `INSERT INTO community_campaign_events (campaign_id, event_type, owner_id, detail_json, created_at)
     VALUES (?, 'position-transfer-authorized', ?, '{}', ?)`
    )
    .run(row.campaign_id, row.seller_owner_id, now);
  return getPositionTransferForOwner({
    campaignId: row.campaign_id,
    session: args.session,
    nowMs,
    deps: args.deps,
  });
}

export async function submitPositionTransferBuyerFunding(args: {
  token: string;
  signedPsbtBase64: string;
  session: BuyerSession;
  nowMs?: number;
  deps?: Partial<PositionTransferOfferDependencies>;
}): Promise<CommunityPositionTransferPrivateView> {
  const nowMs = args.nowMs ?? Date.now();
  const row = requireTransferByToken(args.token, nowMs);
  if (row.status !== 'authorized' || row.buyer_wallet_address !== args.session.ord_addr) {
    throw new CommunityPurchaseError(
      'buyer-funding-unavailable',
      'This transfer is not waiting for this buyer’s funding.',
      409
    );
  }
  await refreshTransfer(row, nowMs, args.deps);
  const fresh = requireTransfer(row.id);
  const currentPolicy = JSON.parse(fresh.previous_policy_json) as CommunityVaultPolicyV1;
  const plan = JSON.parse(fresh.plan_json!) as CommunityVaultPositionTransferPlanV1;
  const validation = validateCommunityVaultPositionTransferPsbt({
    currentPolicy,
    plan,
    psbtHex: base64PsbtToHex(args.signedPsbtBase64),
    requireBuyerFunding: true,
  });
  if (validation.signedUnits.length > 0) {
    throw new CommunityPurchaseError(
      'buyer-funding-invalid',
      'Buyer funding must not contain owner signatures.',
      409
    );
  }
  getDb()
    .prepare(
      `UPDATE community_position_transfers SET status = 'signing', buyer_funded_psbt_hex = ?,
       combined_psbt_hex = ?, updated_at = ? WHERE id = ? AND status = 'authorized'`
    )
    .run(validation.psbtHex, validation.psbtHex, Math.floor(nowMs / 1_000), row.id);
  getDb()
    .prepare(
      `INSERT INTO community_campaign_events (campaign_id, event_type, detail_json, created_at)
     VALUES (?, 'position-transfer-funded', '{}', ?)`
    )
    .run(row.campaign_id, Math.floor(nowMs / 1_000));
  return privateView(requireTransfer(row.id), args.session);
}

export async function getPositionTransferForOwner(args: {
  campaignId: string;
  session: BuyerSession;
  nowMs?: number;
  deps?: Partial<PositionTransferOfferDependencies>;
}): Promise<CommunityPositionTransferOwnerView> {
  const nowMs = args.nowMs ?? Date.now();
  const db = getDb();
  const participant = db
    .prepare(
      `SELECT owner_id FROM community_participants WHERE campaign_id = ? AND wallet_address = ?`
    )
    .get(args.campaignId, args.session.ord_addr) as { owner_id: string } | undefined;
  if (!participant)
    throw new CommunityPurchaseError(
      'owner-auth-mismatch',
      'This wallet is not a current owner.',
      403
    );
  const row = db
    .prepare(
      `SELECT * FROM community_position_transfers
     WHERE campaign_id = ? AND status NOT IN ('confirmed','expired','cancelled','failed')
     ORDER BY created_at DESC LIMIT 1`
    )
    .get(args.campaignId) as TransferRow | undefined;
  if (!row)
    throw new CommunityPurchaseError('transfer-not-found', 'No ownership transfer is active.', 404);
  requireTransfer(row.id, nowMs);
  if (row.status === 'authorized' || row.status === 'signing')
    await refreshTransfer(row, nowMs, args.deps);
  return ownerView(requireTransfer(row.id), participant.owner_id);
}

export function submitPositionTransferApproval(args: {
  campaignId: string;
  transferId: string;
  payload: ApprovePositionTransferPayloadV1;
  signature: string;
  walletAddress: string;
  signedPsbtBase64: string;
  now?: number;
}): CommunityPositionTransferOwnerView {
  installPublicPolicyCrypto();
  const now = args.now ?? Math.floor(Date.now() / 1_000);
  validateApprovalPayload(args.payload, args.campaignId, args.transferId, now);
  const row = requireTransfer(args.transferId, now * 1_000);
  if (row.campaign_id !== args.campaignId || row.status !== 'signing') {
    throw new CommunityPurchaseError(
      'transfer-not-signing',
      'This transfer is not collecting approvals.',
      409
    );
  }
  const participant = getDb()
    .prepare(
      `SELECT owner_id FROM community_participants WHERE campaign_id = ? AND owner_id = ? AND wallet_address = ?`
    )
    .get(args.campaignId, args.payload.ownerId, args.walletAddress) as
    | { owner_id: string }
    | undefined;
  if (!participant)
    throw new CommunityPurchaseError(
      'owner-auth-mismatch',
      'This wallet is not a current owner.',
      403
    );
  const currentPolicy = JSON.parse(row.previous_policy_json) as CommunityVaultPolicyV1;
  const plan = JSON.parse(row.plan_json!) as CommunityVaultPositionTransferPlanV1;
  if (
    args.payload.capTableVersion !== row.previous_cap_table_version ||
    args.payload.transferDigest !== plan.transferDigest
  ) {
    throw new CommunityPurchaseError(
      'transfer-changed',
      'The exact ownership transfer changed before approval.',
      409
    );
  }
  const validation = validateCommunityVaultPositionTransferPsbt({
    currentPolicy,
    plan,
    psbtHex: base64PsbtToHex(args.signedPsbtBase64),
    requireBuyerFunding: true,
  });
  const owner = currentPolicy.owners.find(candidate => candidate.ownerId === participant.owner_id);
  if (
    !owner ||
    JSON.stringify(validation.signedUnits) !== JSON.stringify(owner.units) ||
    validation.psbtHash !== args.payload.signedPsbtHash
  ) {
    throw new CommunityPurchaseError(
      'owner-signature-mismatch',
      'Drey did not sign every and only this owner’s units.',
      409
    );
  }
  const prior = getDb()
    .prepare(
      `SELECT psbt_hash FROM community_position_transfer_signatures WHERE transfer_id = ? AND owner_id = ?`
    )
    .get(row.id, participant.owner_id) as { psbt_hash: string } | undefined;
  if (prior) {
    if (prior.psbt_hash !== validation.psbtHash)
      throw new CommunityPurchaseError(
        'owner-already-approved',
        'This owner already approved a different package.',
        409
      );
    return ownerView(row, participant.owner_id);
  }
  getDb().transaction(() => {
    getDb()
      .prepare(
        `INSERT INTO community_position_transfer_signatures (
         transfer_id, owner_id, psbt_hash, signed_psbt_hex, signed_units_json,
         approval_payload_json, approval_signature, approval_nonce, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        participant.owner_id,
        validation.psbtHash,
        validation.psbtHex,
        JSON.stringify(validation.signedUnits),
        JSON.stringify(args.payload),
        args.signature,
        args.payload.nonce,
        now
      );
    getDb()
      .prepare(
        `INSERT INTO community_campaign_events (campaign_id, event_type, owner_id, detail_json, created_at)
       VALUES (?, 'position-transfer-approved', ?, ?, ?)`
      )
      .run(
        row.campaign_id,
        participant.owner_id,
        JSON.stringify({ units: validation.signedUnits }),
        now
      );
  })();
  combineApprovals(row, currentPolicy, plan, now);
  return ownerView(requireTransfer(row.id), participant.owner_id);
}

export function cancelPositionTransfer(args: {
  campaignId: string;
  transferId: string;
  session: BuyerSession;
  now?: number;
}): CommunityCampaignView {
  const now = args.now ?? Math.floor(Date.now() / 1_000);
  const row = requireTransfer(args.transferId, now * 1_000);
  const seller = getDb()
    .prepare(`SELECT wallet_address FROM community_participants WHERE id = ?`)
    .get(row.seller_participant_id) as { wallet_address: string } | undefined;
  if (
    row.campaign_id !== args.campaignId ||
    !seller ||
    seller.wallet_address !== args.session.ord_addr
  ) {
    throw new CommunityPurchaseError(
      'seller-auth-mismatch',
      'Only the seller can cancel this invitation.',
      403
    );
  }
  if (!['invited', 'buyer-accepted', 'authorized'].includes(row.status)) {
    throw new CommunityPurchaseError(
      'transfer-cannot-cancel',
      'Owner signing has already started.',
      409
    );
  }
  finishTransfer(row, 'cancelled', now);
  return requireCampaign(row.campaign_id, now);
}

export function getReadyCommunityPositionTransfer(
  transferId: string,
  nowMs = Date.now()
): ReadyCommunityPositionTransfer {
  const row = requireTransfer(transferId, nowMs);
  if (row.status !== 'ready' || !row.transaction_hex || !row.txid || !row.plan_json) {
    throw new CommunityPurchaseError(
      'transfer-not-ready',
      'The transfer has not reached 69 unit signatures.',
      409
    );
  }
  const plan = JSON.parse(row.plan_json) as CommunityVaultPositionTransferPlanV1;
  return {
    transferId: row.id,
    campaignId: row.campaign_id,
    transferDigest: plan.transferDigest,
    transactionHex: row.transaction_hex,
    txid: row.txid,
  };
}

export function recordPositionTransferBroadcast(args: {
  transferId: string;
  txid: string;
  now?: number;
}): CommunityCampaignView {
  const now = args.now ?? Math.floor(Date.now() / 1_000);
  const existing = requireTransfer(args.transferId);
  if (existing.status === 'broadcast') {
    if (existing.txid !== args.txid)
      throw new CommunityPurchaseError(
        'broadcast-txid-mismatch',
        'The broadcast does not match the finalized transfer.',
        409
      );
    return requireCampaign(existing.campaign_id, now);
  }
  const ready = getReadyCommunityPositionTransfer(args.transferId, now * 1_000);
  if (ready.txid !== args.txid)
    throw new CommunityPurchaseError(
      'broadcast-txid-mismatch',
      'The broadcast does not match the finalized transfer.',
      409
    );
  getDb().transaction(() => {
    getDb()
      .prepare(
        `UPDATE community_position_transfers SET status = 'broadcast', broadcast_at = ?, updated_at = ?
       WHERE id = ? AND status = 'ready'`
      )
      .run(now, now, args.transferId);
    getDb()
      .prepare(
        `INSERT INTO community_campaign_events (campaign_id, event_type, detail_json, created_at)
       VALUES (?, 'position-transfer-broadcast', ?, ?)`
      )
      .run(ready.campaignId, JSON.stringify({ txid: ready.txid }), now);
  })();
  return requireCampaign(ready.campaignId, now);
}

export async function confirmPositionTransfer(args: {
  transferId: string;
  minimumConfirmations?: number;
  now?: number;
  fetchDetail?: typeof fetchInscriptionDetail;
  fetchConfirmations?: typeof fetchOutputConfirmations;
}): Promise<CommunityCampaignView> {
  const now = args.now ?? Math.floor(Date.now() / 1_000);
  const minimum = args.minimumConfirmations ?? 1;
  if (!Number.isInteger(minimum) || minimum < 1 || minimum > 100) {
    throw new CommunityPurchaseError('confirmations-invalid', 'Confirmation target is invalid.');
  }
  const row = requireTransfer(args.transferId);
  if (row.status === 'confirmed') return requireCampaign(row.campaign_id, now);
  if (row.status !== 'broadcast' || !row.txid || !row.plan_json) {
    throw new CommunityPurchaseError(
      'transfer-not-broadcast',
      'The exact transfer must be broadcast first.',
      409
    );
  }
  const plan = JSON.parse(row.plan_json) as CommunityVaultPositionTransferPlanV1;
  const expectedOutpoint = `${row.txid}:${plan.spendPlan.ordinalRoute.outputIndex}`;
  const detail = await (args.fetchDetail ?? fetchInscriptionDetail)(plan.nextPolicy.inscriptionId);
  const confirmations = await (args.fetchConfirmations ?? fetchOutputConfirmations)(
    expectedOutpoint
  );
  if (
    detail.inscription_id !== plan.nextPolicy.inscriptionId ||
    detail.output !== expectedOutpoint ||
    detail.address !== plan.nextPolicy.address ||
    confirmations === null ||
    confirmations < minimum
  ) {
    throw new CommunityPurchaseError(
      'transfer-not-confirmed',
      'The OMB is not yet confirmed at the new Community Vault.',
      409
    );
  }
  const updated = getDb().transaction(() => {
    const transfer = getDb()
      .prepare(
        `UPDATE community_position_transfers SET status = 'confirmed', confirmed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'broadcast'`
      )
      .run(now, now, row.id);
    if (transfer.changes !== 1) return false;
    const participant = getDb()
      .prepare(
        `UPDATE community_participants SET
         owner_id = ?, identity_key = ?, wallet_address = ?, payout_address = ?,
         payout_script_pubkey_hex = ?, matrica_user_id = ?, matrica_username = ?,
         requested_units = ?, waitlisted_units = 0, max_contribution_sats = 0,
         qualifying_inscription_number = ?, root_fingerprint_hex = ?, campaign_xpub = ?,
         recovery_confirmed = 1, inferred_links_json = ?, reservation_payload_json = ?,
         reservation_signature = ?, reservation_nonce = ?, readiness_status = 'ready',
         readiness_payload_json = NULL, readiness_signature = NULL, readiness_nonce = NULL,
         funding_outpoints_json = NULL, ready_at = ?
       WHERE id = ? AND owner_id = ?`
      )
      .run(
        row.buyer_owner_id,
        row.buyer_identity_key,
        row.buyer_wallet_address,
        row.buyer_payout_address,
        row.buyer_payout_script_pubkey_hex,
        row.buyer_matrica_user_id,
        row.buyer_matrica_username,
        JSON.parse(row.transferred_units_json).length,
        row.buyer_qualifying_inscription_number,
        row.buyer_root_fingerprint_hex,
        row.buyer_campaign_xpub,
        row.buyer_inferred_links_json ?? '[]',
        row.buyer_acceptance_payload_json,
        row.buyer_acceptance_signature,
        JSON.parse(row.buyer_acceptance_payload_json!).nonce,
        now,
        row.seller_participant_id,
        row.seller_owner_id
      );
    if (participant.changes !== 1) {
      throw new CommunityPurchaseError(
        'transfer-owner-changed',
        'The current owner changed before confirmation.',
        409
      );
    }
    const campaign = getDb()
      .prepare(
        `UPDATE community_campaigns SET current_outpoint = ?, cap_table_version = ?,
         cap_table_hash = ?, policy_id = ?, vault_address = ?, policy_json = ?,
         active_operation_kind = NULL, active_operation_id = NULL, updated_at = ?
       WHERE id = ? AND status = 'held' AND active_operation_kind = 'position-transfer'
         AND active_operation_id = ?`
      )
      .run(
        expectedOutpoint,
        plan.nextPolicy.capTableVersion,
        plan.nextPolicy.capTableHash,
        plan.nextPolicy.policyId,
        plan.nextPolicy.address,
        JSON.stringify(plan.nextPolicy),
        now,
        row.campaign_id,
        row.id
      );
    if (campaign.changes !== 1) {
      throw new CommunityPurchaseError(
        'transfer-campaign-changed',
        'The group buy changed before confirmation.',
        409
      );
    }
    getDb()
      .prepare(
        `INSERT INTO community_campaign_events (campaign_id, event_type, owner_id, detail_json, created_at)
       VALUES (?, 'position-transfer-confirmed', ?, ?, ?)`
      )
      .run(
        row.campaign_id,
        row.buyer_owner_id,
        JSON.stringify({ txid: row.txid, outpoint: expectedOutpoint, confirmations }),
        now
      );
    return true;
  })();
  if (!updated) return requireCampaign(row.campaign_id, now);
  return requireCampaign(row.campaign_id, now);
}

function privateView(
  row: TransferRow,
  session: BuyerSession | null
): CommunityPositionTransferPrivateView {
  const buyerMatch = !!session && row.buyer_wallet_address === session.ord_addr;
  const plan = row.plan_json
    ? (JSON.parse(row.plan_json) as CommunityVaultPositionTransferPlanV1)
    : null;
  const preflight = row.preflight_json
    ? (JSON.parse(row.preflight_json) as CommunityVaultPositionTransferPreflightV1)
    : null;
  const campaign = requireCampaign(row.campaign_id, Math.floor(Date.now() / 1_000));
  return {
    transferId: row.id,
    campaignId: row.campaign_id,
    inscriptionNumber: campaign.inscriptionNumber,
    eligibilityMode: campaign.eligibilityMode,
    status: row.status,
    sellerOwnerId: row.seller_owner_id,
    transferredUnits: JSON.parse(row.transferred_units_json),
    sellerPriceSats: String(row.seller_price_sats),
    expiresAtMs: String(row.expires_at_ms),
    buyerOwnerId: buyerMatch ? row.buyer_owner_id : null,
    buyerWalletAddress: buyerMatch ? row.buyer_wallet_address : null,
    buyerContext:
      buyerMatch && plan && preflight
        ? { version: 1, currentPolicy: JSON.parse(row.previous_policy_json), plan, preflight }
        : null,
    signingPsbtBase64:
      buyerMatch && row.signing_psbt_hex
        ? Buffer.from(row.signing_psbt_hex, 'hex').toString('base64')
        : null,
    buyerInputIndexes: buyerMatch && plan ? plan.buyerInputs.map((_input, index) => index + 1) : [],
  };
}

function ownerView(row: TransferRow, ownerId: string): CommunityPositionTransferOwnerView {
  const plan = row.plan_json
    ? (JSON.parse(row.plan_json) as CommunityVaultPositionTransferPlanV1)
    : null;
  const preflight = row.preflight_json
    ? (JSON.parse(row.preflight_json) as CommunityVaultPositionTransferPreflightV1)
    : null;
  const signatures = getDb()
    .prepare(
      `SELECT owner_id, signed_units_json FROM community_position_transfer_signatures WHERE transfer_id = ? ORDER BY created_at`
    )
    .all(row.id) as Array<{ owner_id: string; signed_units_json: string }>;
  return {
    transferId: row.id,
    status: row.status,
    sellerOwnerId: row.seller_owner_id,
    buyerOwnerId: row.buyer_owner_id,
    buyerIdentityLabel: row.buyer_matrica_username
      ? `@${row.buyer_matrica_username}`
      : row.buyer_owner_id
        ? 'verified wallet'
        : null,
    transferredUnits: JSON.parse(row.transferred_units_json),
    sellerPriceSats: String(row.seller_price_sats),
    expiresAtMs: String(row.expires_at_ms),
    sellerAuthorizationPayload:
      ownerId === row.seller_owner_id && row.seller_authorization_payload_json
        ? JSON.parse(row.seller_authorization_payload_json)
        : null,
    ownerContext:
      row.status === 'signing' && plan && preflight
        ? {
            version: 1,
            ownerId,
            currentPolicy: JSON.parse(row.previous_policy_json),
            plan,
            preflight,
          }
        : null,
    signingPsbtBase64:
      row.status === 'signing' && row.buyer_funded_psbt_hex
        ? Buffer.from(row.buyer_funded_psbt_hex, 'hex').toString('base64')
        : null,
    signedOwnerIds: signatures.map(item => item.owner_id),
    signedUnitCount: new Set(
      signatures.flatMap(item => JSON.parse(item.signed_units_json) as number[])
    ).size,
    requiredUnitCount: 69,
  };
}

async function refreshTransfer(
  row: TransferRow,
  nowMs: number,
  deps?: Partial<PositionTransferOfferDependencies>
): Promise<void> {
  if (!row.plan_json) return;
  try {
    const currentPolicy = JSON.parse(row.previous_policy_json) as CommunityVaultPolicyV1;
    const plan = JSON.parse(row.plan_json) as CommunityVaultPositionTransferPlanV1;
    const preflight = await refreshCommunityPositionTransferPreflight({
      currentPolicy,
      plan,
      deps,
    });
    getDb()
      .prepare(
        `UPDATE community_position_transfers SET preflight_json = ?, updated_at = ? WHERE id = ?`
      )
      .run(JSON.stringify(preflight), Math.floor(nowMs / 1_000), row.id);
  } catch (error) {
    if (
      error instanceof CommunityPurchaseError &&
      error.code === 'position-transfer-funds-changed'
    ) {
      finishTransfer(row, 'failed', Math.floor(nowMs / 1_000));
    }
    throw error;
  }
}

function combineApprovals(
  row: TransferRow,
  policy: CommunityVaultPolicyV1,
  plan: CommunityVaultPositionTransferPlanV1,
  now: number
): void {
  const packages = [
    row.buyer_funded_psbt_hex!,
    ...(
      getDb()
        .prepare(
          `SELECT signed_psbt_hex FROM community_position_transfer_signatures WHERE transfer_id = ? ORDER BY owner_id`
        )
        .all(row.id) as Array<{ signed_psbt_hex: string }>
    ).map(item => item.signed_psbt_hex),
  ];
  const combined = combineCommunityVaultPositionTransferPsbts({
    currentPolicy: policy,
    plan,
    psbtHexes: packages,
  });
  if (combined.signedUnits.length < 69) {
    getDb()
      .prepare(
        `UPDATE community_position_transfers SET combined_psbt_hex = ?, updated_at = ? WHERE id = ?`
      )
      .run(combined.psbtHex, now, row.id);
    return;
  }
  const finalized = finalizeCommunityVaultPositionTransferPsbt(policy, plan, combined.psbtHex);
  getDb().transaction(() => {
    getDb()
      .prepare(
        `UPDATE community_position_transfers SET status = 'ready', combined_psbt_hex = ?,
       transaction_hex = ?, txid = ?, updated_at = ? WHERE id = ? AND status = 'signing'`
      )
      .run(combined.psbtHex, finalized.transactionHex, finalized.txid, now, row.id);
    getDb()
      .prepare(
        `INSERT INTO community_campaign_events (campaign_id, event_type, detail_json, created_at)
       VALUES (?, 'position-transfer-ready', ?, ?)`
      )
      .run(
        row.campaign_id,
        JSON.stringify({ txid: finalized.txid, signedUnits: finalized.signedUnits.length }),
        now
      );
  })();
}

function requireTransfer(id: string, nowMs?: number): TransferRow {
  const row = getDb().prepare(`SELECT * FROM community_position_transfers WHERE id = ?`).get(id) as
    | TransferRow
    | undefined;
  if (!row)
    throw new CommunityPurchaseError('transfer-not-found', 'Ownership transfer not found.', 404);
  if (
    nowMs !== undefined &&
    row.expires_at_ms <= nowMs &&
    ['invited', 'buyer-accepted', 'authorized', 'signing', 'ready'].includes(row.status)
  ) {
    finishTransfer(row, 'expired', Math.floor(nowMs / 1_000));
    throw new CommunityPurchaseError(
      'transfer-expired',
      'This private invitation has expired.',
      409
    );
  }
  return row;
}

function requireTransferByToken(token: string, nowMs: number): TransferRow {
  if (!/^[A-Za-z0-9_-]{40,64}$/u.test(token))
    throw new CommunityPurchaseError('invite-not-found', 'Private invitation not found.', 404);
  const row = getDb()
    .prepare(`SELECT * FROM community_position_transfers WHERE invite_token_hash = ?`)
    .get(sha256(token)) as TransferRow | undefined;
  if (!row)
    throw new CommunityPurchaseError('invite-not-found', 'Private invitation not found.', 404);
  return requireTransfer(row.id, nowMs);
}

function finishTransfer(
  row: TransferRow,
  status: 'expired' | 'cancelled' | 'failed',
  now: number
): void {
  getDb().transaction(() => {
    getDb()
      .prepare(
        `UPDATE community_position_transfers SET status = ?, updated_at = ?
       WHERE id = ? AND status NOT IN ('confirmed','broadcast')`
      )
      .run(status, now, row.id);
    getDb()
      .prepare(
        `UPDATE community_campaigns SET active_operation_kind = NULL, active_operation_id = NULL, updated_at = ?
       WHERE id = ? AND active_operation_kind = 'position-transfer' AND active_operation_id = ?`
      )
      .run(now, row.campaign_id, row.id);
  })();
}

function buyerFromRow(row: TransferRow): CommunityVaultPositionTransferBuyerV1 {
  if (
    !row.buyer_owner_id ||
    !row.buyer_identity_commitment_hex ||
    !row.buyer_payout_address ||
    !row.buyer_payout_script_pubkey_hex ||
    !row.buyer_root_fingerprint_hex ||
    !row.buyer_campaign_xpub
  ) {
    throw new CommunityPurchaseError('buyer-incomplete', 'The buyer setup is incomplete.', 409);
  }
  return {
    ownerId: row.buyer_owner_id,
    identityCommitmentHex: row.buyer_identity_commitment_hex,
    payoutAddress: row.buyer_payout_address,
    payoutScriptPubKeyHex: row.buyer_payout_script_pubkey_hex,
    campaignRoot: {
      version: 1,
      masterFingerprintHex: row.buyer_root_fingerprint_hex,
      originPath: 'm',
      campaignXpub: row.buyer_campaign_xpub,
    },
    qualifyingInscriptionNumber: row.buyer_qualifying_inscription_number,
  };
}

function validateCreatePayload(payload: CreatePositionTransferInvitePayloadV1, now: number): void {
  if (
    payload.protocol !== COMMUNITY_PURCHASES_PROTOCOL ||
    payload.version !== 1 ||
    payload.network !== 'mainnet' ||
    payload.action !== 'create-position-transfer-invite' ||
    !IDENTIFIER.test(payload.campaignId) ||
    !IDENTIFIER.test(payload.sellerOwnerId) ||
    !/^[1-9][0-9]*$/u.test(payload.sellerPriceSats) ||
    !IDENTIFIER.test(payload.nonce) ||
    !Number.isInteger(payload.expiresAt) ||
    payload.expiresAt <= now ||
    payload.expiresAt > now + MAX_TRANSFER_SEC
  ) {
    throw new CommunityPurchaseError(
      'transfer-invite-invalid',
      'The private transfer invitation is invalid.'
    );
  }
}

function validateAcceptPayload(payload: AcceptPositionTransferPayloadV1, now: number): void {
  if (
    payload.protocol !== COMMUNITY_PURCHASES_PROTOCOL ||
    payload.version !== 1 ||
    payload.network !== 'mainnet' ||
    payload.action !== 'accept-position-transfer' ||
    !IDENTIFIER.test(payload.campaignId) ||
    !IDENTIFIER.test(payload.transferId) ||
    !IDENTIFIER.test(payload.buyerOwnerId) ||
    payload.recoveryConfirmed !== true ||
    payload.noAlternateIdentityAttestation !== true ||
    payload.identityDisclosureConsent !== true ||
    !IDENTIFIER.test(payload.nonce) ||
    !Number.isInteger(payload.expiresAt) ||
    payload.expiresAt < now ||
    payload.expiresAt > now + ACTION_WINDOW_SEC
  ) {
    throw new CommunityPurchaseError(
      'transfer-acceptance-invalid',
      'The buyer acceptance is invalid or expired.'
    );
  }
}

function validateApprovalPayload(
  payload: ApprovePositionTransferPayloadV1,
  campaignId: string,
  transferId: string,
  now: number
): void {
  if (
    payload.protocol !== COMMUNITY_PURCHASES_PROTOCOL ||
    payload.version !== 1 ||
    payload.network !== 'mainnet' ||
    payload.action !== 'approve-position-transfer' ||
    payload.campaignId !== campaignId ||
    payload.transferId !== transferId ||
    !IDENTIFIER.test(payload.ownerId) ||
    !HEX_32.test(payload.transferDigest) ||
    !HEX_32.test(payload.signedPsbtHash) ||
    !IDENTIFIER.test(payload.nonce) ||
    !Number.isInteger(payload.capTableVersion) ||
    payload.capTableVersion < 1 ||
    !Number.isInteger(payload.approvedAt) ||
    !Number.isInteger(payload.expiresAt) ||
    payload.approvedAt > now + 60 ||
    payload.expiresAt < now ||
    payload.expiresAt - payload.approvedAt > ACTION_WINDOW_SEC
  ) {
    throw new CommunityPurchaseError(
      'transfer-approval-invalid',
      'The ownership transfer approval is invalid or expired.'
    );
  }
}

function recognizedIdentity(db: ReturnType<typeof getDb>, walletAddress: string) {
  const row = db
    .prepare(
      `SELECT wl.matrica_user_id, mu.username FROM wallet_links wl
     LEFT JOIN matrica_users mu ON mu.user_id = wl.matrica_user_id WHERE wl.wallet_addr = ?`
    )
    .get(walletAddress) as { matrica_user_id: string | null; username: string | null } | undefined;
  return row?.matrica_user_id
    ? {
        key: `matrica:${row.matrica_user_id}`,
        matricaUserId: row.matrica_user_id,
        username: row.username,
      }
    : { key: `wallet:${walletAddress}`, matricaUserId: null, username: null };
}

function walletsForIdentity(
  db: ReturnType<typeof getDb>,
  identity: ReturnType<typeof recognizedIdentity>,
  walletAddress: string
): string[] {
  if (!identity.matricaUserId) return [walletAddress];
  return (
    db
      .prepare(`SELECT wallet_addr FROM wallet_links WHERE matrica_user_id = ?`)
      .all(identity.matricaUserId) as Array<{ wallet_addr: string }>
  ).map(row => row.wallet_addr);
}

function ownsQualifyingOmb(
  db: ReturnType<typeof getDb>,
  wallets: string[],
  inscriptionNumber: number,
  snapshotAt: number
): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM inscriptions WHERE collection_slug = 'omb'
     AND current_owner IN (SELECT value FROM json_each(?)) AND COALESCE(active_loan_count, 0) = 0
     AND inscription_number = ? AND COALESCE(last_movement_at, inscribe_at, 0) <= ? LIMIT 1`
    )
    .get(JSON.stringify(wallets), inscriptionNumber, snapshotAt);
}

function inferredIdentityLinks(db: ReturnType<typeof getDb>, walletAddress: string) {
  return db
    .prepare(
      `SELECT CASE WHEN addr_a = ? THEN addr_b ELSE addr_a END AS wallet, confidence
     FROM wallet_cluster_edges WHERE (addr_a = ? OR addr_b = ?) AND confidence >= 8000
     ORDER BY confidence DESC, wallet ASC LIMIT 20`
    )
    .all(walletAddress, walletAddress, walletAddress);
}

function mainnetScript(value: string): string {
  try {
    return Buffer.from(address.toOutputScript(value, networks.bitcoin)).toString('hex');
  } catch {
    throw new CommunityPurchaseError(
      'payout-address-invalid',
      'Use a valid mainnet payout address.'
    );
  }
}

function parseOutpoint(value: string): { txid: string; vout: number } {
  const match = /^([0-9a-f]{64}):(0|[1-9][0-9]*)$/u.exec(value);
  if (!match)
    throw new CommunityPurchaseError(
      'outpoint-invalid',
      'The current vault output is invalid.',
      409
    );
  return { txid: match[1]!, vout: Number(match[2]) };
}

function base64PsbtToHex(value: string): string {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length > 1_500_000) {
    throw new CommunityPurchaseError('psbt-invalid', 'Drey returned an invalid PSBT.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value)
    throw new CommunityPurchaseError('psbt-invalid', 'Drey returned a non-canonical PSBT.');
  return bytes.toString('hex');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireCampaign(id: string, now: number): CommunityCampaignView {
  const campaign = getCommunityCampaign(id, now);
  if (!campaign)
    throw new CommunityPurchaseError('campaign-not-found', 'Group buy not found.', 404);
  return campaign;
}
