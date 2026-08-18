import 'server-only';

import { createHash } from 'node:crypto';
import { address, networks } from 'bitcoinjs-lib';
import { createCommunityVaultPolicy } from '@drey/core/domain/community-vault/policy';
import type {
  CommunityVaultOwnerInputV1,
  CommunityVaultPolicyV1,
} from '@drey/core/domain/community-vault/contracts';
import { getDb } from '@/lib/db';
import { getRawTransaction, type RawTx } from '@/lib/bitcoind';
import { estimateMarketplaceBuyerCost } from '@/lib/marketplace/fees';
import {
  ANCHORED_CREATOR_UNITS,
  COMMUNITY_PURCHASES_IDENTITY_CAP,
  COMMUNITY_PURCHASES_PROTOCOL,
  COMMUNITY_PURCHASES_TERMS_VERSION,
  COMMUNITY_PURCHASES_UNIT_COUNT,
  type CommunityCampaignView,
  type CommunityEnrollmentV1,
  type CommunityParticipantView,
  type ConfirmReadinessPayloadV1,
  type CreateCampaignPayloadV1,
  type ReserveUnitsPayloadV1,
} from './contracts';
import { installPublicPolicyCrypto } from './dreyCrypto';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const XPUB = /^xpub[1-9A-HJ-NP-Za-km-z]{107}$/u;
const HEX_8 = /^[0-9a-f]{8}$/u;
const OUTPOINT = /^([0-9a-f]{64}):(0|[1-9][0-9]*)$/u;
const ACTION_WINDOW_SEC = 15 * 60;
const LISTED_DURATION_SEC = 60 * 60;
const FRONTED_DURATION_SEC = 72 * 60 * 60;
const LISTED_READINESS_SEC = 10 * 60;
const FRONTED_READINESS_SEC = 60 * 60;

type CampaignRow = {
  id: string;
  inscription_number: number;
  inscription_id: string;
  current_outpoint: string;
  source: 'listed' | 'creator-fronted';
  ownership_mode: 'anchored' | 'open';
  eligibility_mode: 'anyone' | 'omb-holders-only';
  creator_owner_id: string;
  status: CommunityCampaignView['status'];
  terms_version: string;
  landed_cost_sats: number;
  max_landed_cost_sats: number;
  marketplace: string | null;
  listing_id: string | null;
  source_fingerprint: string;
  opened_at: number;
  expires_at: number;
  readiness_started_at: number | null;
  readiness_deadline: number | null;
  frozen_at: number | null;
  cap_table_version: number;
  cap_table_hash: string | null;
  policy_id: string | null;
  vault_address: string | null;
  policy_json: string | null;
};

type ParticipantRow = {
  id: number;
  campaign_id: string;
  owner_id: string;
  cap_table_order: number;
  identity_key: string;
  wallet_address: string;
  payout_address: string;
  payout_script_pubkey_hex: string;
  matrica_user_id: string | null;
  matrica_username: string | null;
  is_creator: 0 | 1;
  requested_units: number;
  waitlisted_units: number;
  max_contribution_sats: number;
  qualifying_inscription_number: number | null;
  root_fingerprint_hex: string;
  campaign_xpub: string;
  recovery_confirmed: 0 | 1;
  inferred_links_json: string;
  readiness_status: 'waiting' | 'ready' | 'timed-out';
  joined_at: number;
};

export class CommunityPurchaseError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = 'CommunityPurchaseError';
  }
}

export function communityPurchasesEnabled(): boolean {
  return (
    process.env.COMMUNITY_PURCHASES_ENABLED === 'true' ||
    process.env.NEXT_PUBLIC_COMMUNITY_PURCHASES_ENABLED === 'true'
  );
}

export function listCommunityCampaigns(now = unixNow()): CommunityCampaignView[] {
  const db = getDb();
  const ids = db
    .prepare(`SELECT id FROM community_campaigns ORDER BY opened_at DESC, id DESC LIMIT 100`)
    .all() as Array<{ id: string }>;
  return ids
    .map(({ id }) => getCommunityCampaign(id, now))
    .filter(Boolean) as CommunityCampaignView[];
}

