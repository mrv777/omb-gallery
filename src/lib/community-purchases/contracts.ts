import type { CommunityVaultAcquisitionProviderContextV1 } from '@drey/core/domain/community-vault/acquisition-provider';
import type { CommunityVaultPolicyV1 } from '@drey/core/domain/community-vault/contracts';
import type {
  CommunityVaultSalePlanV1,
  CommunityVaultSalePreflightV1,
} from '@drey/core/domain/community-vault/sale-contracts';
import type {
  CommunityVaultSaleBuyerProviderContextV1,
  CommunityVaultSaleProviderContextV1,
} from '@drey/core/domain/community-vault/sale-provider';

export const COMMUNITY_PURCHASES_TERMS_VERSION = 'omb-community-purchases-2026-08-18' as const;
export const COMMUNITY_PURCHASES_PROTOCOL = 'omb-community-purchases' as const;
export const COMMUNITY_PURCHASES_SCHEMA_VERSION = 1 as const;
export const COMMUNITY_PURCHASES_UNIT_COUNT = 100 as const;
export const COMMUNITY_PURCHASES_THRESHOLD = 69 as const;
export const COMMUNITY_PURCHASES_IDENTITY_CAP = 20 as const;
export const ANCHORED_CREATOR_UNITS = 33 as const;

export type CommunityCampaignSource = 'listed' | 'creator-fronted';
export type CommunityOwnershipMode = 'anchored' | 'open';
export type CommunityEligibilityMode = 'anyone' | 'omb-holders-only';
export type CommunityCampaignStatus =
  | 'open'
  | 'readiness'
  | 'frozen'
  | 'signing'
  | 'broadcast'
  | 'held'
  | 'expired'
  | 'failed'
  | 'sold';

export type CommunityEnrollmentV1 = {
  version: 1;
  network: 'mainnet';
  campaignId: string;
  ownerId: string;
  campaignRoot: {
    version: 1;
    masterFingerprintHex: string;
    originPath: 'm';
    campaignXpub: string;
  };
};

export type CreateCampaignPayloadV1 = {
  protocol: typeof COMMUNITY_PURCHASES_PROTOCOL;
  version: 1;
  network: 'mainnet';
  action: 'create-campaign';
  campaignId: string;
  creatorOwnerId: string;
  inscriptionNumber: number;
  source: CommunityCampaignSource;
  ownershipMode: CommunityOwnershipMode;
  eligibilityMode: CommunityEligibilityMode;
  creatorUnits: number;
  maxLandedCostSats: string;
  listingId: string | null;
  marketplace: string | null;
  frontedBuyIntentId: number | null;
  payoutAddress: string;
  enrollment: CommunityEnrollmentV1;
  recoveryConfirmed: true;
  permanentAnchorAccepted: boolean;
  identityDisclosureConsent: true;
  termsVersion: typeof COMMUNITY_PURCHASES_TERMS_VERSION;
  expiresAt: number;
  nonce: string;
};

export type ReserveUnitsPayloadV1 = {
  protocol: typeof COMMUNITY_PURCHASES_PROTOCOL;
  version: 1;
  network: 'mainnet';
  action: 'reserve-units';
  campaignId: string;
  ownerId: string;
  requestedUnits: number;
  maxContributionSats: string;
  qualifyingInscriptionNumber: number | null;
  payoutAddress: string;
  enrollment: CommunityEnrollmentV1;
  recoveryConfirmed: true;
  noAlternateIdentityAttestation: true;
  identityDisclosureConsent: true;
  termsVersion: typeof COMMUNITY_PURCHASES_TERMS_VERSION;
  capTableVersion: number;
  expiresAt: number;
  nonce: string;
};

export type ConfirmReadinessPayloadV1 = {
  protocol: typeof COMMUNITY_PURCHASES_PROTOCOL;
  version: 1;
  network: 'mainnet';
  action: 'confirm-readiness';
  campaignId: string;
  ownerId: string;
  capTableVersion: number;
  fundingOutpoints: string[];
  confirmedAt: number;
  expiresAt: number;
  nonce: string;
};

export type ApproveAcquisitionPayloadV1 = {
  protocol: typeof COMMUNITY_PURCHASES_PROTOCOL;
  version: 1;
  network: 'mainnet';
  action: 'approve-acquisition';
  campaignId: string;
  ownerId: string;
  capTableVersion: number;
  planDigest: string;
  signedPsbtHash: string;
  approvedAt: number;
  expiresAt: number;
  nonce: string;
};