export function getCommunityCampaign(id: string, now = unixNow()): CommunityCampaignView | null {
  const db = getDb();
  reconcileCampaign(db, id, now);
  const campaign = db.prepare(`SELECT * FROM community_campaigns WHERE id = ?`).get(id) as
    | CampaignRow
    | undefined;
  if (!campaign) return null;
  const participants = db
    .prepare(
      `SELECT * FROM community_participants WHERE campaign_id = ? ORDER BY cap_table_order, id`
    )
    .all(id) as ParticipantRow[];
  const units = db
    .prepare(
      `SELECT participant_id, unit_number FROM community_units WHERE campaign_id = ? ORDER BY unit_number`
    )
    .all(id) as Array<{ participant_id: number; unit_number: number }>;
  const byParticipant = new Map<number, number[]>();
  for (const unit of units) {
    const list = byParticipant.get(unit.participant_id) ?? [];
    list.push(unit.unit_number);
    byParticipant.set(unit.participant_id, list);
  }
  const participantViews: CommunityParticipantView[] = participants.map(row => ({
    ownerId: row.owner_id,
    capTableOrder: row.cap_table_order,
    walletAddress: row.wallet_address,
    payoutAddress: row.payout_address,
    matricaUserId: row.matrica_user_id,
    matricaUsername: row.matrica_username,
    identityLabel: row.matrica_username ? `@${row.matrica_username}` : 'identity unknown',
    isCreator: row.is_creator === 1,
    requestedUnits: row.requested_units,
    allocatedUnits: byParticipant.get(row.id) ?? [],
    waitlistedUnits: row.waitlisted_units,
    readiness: row.readiness_status,
    recoveryConfirmed: row.recovery_confirmed === 1,
    inferredLinks: parseInferredLinks(row.inferred_links_json),
    campaignRoot: {
      version: 1,
      masterFingerprintHex: row.root_fingerprint_hex,
      originPath: 'm',
      campaignXpub: row.campaign_xpub,
    },
  }));
  return {
    id: campaign.id,
    inscriptionNumber: campaign.inscription_number,
    inscriptionId: campaign.inscription_id,
    currentOutpoint: campaign.current_outpoint,
    source: campaign.source,
    ownershipMode: campaign.ownership_mode,
    eligibilityMode: campaign.eligibility_mode,
    status: campaign.status,
    creatorOwnerId: campaign.creator_owner_id,
    landedCostSats: String(campaign.landed_cost_sats),
    maxLandedCostSats: String(campaign.max_landed_cost_sats),
    marketplace: campaign.marketplace,
    listingId: campaign.listing_id,
    openedAt: campaign.opened_at,
    expiresAt: campaign.expires_at,
    readinessDeadline: campaign.readiness_deadline,
    capTableVersion: campaign.cap_table_version,
    capTableHash: campaign.cap_table_hash,
    policyId: campaign.policy_id,
    vaultAddress: campaign.vault_address,
    policy: campaign.policy_json ? JSON.parse(campaign.policy_json) : null,
    allocatedUnitCount: units.length,
    waitlistedUnitCount: participants.reduce((sum, row) => sum + row.waitlisted_units, 0),
    participants: participantViews,
  };
}