export type ApproveSalePayloadV1 = {
  protocol: typeof COMMUNITY_PURCHASES_PROTOCOL;
  version: 1;
  network: 'mainnet';
  action: 'approve-sale';
  campaignId: string;
  ownerId: string;
  capTableVersion: number;
  offerDigest: string;
  signedPsbtHash: string;
  approvedAt: number;
  expiresAt: number;
  nonce: string;
};

export type CreateSaleOfferPayloadV1 = {
  protocol: typeof COMMUNITY_PURCHASES_PROTOCOL;
  version: 1;
  network: 'mainnet';
  action: 'create-sale-offer';
  campaignId: string;
  buyerId: string;
  buyerDestinationAddress: string;
  offerDigest: string;
  grossOfferSats: string;
  signedPsbtHash: string;
  offerExpiresAtMs: string;
  createdAt: number;
  expiresAt: number;
  nonce: string;
};

export type CommunityAcquisitionView = {
  status: 'signing' | 'ready' | 'expired' | 'failed';
  planDigest: string;
  context: Omit<CommunityVaultAcquisitionProviderContextV1, 'ownerId'>;
  signingPsbtBase64: string;
  signedOwnerIds: string[];
  requiredOwnerCount: number;
  expiresAtMs: string;
  txid: string | null;
};

export type CommunitySaleProviderContextV1 = Omit<CommunityVaultSaleProviderContextV1, 'ownerId'>;
export type CommunitySaleBuyerProviderContextV1 = CommunityVaultSaleBuyerProviderContextV1;

export type CommunityPreparedSaleOffer = {
  policy: CommunityVaultPolicyV1;
  plan: CommunityVaultSalePlanV1;
  preflight: CommunityVaultSalePreflightV1;
  signingPsbtBase64: string;
  buyerInputIndexes: number[];
  feeRateSatPerVb: number;
};

export type CommunitySaleView = {
  status: 'signing' | 'ready' | 'expired' | 'failed';
  offerDigest: string;
  context: CommunitySaleProviderContextV1;
  signingPsbtBase64: string;
  signedOwnerIds: string[];
  signedUnitCount: number;
  requiredUnitCount: 69;
  expiresAtMs: string;
  grossOfferSats: string;
  txid: string | null;
};

export type CommunityParticipantView = {
  ownerId: string;
  capTableOrder: number;
  walletAddress: string;
  payoutAddress: string;
  matricaUserId: string | null;
  matricaUsername: string | null;
  identityLabel: string;
  isCreator: boolean;
  requestedUnits: number;
  allocatedUnits: number[];
  waitlistedUnits: number;
  readiness: 'waiting' | 'ready' | 'timed-out';
  recoveryConfirmed: boolean;
  inferredLinks: Array<{ wallet: string; confidence: number }>;
  campaignRoot: CommunityEnrollmentV1['campaignRoot'];
};

export type CommunityCampaignView = {
  id: string;
  inscriptionNumber: number;
  inscriptionId: string;
  currentOutpoint: string;
  source: CommunityCampaignSource;
  ownershipMode: CommunityOwnershipMode;
  eligibilityMode: CommunityEligibilityMode;
  status: CommunityCampaignStatus;
  creatorOwnerId: string;
  landedCostSats: string;
  maxLandedCostSats: string;
  marketplace: string | null;
  listingId: string | null;
  openedAt: number;
  expiresAt: number;
  readinessDeadline: number | null;
  capTableVersion: number;
  capTableHash: string | null;
  policyId: string | null;
  vaultAddress: string | null;
  policy: unknown | null;
  allocatedUnitCount: number;
  waitlistedUnitCount: number;
  participants: CommunityParticipantView[];
  acquisition: CommunityAcquisitionView | null;
  sale: CommunitySaleView | null;
};

export function communityMessage(
  payload:
    | CreateCampaignPayloadV1
    | ReserveUnitsPayloadV1
    | ConfirmReadinessPayloadV1
    | ApproveAcquisitionPayloadV1
    | ApproveSalePayloadV1
    | CreateSaleOfferPayloadV1
): string {
  return `OMB Community Purchases\n${JSON.stringify(payload)}`;
}

export function newCampaignId(random = crypto.getRandomValues(new Uint8Array(16))): string {
  return `cp_${Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function newOwnerId(random = crypto.getRandomValues(new Uint8Array(12))): string {
  return `owner_${Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function newActionNonce(random = crypto.getRandomValues(new Uint8Array(16))): string {
  return Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('');
}