export async function createCommunityCampaign(args: {
  payload: CreateCampaignPayloadV1;
  signature: string;
  walletAddress: string;
  now?: number;
  fetchTransaction?: (txid: string) => Promise<RawTx>;
}): Promise<CommunityCampaignView> {
  const now = args.now ?? unixNow();
  validateCreatePayload(args.payload, now);
  const db = getDb();
  const identity = recognizedIdentity(db, args.walletAddress);
  const identityWallets = walletsForIdentity(db, identity, args.walletAddress);
  if (!ownsQualifyingOmb(db, identityWallets, null, now)) {
    throw new CommunityPurchaseError(
      'creator-omb-required',
      'Campaign creators must control an OMB.',
      403
    );
  }

  const target = db
    .prepare(
      `SELECT inscription_number, inscription_id, current_output, current_owner, effective_owner,
              active_loan_count
       FROM inscriptions WHERE inscription_number = ? AND collection_slug = 'omb'`
    )
    .get(args.payload.inscriptionNumber) as
    | {
        inscription_number: number;
        inscription_id: string | null;
        current_output: string | null;
        current_owner: string | null;
        effective_owner: string | null;
        active_loan_count: number;
      }
    | undefined;
  if (!target?.inscription_id || !target.current_output) {
    throw new CommunityPurchaseError(
      'target-unavailable',
      'The target OMB does not have current indexed ownership data.'
    );
  }

  let landedCost: number;
  let marketplace: string | null = null;
  let listingId: string | null = null;
  let sourceFingerprint: string;
  let frontedBuyIntentId: number | null = null;
  if (args.payload.source === 'listed') {
    const listing = db
      .prepare(
        `SELECT al.* FROM active_listings al
         WHERE al.inscription_number = ? AND al.satflow_id = ? AND al.marketplace = ?`
      )
      .get(args.payload.inscriptionNumber, args.payload.listingId, args.payload.marketplace) as
      | {
          satflow_id: string;
          marketplace: string;
          price_sats: number;
          seller: string | null;
          refreshed_at: number;
        }
      | undefined;
    if (!listing)
      throw new CommunityPurchaseError(
        'listing-changed',
        'That exact listing is no longer active.',
        409
      );
    const estimate = estimateMarketplaceBuyerCost(listing.marketplace, listing.price_sats);
    landedCost = estimate.estimated_buyer_total_sats;
    marketplace = listing.marketplace;
    listingId = listing.satflow_id;
    sourceFingerprint = sha256(
      JSON.stringify({
        inscriptionId: target.inscription_id,
        outpoint: target.current_output,
        marketplace,
        listingId,
        priceSats: listing.price_sats,
        seller: listing.seller,
      })
    );
  } else {
    if (!identityWallets.includes(target.current_owner ?? '') || target.active_loan_count > 0) {
      throw new CommunityPurchaseError(
        'fronted-owner-required',
        'The creator must presently hold the unloaned target OMB.',
        403
      );
    }
    const intent = db
      .prepare(`SELECT * FROM buy_intents WHERE id = ? AND status = 'confirmed' AND is_mock = 0`)
      .get(args.payload.frontedBuyIntentId) as
      | {
          id: number;
          inscription_id: string;
          buyer_ord_addr: string;
          buyer_pay_addr: string | null;
          marketplace: string;
          price_sats: number;
          txid: string | null;
          updated_at: number;
          preflight_json: string | null;
        }
      | undefined;
    if (
      !intent?.txid ||
      intent.inscription_id !== target.inscription_id ||
      !identityWallets.includes(intent.buyer_ord_addr) ||
      now - intent.updated_at > 24 * 60 * 60 ||
      !target.current_output.startsWith(`${intent.txid}:`)
    ) {
      throw new CommunityPurchaseError(
        'fronted-purchase-unverified',
        'Use a confirmed gallery purchase from the last 24 hours so exact cost can be verified.',
        409
      );
    }
    const transaction = await (args.fetchTransaction ?? getRawTransaction)(intent.txid);
    landedCost = deriveBuyerDebit(transaction, intent.buyer_pay_addr, intent.buyer_ord_addr);
    if (landedCost < intent.price_sats) {
      throw new CommunityPurchaseError(
        'fronted-cost-invalid',
        'The confirmed purchase cost could not be reconstructed.'
      );
    }
    marketplace = intent.marketplace;
    frontedBuyIntentId = intent.id;
    sourceFingerprint = sha256(
      JSON.stringify({
        intentId: intent.id,
        txid: intent.txid,
        inscriptionId: intent.inscription_id,
        outpoint: target.current_output,
        landedCost,
        preflightHash: sha256(intent.preflight_json ?? ''),
      })
    );
  }

  const maxLandedCost = parseSats(args.payload.maxLandedCostSats, 'maximum landed cost');
  if (maxLandedCost < landedCost) {
    throw new CommunityPurchaseError(
      'cost-cap-too-low',
      'The maximum landed cost is below the verified current cost.'
    );
  }
  const payoutScript = mainnetScript(args.payload.payoutAddress);
  const inferredLinks = inferredIdentityLinks(db, args.walletAddress);
  const duration = args.payload.source === 'listed' ? LISTED_DURATION_SEC : FRONTED_DURATION_SEC;
  const campaignExpiresAt = Math.min(args.payload.expiresAt, now + duration);
  const participantMax = Math.ceil((maxLandedCost * args.payload.creatorUnits) / 100);

  const insert = db.transaction(() => {
    db.prepare(
      `INSERT INTO community_campaigns (
        id, inscription_number, inscription_id, current_outpoint, source, ownership_mode,
        eligibility_mode, creator_owner_id, status, terms_version, landed_cost_sats,
        max_landed_cost_sats, marketplace, listing_id, source_fingerprint,
        fronted_buy_intent_id, opened_at, expires_at, cap_table_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(
      args.payload.campaignId,
      target.inscription_number,
      target.inscription_id,
      target.current_output,
      args.payload.source,
      args.payload.ownershipMode,
      args.payload.eligibilityMode,
      args.payload.creatorOwnerId,
      args.payload.termsVersion,
      landedCost,
      maxLandedCost,
      marketplace,
      listingId,
      sourceFingerprint,
      frontedBuyIntentId,
      now,
      campaignExpiresAt,
      now,
      now
    );
    const participantId = Number(
      db
        .prepare(
          `INSERT INTO community_participants (
            campaign_id, owner_id, cap_table_order, identity_key, wallet_address,
            payout_address, payout_script_pubkey_hex, matrica_user_id, matrica_username,
            is_creator, requested_units, waitlisted_units, max_contribution_sats,
            qualifying_inscription_number, root_fingerprint_hex, campaign_xpub,
            recovery_confirmed, inferred_links_json, reservation_payload_json,
            reservation_signature, reservation_nonce, joined_at
          ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, NULL, ?, ?, 1, ?, ?, ?, ?, ?)`
        )
        .run(
          args.payload.campaignId,
          args.payload.creatorOwnerId,
          identity.key,
          args.walletAddress,
          args.payload.payoutAddress,
          payoutScript,
          identity.matricaUserId,
          identity.username,
          args.payload.creatorUnits,
          participantMax,
          args.payload.enrollment.campaignRoot.masterFingerprintHex,
          args.payload.enrollment.campaignRoot.campaignXpub,
          JSON.stringify(inferredLinks),
          JSON.stringify(args.payload),
          args.signature,
          args.payload.nonce,
          now
        ).lastInsertRowid
    );
    assignUnits(db, args.payload.campaignId, participantId, args.payload.creatorUnits);
    recordEvent(
      db,
      args.payload.campaignId,
      'campaign-opened',
      args.payload.creatorOwnerId,
      {
        source: args.payload.source,
        units: args.payload.creatorUnits,
      },
      now
    );
  });
  try {
    insert();
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed')) {
      throw new CommunityPurchaseError(
        'campaign-conflict',
        'This campaign or target already has an active campaign.',
        409
      );
    }
    throw error;
  }
  return getCommunityCampaign(args.payload.campaignId, now)!;
}

export function reserveCommunityUnits(args: {
  payload: ReserveUnitsPayloadV1;
  signature: string;
  walletAddress: string;
  now?: number;
}): CommunityCampaignView {
  const now = args.now ?? unixNow();
  validateReservePayload(args.payload, now);
  const db = getDb();
  reconcileCampaign(db, args.payload.campaignId, now);
  const campaign = campaignRow(db, args.payload.campaignId);
  if (!campaign || !['open', 'readiness'].includes(campaign.status)) {
    throw new CommunityPurchaseError(
      'campaign-not-open',
      'This campaign is no longer accepting reservations.',
      409
    );
  }
  if (campaign.cap_table_version !== args.payload.capTableVersion) {
    throw new CommunityPurchaseError(
      'cap-table-changed',
      'The roster changed. Review the campaign and try again.',
      409
    );
  }
  const identity = recognizedIdentity(db, args.walletAddress);
  const identityWallets = walletsForIdentity(db, identity, args.walletAddress);
  if (campaign.eligibility_mode === 'omb-holders-only') {
    if (
      args.payload.qualifyingInscriptionNumber == null ||
      !ownsQualifyingOmb(
        db,
        identityWallets,
        args.payload.qualifyingInscriptionNumber,
        campaign.opened_at
      )
    ) {
      throw new CommunityPurchaseError(
        'holder-proof-required',
        'Choose an unloaned OMB this identity held before the campaign opened.',
        403
      );
    }
  } else if (args.payload.qualifyingInscriptionNumber != null) {
    throw new CommunityPurchaseError(
      'unexpected-holder-proof',
      'This campaign does not use a holder gate.'
    );
  }
  const maxContribution = parseSats(args.payload.maxContributionSats, 'maximum contribution');
  const requiredMaximum = Math.ceil(
    (campaign.max_landed_cost_sats * args.payload.requestedUnits) / COMMUNITY_PURCHASES_UNIT_COUNT
  );
  if (maxContribution < requiredMaximum) {
    throw new CommunityPurchaseError(
      'contribution-cap-too-low',
      `The maximum contribution must cover up to ${requiredMaximum.toLocaleString()} sats.`
    );
  }
  const payoutScript = mainnetScript(args.payload.payoutAddress);
  const inferredLinks = inferredIdentityLinks(db, args.walletAddress);

  const tx = db.transaction(() => {
    const allocatedCount = countAllocated(db, campaign.id);
    const available = COMMUNITY_PURCHASES_UNIT_COUNT - allocatedCount;
    const allocated = Math.min(args.payload.requestedUnits, Math.max(0, available));
    const waitlisted = args.payload.requestedUnits - allocated;
    const order = (
      db
        .prepare(
          `SELECT COALESCE(MAX(cap_table_order), -1) + 1 AS n FROM community_participants WHERE campaign_id = ?`
        )
        .get(campaign.id) as { n: number }
    ).n;
    let participantId: number;
    try {
      participantId = Number(
        db
          .prepare(
            `INSERT INTO community_participants (
              campaign_id, owner_id, cap_table_order, identity_key, wallet_address,
              payout_address, payout_script_pubkey_hex, matrica_user_id, matrica_username,
              is_creator, requested_units, waitlisted_units, max_contribution_sats,
              qualifying_inscription_number, root_fingerprint_hex, campaign_xpub,
              recovery_confirmed, inferred_links_json, reservation_payload_json,
              reservation_signature, reservation_nonce, joined_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
          )
          .run(
            campaign.id,
            args.payload.ownerId,
            order,
            identity.key,
            args.walletAddress,
            args.payload.payoutAddress,
            payoutScript,
            identity.matricaUserId,
            identity.username,
            args.payload.requestedUnits,
            waitlisted,
            maxContribution,
            args.payload.qualifyingInscriptionNumber,
            args.payload.enrollment.campaignRoot.masterFingerprintHex,
            args.payload.enrollment.campaignRoot.campaignXpub,
            JSON.stringify(inferredLinks),
            JSON.stringify(args.payload),
            args.signature,
            args.payload.nonce,
            now
          ).lastInsertRowid
      );
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) {
        throw new CommunityPurchaseError(
          'identity-already-joined',
          'This recognized identity, qualifying OMB, or Drey campaign key is already enrolled.',
          409
        );
      }
      throw error;
    }
    if (allocated > 0) assignUnits(db, campaign.id, participantId, allocated);
    if (allocated > 0) bumpCapTableVersion(db, campaign.id, now);
    recordEvent(
      db,
      campaign.id,
      allocated > 0 ? 'units-reserved' : 'waitlisted',
      args.payload.ownerId,
      {
        allocated,
        waitlisted,
      },
      now
    );
    if (
      campaign.status === 'open' &&
      countAllocated(db, campaign.id) === COMMUNITY_PURCHASES_UNIT_COUNT
    ) {
      startReadiness(db, campaign, now);
    }
  });
  tx();
  return getCommunityCampaign(campaign.id, now)!;
}

export function confirmCommunityReadiness(args: {
  payload: ConfirmReadinessPayloadV1;
  signature: string;
  walletAddress: string;
  now?: number;
}): CommunityCampaignView {
  const now = args.now ?? unixNow();
  validateReadinessPayload(args.payload, now);
  const db = getDb();
  reconcileCampaign(db, args.payload.campaignId, now);
  const campaign = campaignRow(db, args.payload.campaignId);
  if (!campaign || campaign.status !== 'readiness') {
    throw new CommunityPurchaseError(
      'readiness-closed',
      'This campaign is not collecting readiness now.',
      409
    );
  }
  if (campaign.cap_table_version !== args.payload.capTableVersion) {
    throw new CommunityPurchaseError(
      'cap-table-changed',
      'The roster changed. Review it before confirming again.',
      409
    );
  }
  const participant = db
    .prepare(`SELECT * FROM community_participants WHERE campaign_id = ? AND owner_id = ?`)
    .get(campaign.id, args.payload.ownerId) as ParticipantRow | undefined;
  if (!participant || participant.wallet_address !== args.walletAddress) {
    throw new CommunityPurchaseError(
      'participant-mismatch',
      'Reconnect the wallet used for this reservation.',
      403
    );
  }
  const allocated = countParticipantUnits(db, participant.id);
  if (allocated === 0)
    throw new CommunityPurchaseError('not-selected', 'This reservation is still waitlisted.', 409);
  const overlap = db
    .prepare(
      `SELECT 1 FROM community_participants p, json_each(p.funding_outpoints_json) committed
       WHERE p.campaign_id = ? AND p.id != ?
         AND committed.value IN (SELECT value FROM json_each(?))
       LIMIT 1`
    )
    .get(campaign.id, participant.id, JSON.stringify(args.payload.fundingOutpoints));
  if (overlap) {
    throw new CommunityPurchaseError(
      'funding-input-reused',
      'A funding input is already committed by another selected owner.',
      409
    );
  }

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE community_participants SET
         readiness_status = 'ready', readiness_payload_json = ?, readiness_signature = ?,
         readiness_nonce = ?, funding_outpoints_json = ?, ready_at = ?
       WHERE id = ?`
    ).run(
      JSON.stringify(args.payload),
      args.signature,
      args.payload.nonce,
      JSON.stringify(args.payload.fundingOutpoints),
      now,
      participant.id
    );
    recordEvent(db, campaign.id, 'owner-ready', participant.owner_id, { units: allocated }, now);
    const notReady = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM community_participants p
           WHERE p.campaign_id = ?
             AND EXISTS (SELECT 1 FROM community_units u WHERE u.participant_id = p.id)
             AND p.readiness_status != 'ready'`
        )
        .get(campaign.id) as { n: number }
    ).n;
    if (notReady === 0) freezeCampaign(db, campaign.id, now);
  });
  try {
    tx();
  } catch (error) {
    if (error instanceof CommunityPurchaseError) throw error;
    throw new CommunityPurchaseError(
      'policy-construction-failed',
      error instanceof Error ? error.message : 'The frozen policy could not be constructed.',
      409
    );
  }
  return getCommunityCampaign(campaign.id, now)!;
}

function validateCreatePayload(payload: CreateCampaignPayloadV1, now: number): void {
  if (
    payload.protocol !== COMMUNITY_PURCHASES_PROTOCOL ||
    payload.version !== 1 ||
    payload.network !== 'mainnet' ||
    payload.action !== 'create-campaign' ||
    payload.termsVersion !== COMMUNITY_PURCHASES_TERMS_VERSION
  ) {
    throw new CommunityPurchaseError(
      'unsupported-contract',
      'Use the current mainnet Community Purchases terms.'
    );
  }
  validateCommonEnrollment(payload.enrollment, payload.campaignId, payload.creatorOwnerId);
  if (!IDENTIFIER.test(payload.campaignId) || !IDENTIFIER.test(payload.creatorOwnerId)) {
    throw new CommunityPurchaseError(
      'invalid-identifier',
      'Campaign and owner identifiers are invalid.'
    );
  }
  if (!Number.isInteger(payload.inscriptionNumber))
    throw new CommunityPurchaseError('invalid-target', 'Choose an OMB.');
  if (payload.ownershipMode === 'anchored') {
    if (
      payload.creatorUnits !== ANCHORED_CREATOR_UNITS ||
      payload.permanentAnchorAccepted !== true
    ) {
      throw new CommunityPurchaseError(
        'anchor-terms-required',
        'Anchored campaigns require exactly 33 creator units and the permanent-anchor warning.'
      );
    }
  } else if (payload.creatorUnits < 1 || payload.creatorUnits > COMMUNITY_PURCHASES_IDENTITY_CAP) {
    throw new CommunityPurchaseError(
      'creator-unit-limit',
      'Open campaign creators may take 1 to 20 units.'
    );
  }
  if (payload.source === 'listed') {
    if (!payload.listingId || !payload.marketplace || payload.frontedBuyIntentId != null) {
      throw new CommunityPurchaseError('listing-required', 'Choose one exact active listing.');
    }
  } else if (
    !Number.isInteger(payload.frontedBuyIntentId) ||
    payload.listingId ||
    payload.marketplace
  ) {
    throw new CommunityPurchaseError(
      'fronted-intent-required',
      'Choose the confirmed purchase that established exact cost.'
    );
  }
  validateActionExpiry(
    payload.expiresAt,
    now,
    payload.source === 'listed' ? LISTED_DURATION_SEC : FRONTED_DURATION_SEC
  );
  if (payload.recoveryConfirmed !== true || payload.identityDisclosureConsent !== true) {
    throw new CommunityPurchaseError(
      'required-confirmation',
      'Recovery and public identity disclosure must be confirmed.'
    );
  }
}

function validateReservePayload(payload: ReserveUnitsPayloadV1, now: number): void {
  if (
    payload.protocol !== COMMUNITY_PURCHASES_PROTOCOL ||
    payload.version !== 1 ||
    payload.network !== 'mainnet' ||
    payload.action !== 'reserve-units' ||
    payload.termsVersion !== COMMUNITY_PURCHASES_TERMS_VERSION
  ) {
    throw new CommunityPurchaseError(
      'unsupported-contract',
      'Use the current mainnet Community Purchases terms.'
    );
  }
  validateCommonEnrollment(payload.enrollment, payload.campaignId, payload.ownerId);
  if (payload.requestedUnits < 1 || payload.requestedUnits > COMMUNITY_PURCHASES_IDENTITY_CAP) {
    throw new CommunityPurchaseError(
      'identity-unit-limit',
      'One recognized identity may reserve 1 to 20 units.'
    );
  }
  if (
    payload.recoveryConfirmed !== true ||
    payload.noAlternateIdentityAttestation !== true ||
    payload.identityDisclosureConsent !== true
  ) {
    throw new CommunityPurchaseError(
      'required-confirmation',
      'Complete the recovery, identity, and no-alternate-identity confirmations.'
    );
  }
  validateActionExpiry(payload.expiresAt, now, ACTION_WINDOW_SEC);
}

function validateReadinessPayload(payload: ConfirmReadinessPayloadV1, now: number): void {
  if (
    payload.protocol !== COMMUNITY_PURCHASES_PROTOCOL ||
    payload.version !== 1 ||
    payload.network !== 'mainnet' ||
    payload.action !== 'confirm-readiness' ||
    !IDENTIFIER.test(payload.campaignId) ||
    !IDENTIFIER.test(payload.ownerId)
  ) {
    throw new CommunityPurchaseError('unsupported-contract', 'The readiness receipt is invalid.');
  }
  if (payload.fundingOutpoints.length === 0 || payload.fundingOutpoints.length > 100) {
    throw new CommunityPurchaseError(
      'funding-outpoints-required',
      'Select the cardinal funding inputs in Drey first.'
    );
  }
  if (
    new Set(payload.fundingOutpoints).size !== payload.fundingOutpoints.length ||
    payload.fundingOutpoints.some(value => !OUTPOINT.test(value))
  ) {
    throw new CommunityPurchaseError(
      'invalid-funding-outpoints',
      'Funding input commitments must be unique Bitcoin outpoints.'
    );
  }
  validateActionExpiry(payload.expiresAt, now, ACTION_WINDOW_SEC);
}

function validateCommonEnrollment(
  enrollment: CommunityEnrollmentV1,
  campaignId: string,
  ownerId: string
): void {
  if (
    enrollment.version !== 1 ||
    enrollment.network !== 'mainnet' ||
    enrollment.campaignId !== campaignId ||
    enrollment.ownerId !== ownerId ||
    enrollment.campaignRoot.version !== 1 ||
    enrollment.campaignRoot.originPath !== 'm' ||
    !HEX_8.test(enrollment.campaignRoot.masterFingerprintHex) ||
    !XPUB.test(enrollment.campaignRoot.campaignXpub)
  ) {
    throw new CommunityPurchaseError(
      'invalid-enrollment',
      'Paste the complete matching Drey Community Vault enrollment package.'
    );
  }
}

function validateActionExpiry(expiresAt: number, now: number, maximumWindow: number): void {
  if (!Number.isInteger(expiresAt) || expiresAt <= now || expiresAt > now + maximumWindow) {
    throw new CommunityPurchaseError('invalid-expiry', 'The signed request expiry is invalid.');
  }
}

function campaignRow(db: ReturnType<typeof getDb>, id: string): CampaignRow | null {
  return (
    (db.prepare(`SELECT * FROM community_campaigns WHERE id = ?`).get(id) as
      | CampaignRow
      | undefined) ?? null
  );
}

function recognizedIdentity(db: ReturnType<typeof getDb>, walletAddress: string) {
  const row = db
    .prepare(
      `SELECT wl.matrica_user_id, mu.username
       FROM wallet_links wl LEFT JOIN matrica_users mu ON mu.user_id = wl.matrica_user_id
       WHERE wl.wallet_addr = ?`
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
  inscriptionNumber: number | null,
  snapshotAt: number
): boolean {
  if (wallets.length === 0) return false;
  const row = db
    .prepare(
      `SELECT 1 FROM inscriptions
       WHERE collection_slug = 'omb'
         AND current_owner IN (SELECT value FROM json_each(?))
         AND COALESCE(active_loan_count, 0) = 0
         AND (? IS NULL OR inscription_number = ?)
         AND COALESCE(last_movement_at, inscribe_at, 0) <= ?
       LIMIT 1`
    )
    .get(JSON.stringify(wallets), inscriptionNumber, inscriptionNumber, snapshotAt);
  return !!row;
}

function inferredIdentityLinks(db: ReturnType<typeof getDb>, walletAddress: string) {
  const rows = db
    .prepare(
      `SELECT CASE WHEN addr_a = ? THEN addr_b ELSE addr_a END AS wallet, confidence
       FROM wallet_cluster_edges
       WHERE (addr_a = ? OR addr_b = ?) AND confidence >= 8000
       ORDER BY confidence DESC, wallet ASC LIMIT 20`
    )
    .all(walletAddress, walletAddress, walletAddress) as Array<{
    wallet: string;
    confidence: number;
  }>;
  return rows;
}

function parseInferredLinks(raw: string): Array<{ wallet: string; confidence: number }> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is { wallet: string; confidence: number } =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as { wallet?: unknown }).wallet === 'string' &&
        typeof (item as { confidence?: unknown }).confidence === 'number'
    );
  } catch {
    return [];
  }
}

function assignUnits(
  db: ReturnType<typeof getDb>,
  campaignId: string,
  participantId: number,
  count: number
): void {
  const used = new Set(
    (
      db
        .prepare(`SELECT unit_number FROM community_units WHERE campaign_id = ?`)
        .all(campaignId) as Array<{ unit_number: number }>
    ).map(row => row.unit_number)
  );
  const insert = db.prepare(
    `INSERT INTO community_units (campaign_id, unit_number, participant_id) VALUES (?, ?, ?)`
  );
  let remaining = count;
  for (let unit = 0; unit < COMMUNITY_PURCHASES_UNIT_COUNT && remaining > 0; unit++) {
    if (used.has(unit)) continue;
    insert.run(campaignId, unit, participantId);
    remaining--;
  }
  if (remaining !== 0)
    throw new CommunityPurchaseError(
      'unit-allocation-failed',
      'Not enough campaign units remain.',
      409
    );
}

function countAllocated(db: ReturnType<typeof getDb>, campaignId: string): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM community_units WHERE campaign_id = ?`)
      .get(campaignId) as { n: number }
  ).n;
}

function countParticipantUnits(db: ReturnType<typeof getDb>, participantId: number): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM community_units WHERE participant_id = ?`)
      .get(participantId) as { n: number }
  ).n;
}

function bumpCapTableVersion(db: ReturnType<typeof getDb>, campaignId: string, now: number): void {
  db.prepare(
    `UPDATE community_campaigns SET cap_table_version = cap_table_version + 1,
       cap_table_hash = NULL, policy_id = NULL, vault_address = NULL, policy_json = NULL, updated_at = ?
     WHERE id = ?`
  ).run(now, campaignId);
}

function startReadiness(db: ReturnType<typeof getDb>, campaign: CampaignRow, now: number): void {
  const seconds = campaign.source === 'listed' ? LISTED_READINESS_SEC : FRONTED_READINESS_SEC;
  db.prepare(
    `UPDATE community_campaigns SET status = 'readiness', readiness_started_at = ?,
       readiness_deadline = ?, updated_at = ? WHERE id = ?`
  ).run(now, Math.min(campaign.expires_at, now + seconds), now, campaign.id);
  db.prepare(
    `UPDATE community_participants SET readiness_status = 'waiting', readiness_payload_json = NULL,
       readiness_signature = NULL, readiness_nonce = NULL, funding_outpoints_json = NULL, ready_at = NULL
     WHERE campaign_id = ? AND EXISTS (SELECT 1 FROM community_units u WHERE u.participant_id = community_participants.id)`
  ).run(campaign.id);
  recordEvent(
    db,
    campaign.id,
    'readiness-started',
    null,
    { deadline: Math.min(campaign.expires_at, now + seconds) },
    now
  );
}

function reconcileCampaign(db: ReturnType<typeof getDb>, campaignId: string, now: number): void {
  const campaign = campaignRow(db, campaignId);
  if (!campaign || !['open', 'readiness'].includes(campaign.status)) return;
  if (!sourceStillValid(db, campaign)) {
    db.prepare(`UPDATE community_campaigns SET status = 'failed', updated_at = ? WHERE id = ?`).run(
      now,
      campaignId
    );
    recordEvent(db, campaignId, 'source-invalidated', null, {}, now);
    return;
  }
  if (now >= campaign.expires_at) {
    db.prepare(
      `UPDATE community_campaigns SET status = 'expired', updated_at = ? WHERE id = ?`
    ).run(now, campaignId);
    recordEvent(db, campaignId, 'campaign-expired', null, {}, now);
    return;
  }
  if (
    campaign.status !== 'readiness' ||
    !campaign.readiness_deadline ||
    now < campaign.readiness_deadline
  )
    return;
  const tx = db.transaction(() => {
    const waiting = db
      .prepare(
        `SELECT p.* FROM community_participants p
         WHERE p.campaign_id = ? AND p.readiness_status != 'ready'
           AND EXISTS (SELECT 1 FROM community_units u WHERE u.participant_id = p.id)`
      )
      .all(campaignId) as ParticipantRow[];
    if (waiting.some(row => row.is_creator === 1)) {
      db.prepare(
        `UPDATE community_campaigns SET status = 'failed', updated_at = ? WHERE id = ?`
      ).run(now, campaignId);
      recordEvent(db, campaignId, 'creator-readiness-timeout', campaign.creator_owner_id, {}, now);
      return;
    }
    for (const row of waiting) {
      db.prepare(`DELETE FROM community_units WHERE participant_id = ?`).run(row.id);
      db.prepare(
        `UPDATE community_participants SET readiness_status = 'timed-out' WHERE id = ?`
      ).run(row.id);
      recordEvent(db, campaignId, 'readiness-timeout', row.owner_id, {}, now);
    }
    const waitlisted = db
      .prepare(
        `SELECT * FROM community_participants
         WHERE campaign_id = ? AND waitlisted_units > 0 AND readiness_status != 'timed-out'
         ORDER BY joined_at, id`
      )
      .all(campaignId) as ParticipantRow[];
    for (const row of waitlisted) {
      const free = COMMUNITY_PURCHASES_UNIT_COUNT - countAllocated(db, campaignId);
      if (free <= 0) break;
      const promoted = Math.min(free, row.waitlisted_units);
      assignUnits(db, campaignId, row.id, promoted);
      db.prepare(
        `UPDATE community_participants SET waitlisted_units = waitlisted_units - ?, readiness_status = 'waiting' WHERE id = ?`
      ).run(promoted, row.id);
      recordEvent(db, campaignId, 'waitlist-promoted', row.owner_id, { units: promoted }, now);
    }
    bumpCapTableVersion(db, campaignId, now);
    const refreshed = campaignRow(db, campaignId)!;
    if (countAllocated(db, campaignId) === COMMUNITY_PURCHASES_UNIT_COUNT) {
      startReadiness(db, refreshed, now);
    } else {
      db.prepare(
        `UPDATE community_campaigns SET status = 'open', readiness_started_at = NULL,
           readiness_deadline = NULL, updated_at = ? WHERE id = ?`
      ).run(now, campaignId);
    }
  });
  tx();
}

function sourceStillValid(db: ReturnType<typeof getDb>, campaign: CampaignRow): boolean {
  const inscription = db
    .prepare(
      `SELECT inscription_id, current_output, current_owner, active_loan_count FROM inscriptions WHERE inscription_number = ?`
    )
    .get(campaign.inscription_number) as
    | {
        inscription_id: string | null;
        current_output: string | null;
        current_owner: string | null;
        active_loan_count: number;
      }
    | undefined;
  if (
    !inscription ||
    inscription.inscription_id !== campaign.inscription_id ||
    inscription.current_output !== campaign.current_outpoint ||
    inscription.active_loan_count > 0
  ) {
    return false;
  }
  if (campaign.source === 'creator-fronted') return true;
  const listing = db
    .prepare(
      `SELECT price_sats, seller FROM active_listings
       WHERE inscription_number = ? AND marketplace = ? AND satflow_id = ?`
    )
    .get(campaign.inscription_number, campaign.marketplace, campaign.listing_id) as
    | { price_sats: number; seller: string | null }
    | undefined;
  if (!listing) return false;
  return (
    sha256(
      JSON.stringify({
        inscriptionId: campaign.inscription_id,
        outpoint: campaign.current_outpoint,
        marketplace: campaign.marketplace,
        listingId: campaign.listing_id,
        priceSats: listing.price_sats,
        seller: listing.seller,
      })
    ) === campaign.source_fingerprint
  );
}

function freezeCampaign(db: ReturnType<typeof getDb>, campaignId: string, now: number): void {
  const campaign = campaignRow(db, campaignId);
  if (!campaign || countAllocated(db, campaignId) !== COMMUNITY_PURCHASES_UNIT_COUNT) {
    throw new CommunityPurchaseError(
      'cap-table-incomplete',
      'All 100 units must be assigned before freeze.',
      409
    );
  }
  const participants = db
    .prepare(
      `SELECT p.* FROM community_participants p
       WHERE p.campaign_id = ? AND EXISTS (SELECT 1 FROM community_units u WHERE u.participant_id = p.id)
       ORDER BY p.cap_table_order, p.id`
    )
    .all(campaignId) as ParticipantRow[];
  const owners: CommunityVaultOwnerInputV1[] = participants.map((row, index) => {
    db.prepare(`UPDATE community_participants SET cap_table_order = ? WHERE id = ?`).run(
      index,
      row.id
    );
    const units = (
      db
        .prepare(
          `SELECT unit_number FROM community_units WHERE participant_id = ? ORDER BY unit_number`
        )
        .all(row.id) as Array<{ unit_number: number }>
    ).map(item => item.unit_number);
    return {
      ownerId: row.owner_id,
      capTableOrder: index,
      identityCommitmentHex: sha256(`omb-community-identity-v1\0${row.identity_key}`),
      payoutAddress: row.payout_address,
      payoutScriptPubKeyHex: row.payout_script_pubkey_hex,
      campaignRoot: {
        version: 1,
        masterFingerprintHex: row.root_fingerprint_hex,
        originPath: 'm',
        campaignXpub: row.campaign_xpub,
      },
      units,
    };
  });
  const match = OUTPOINT.exec(campaign.current_outpoint);
  if (!match)
    throw new CommunityPurchaseError(
      'invalid-outpoint',
      'The indexed OMB outpoint is invalid.',
      409
    );
  installPublicPolicyCrypto();
  const policy: CommunityVaultPolicyV1 = createCommunityVaultPolicy({
    version: 1,
    policyVersion: 1,
    network: 'mainnet',
    campaignId: campaign.id,
    inscriptionId: campaign.inscription_id,
    currentOutpoint: { txid: match[1], vout: Number(match[2]) },
    mode: campaign.ownership_mode,
    eligibility: campaign.eligibility_mode,
    creatorOwnerId: campaign.creator_owner_id,
    termsVersion: campaign.terms_version,
    capTableVersion: campaign.cap_table_version,
    owners,
  });
  db.prepare(
    `UPDATE community_campaigns SET status = 'frozen', frozen_at = ?, cap_table_hash = ?,
       policy_id = ?, vault_address = ?, policy_json = ?, updated_at = ? WHERE id = ?`
  ).run(
    now,
    policy.capTableHash,
    policy.policyId,
    policy.address,
    JSON.stringify(policy),
    now,
    campaign.id
  );
  recordEvent(
    db,
    campaign.id,
    'cap-table-frozen',
    null,
    {
      capTableHash: policy.capTableHash,
      policyId: policy.policyId,
      vaultAddress: policy.address,
    },
    now
  );
}

function recordEvent(
  db: ReturnType<typeof getDb>,
  campaignId: string,
  eventType: string,
  ownerId: string | null,
  detail: unknown,
  now: number
): void {
  db.prepare(
    `INSERT INTO community_campaign_events (campaign_id, event_type, owner_id, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(campaignId, eventType, ownerId, JSON.stringify(detail), now);
}

function deriveBuyerDebit(
  transaction: RawTx,
  paymentAddress: string | null,
  ordinalsAddress: string
): number {
  if (!paymentAddress)
    throw new CommunityPurchaseError(
      'payment-address-missing',
      'The confirmed purchase has no payment address.'
    );
  const inputSats = transaction.vin.reduce((sum, input) => {
    const addr =
      input.prevout?.scriptPubKey?.address ?? input.prevout?.scriptPubKey?.addresses?.[0];
    return addr === paymentAddress ? sum + btcToSats(input.prevout?.value ?? 0) : sum;
  }, 0);
  const cleanChangeSats = transaction.vout.reduce((sum, output) => {
    const addr = output.scriptPubKey?.address ?? output.scriptPubKey?.addresses?.[0];
    // The OMB/postage output intentionally remains part of landed cost.
    return addr === paymentAddress && addr !== ordinalsAddress
      ? sum + btcToSats(output.value)
      : sum;
  }, 0);
  const debit = inputSats - cleanChangeSats;
  if (!Number.isSafeInteger(debit) || debit <= 0) {
    throw new CommunityPurchaseError(
      'fronted-cost-invalid',
      'The confirmed purchase debit is invalid.'
    );
  }
  return debit;
}

function btcToSats(value: number): number {
  return Math.round(value * 100_000_000);
}

function mainnetScript(value: string): string {
  try {
    return address.toOutputScript(value, networks.bitcoin).toString('hex');
  } catch {
    throw new CommunityPurchaseError(
      'invalid-payout-address',
      'Use a valid Bitcoin mainnet payout address.'
    );
  }
}

function parseSats(value: string, label: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new CommunityPurchaseError('invalid-amount', `The ${label} must be whole sats.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CommunityPurchaseError('invalid-amount', `The ${label} is out of range.`);
  }
  return parsed;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}
