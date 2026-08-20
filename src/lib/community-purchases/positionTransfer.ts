import 'server-only';

import { address, networks } from 'bitcoinjs-lib';
import { Verifier } from 'bip322-js';
import type {
  CommunityVaultOwnerInputV1,
  CommunityVaultPolicyV1,
  CommunityVaultSpendInputV1,
  CommunityVaultSpendPlanV1,
} from '@drey/core/domain/community-vault/contracts';
import { createCommunityVaultPolicy } from '@drey/core/domain/community-vault/policy';
import {
  constructCommunityVaultPsbt,
  createCommunityVaultSpendPlan,
  validateCommunityVaultPsbt,
} from '@drey/core/domain/community-vault/psbt';
import {
  COMMUNITY_PURCHASES_IDENTITY_CAP,
  isCommunityEnrollmentFor,
  type CommunityEnrollmentV1,
} from './contracts';
import { installPublicPolicyCrypto } from './dreyCrypto';

const MAX_TRANSFER_LIFETIME_MS = 24 * 60 * 60 * 1000;
const RBF_SEQUENCE = 0xffff_fffd;
const TXID = /^[0-9a-f]{64}$/u;
const HEX_32 = /^[0-9a-f]{64}$/u;

export type PositionTransferBuyerV1 = {
  ownerId: string;
  identityCommitmentHex: string;
  payoutAddress: string;
  enrollment: CommunityEnrollmentV1;
  qualifyingInscriptionNumber: number | null;
};

export type ValidatedPositionTransferDraftV1 = {
  transferId: string;
  currentPolicy: CommunityVaultPolicyV1;
  currentVault: {
    txid: string;
    vout: number;
    valueSats: string;
    inscriptionOffsetSats: string;
    postageSats: string;
  };
  sellerOwnerId: string;
  buyer: PositionTransferBuyerV1;
  buyerInputs: CommunityVaultSpendInputV1[];
  buyerChangeAddress: string | null;
  buyerChangeSats: string;
  sellerPriceSats: string;
  feeSats: string;
  createdAtMs: string;
  expiresAtMs: string;
  sellerAuthorization: {
    payload: PositionTransferSellerAuthorizationV1;
    signature: string;
  };
};

export type PositionTransferSellerAuthorizationV1 = {
  protocol: 'omb-community-position-transfer';
  version: 1;
  network: 'mainnet';
  action: 'authorize-whole-position-transfer';
  transferId: string;
  campaignId: string;
  policyId: string;
  capTableVersion: number;
  currentVaultOutpoint: string;
  sellerOwnerId: string;
  buyerOwnerId: string;
  buyerIdentityCommitmentHex: string;
  buyerCampaignXpub: string;
  buyerPayoutAddress: string;
  qualifyingInscriptionNumber: number | null;
  units: number[];
  sellerPriceSats: string;
  expiresAtMs: string;
  nonce: string;
};

export type PreparedPositionTransferV1 = {
  previousPolicy: CommunityVaultPolicyV1;
  nextPolicy: CommunityVaultPolicyV1;
  plan: CommunityVaultSpendPlanV1;
  signingPsbtHex: string;
  sellerOwnerId: string;
  buyerOwnerId: string;
  transferredUnits: number[];
  sellerPriceSats: string;
  feeSats: string;
  expiresAtMs: string;
  sellerAuthorization: ValidatedPositionTransferDraftV1['sellerAuthorization'];
};

/**
 * Low-level plan builder. Before calling, the coordinator must verify the live
 * vault outpoint, campaign state, buyer identity/eligibility, and absence of a
 * competing sale or rotation. The seller authorization is verified here.
 *
 * The old 69-of-100 policy approves one atomic transaction that both pays the
 * seller and moves the inscription into a new 69-of-100 policy where only that
 * seller's complete unit set has a new owner.
 */
export function buildValidatedPositionTransferPlan(
  input: ValidatedPositionTransferDraftV1
): PreparedPositionTransferV1 {
  installPublicPolicyCrypto();
  assertTransferDraft(input);

  const seller = input.currentPolicy.owners.find(owner => owner.ownerId === input.sellerOwnerId);
  if (!seller) throw new Error('Position seller is not in the current cap table');
  if (
    input.currentPolicy.mode === 'anchored' &&
    seller.ownerId === input.currentPolicy.creatorOwnerId
  ) {
    throw new Error('The anchored creator position cannot be transferred');
  }
  if (seller.units.length > COMMUNITY_PURCHASES_IDENTITY_CAP) {
    throw new Error('A transferable position cannot exceed the 20-unit identity cap');
  }
  if (input.currentPolicy.owners.some(owner => owner.ownerId === input.buyer.ownerId)) {
    throw new Error('Buyer already owns a position in this group buy');
  }
  if (
    !isCommunityEnrollmentFor(
      input.buyer.enrollment,
      input.currentPolicy.campaignId,
      input.buyer.ownerId
    )
  ) {
    throw new Error('Buyer enrollment does not match this campaign and owner');
  }
  const expectedAuthorization = positionTransferSellerAuthorizationPayload({
    transferId: input.transferId,
    currentPolicy: input.currentPolicy,
    currentVault: input.currentVault,
    sellerOwnerId: input.sellerOwnerId,
    buyer: input.buyer,
    sellerPriceSats: input.sellerPriceSats,
    expiresAtMs: input.expiresAtMs,
    nonce: input.sellerAuthorization.payload.nonce,
  });
  if (JSON.stringify(input.sellerAuthorization.payload) !== JSON.stringify(expectedAuthorization)) {
    throw new Error('Seller authorization does not match the exact position transfer');
  }
  if (
    !verifySellerAuthorization(
      seller.payoutAddress,
      expectedAuthorization,
      input.sellerAuthorization.signature
    )
  ) {
    throw new Error('Seller authorization signature is invalid');
  }

  const buyerOwner = replacementOwner(input.buyer, seller);
  const nextPolicy = createCommunityVaultPolicy({
    version: 1,
    policyVersion: 1,
    network: 'mainnet',
    campaignId: input.currentPolicy.campaignId,
    inscriptionId: input.currentPolicy.inscriptionId,
    currentOutpoint: { txid: input.currentVault.txid, vout: input.currentVault.vout },
    mode: input.currentPolicy.mode,
    eligibility: input.currentPolicy.eligibility,
    creatorOwnerId: input.currentPolicy.creatorOwnerId,
    termsVersion: input.currentPolicy.termsVersion,
    capTableVersion: input.currentPolicy.capTableVersion + 1,
    owners: input.currentPolicy.owners.map(owner =>
      owner.ownerId === seller.ownerId ? buyerOwner : cloneOwner(owner)
    ),
  });

  const vaultValue = positiveSats(input.currentVault.valueSats, 'Vault value');
  const price = positiveSats(input.sellerPriceSats, 'Seller price');
  const fee = positiveSats(input.feeSats, 'Network fee');
  const change = nonNegativeSats(input.buyerChangeSats, 'Buyer change');
  if (price < 546n) throw new Error('Seller price is below the supported dust floor');
  if (change > 0n && change < 546n)
    throw new Error('Buyer change is below the supported dust floor');
  const buyerTotal = input.buyerInputs.reduce(
    (sum, candidate) => sum + positiveSats(candidate.valueSats, 'Buyer input value'),
    0n
  );
  if (buyerTotal !== price + fee + change) {
    throw new Error('Buyer inputs must exactly cover the seller price, network fee, and change');
  }

  const outputs = [
    { valueSats: vaultValue.toString(), scriptPubKeyHex: nextPolicy.scriptPubKeyHex },
    { valueSats: price.toString(), scriptPubKeyHex: seller.payoutScriptPubKeyHex },
  ];
  if (change > 0n) {
    if (!input.buyerChangeAddress) throw new Error('Buyer change address is required');
    if (input.buyerChangeAddress !== input.buyer.payoutAddress) {
      throw new Error('Buyer change must return to the verified buyer payment address');
    }
    outputs.push({
      valueSats: change.toString(),
      scriptPubKeyHex: address
        .toOutputScript(input.buyerChangeAddress, networks.bitcoin)
        .toString('hex'),
    });
  } else if (input.buyerChangeAddress !== null) {
    throw new Error('Buyer change address must be omitted when there is no change');
  }

  const plan = createCommunityVaultSpendPlan({
    version: 1,
    policyVersion: 1,
    network: 'mainnet',
    policyId: input.currentPolicy.policyId,
    capTableHash: input.currentPolicy.capTableHash,
    capTableVersion: input.currentPolicy.capTableVersion,
    planId: input.transferId,
    kind: 'rotation',
    createdAtMs: input.createdAtMs,
    expiresAtMs: input.expiresAtMs,
    inputs: [
      {
        txid: input.currentVault.txid,
        vout: input.currentVault.vout,
        valueSats: vaultValue.toString(),
        scriptPubKeyHex: input.currentPolicy.scriptPubKeyHex,
        sequence: RBF_SEQUENCE,
      },
      ...input.buyerInputs.map(candidate => ({ ...candidate, sequence: RBF_SEQUENCE })),
    ],
    vaultInputIndex: 0,
    outputs,
    feeSats: fee.toString(),
    ordinalRoute: {
      inscriptionId: input.currentPolicy.inscriptionId,
      inputIndex: 0,
      inputOffsetSats: input.currentVault.inscriptionOffsetSats,
      outputIndex: 0,
      outputOffsetSats: input.currentVault.inscriptionOffsetSats,
      postageSats: input.currentVault.postageSats,
    },
  });
  const signingPsbtHex = constructCommunityVaultPsbt(input.currentPolicy, plan);
  validateCommunityVaultPsbt(input.currentPolicy, plan, signingPsbtHex);

  return {
    previousPolicy: input.currentPolicy,
    nextPolicy,
    plan,
    signingPsbtHex,
    sellerOwnerId: seller.ownerId,
    buyerOwnerId: buyerOwner.ownerId,
    transferredUnits: [...seller.units],
    sellerPriceSats: price.toString(),
    feeSats: fee.toString(),
    expiresAtMs: input.expiresAtMs,
    sellerAuthorization: {
      payload: {
        ...input.sellerAuthorization.payload,
        units: [...input.sellerAuthorization.payload.units],
      },
      signature: input.sellerAuthorization.signature,
    },
  };
}

export function positionTransferSellerAuthorizationPayload(input: {
  transferId: string;
  currentPolicy: CommunityVaultPolicyV1;
  currentVault: ValidatedPositionTransferDraftV1['currentVault'];
  sellerOwnerId: string;
  buyer: PositionTransferBuyerV1;
  sellerPriceSats: string;
  expiresAtMs: string;
  nonce: string;
}): PositionTransferSellerAuthorizationV1 {
  const seller = input.currentPolicy.owners.find(owner => owner.ownerId === input.sellerOwnerId);
  if (!seller) throw new Error('Position seller is not in the current cap table');
  if (!/^[0-9a-f]{32}$/u.test(input.nonce))
    throw new Error('Seller authorization nonce is invalid');
  return {
    protocol: 'omb-community-position-transfer',
    version: 1,
    network: 'mainnet',
    action: 'authorize-whole-position-transfer',
    transferId: input.transferId,
    campaignId: input.currentPolicy.campaignId,
    policyId: input.currentPolicy.policyId,
    capTableVersion: input.currentPolicy.capTableVersion,
    currentVaultOutpoint: `${input.currentVault.txid}:${input.currentVault.vout}`,
    sellerOwnerId: seller.ownerId,
    buyerOwnerId: input.buyer.ownerId,
    buyerIdentityCommitmentHex: input.buyer.identityCommitmentHex,
    buyerCampaignXpub: input.buyer.enrollment.campaignRoot.campaignXpub,
    buyerPayoutAddress: input.buyer.payoutAddress,
    qualifyingInscriptionNumber: input.buyer.qualifyingInscriptionNumber,
    units: [...seller.units],
    sellerPriceSats: input.sellerPriceSats,
    expiresAtMs: input.expiresAtMs,
    nonce: input.nonce,
  };
}

export function positionTransferSellerMessage(
  payload: PositionTransferSellerAuthorizationV1
): string {
  return `OMB Community Position Transfer\n${JSON.stringify(payload)}`;
}

function verifySellerAuthorization(
  payoutAddress: string,
  payload: PositionTransferSellerAuthorizationV1,
  signature: string
): boolean {
  try {
    return (
      signature.length > 0 &&
      Verifier.verifySignature(payoutAddress, positionTransferSellerMessage(payload), signature) ===
        true
    );
  } catch {
    return false;
  }
}

function assertTransferDraft(input: ValidatedPositionTransferDraftV1): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.transferId)) {
    throw new Error('Position transfer ID is invalid');
  }
  if (
    !TXID.test(input.currentVault.txid) ||
    !Number.isInteger(input.currentVault.vout) ||
    input.currentVault.vout < 0
  ) {
    throw new Error('Current vault outpoint is invalid');
  }
  const createdAt = nonNegativeSats(input.createdAtMs, 'Created time');
  const expiresAt = positiveSats(input.expiresAtMs, 'Expiry time');
  if (expiresAt <= createdAt || expiresAt - createdAt > BigInt(MAX_TRANSFER_LIFETIME_MS)) {
    throw new Error('A private position transfer must expire within 24 hours');
  }
  if (!HEX_32.test(input.buyer.identityCommitmentHex)) {
    throw new Error('Buyer identity commitment is invalid');
  }
  if (
    input.currentPolicy.eligibility === 'omb-holders-only' &&
    (!Number.isSafeInteger(input.buyer.qualifyingInscriptionNumber) ||
      (input.buyer.qualifyingInscriptionNumber ?? 0) <= 0)
  ) {
    throw new Error('A verified qualifying OMB is required for this buyer');
  }
  if (input.buyerInputs.length < 1) throw new Error('Buyer funding input is required');
  let buyerPaymentScript: string;
  try {
    buyerPaymentScript = address
      .toOutputScript(input.buyer.payoutAddress, networks.bitcoin)
      .toString('hex');
  } catch {
    throw new Error('Buyer payment address is invalid');
  }
  if (!/^0014[0-9a-f]{40}$/u.test(buyerPaymentScript)) {
    throw new Error('Buyer payment address must be native SegWit');
  }
  const outpoints = new Set([`${input.currentVault.txid}:${input.currentVault.vout}`]);
  for (const candidate of input.buyerInputs) {
    if (!TXID.test(candidate.txid) || !Number.isInteger(candidate.vout) || candidate.vout < 0) {
      throw new Error('Buyer funding outpoint is invalid');
    }
    if (!/^0014[0-9a-f]{40}$/u.test(candidate.scriptPubKeyHex)) {
      throw new Error('Buyer funding inputs must be native SegWit payment outputs');
    }
    if (candidate.scriptPubKeyHex !== buyerPaymentScript) {
      throw new Error('Buyer funding input does not belong to the buyer payment address');
    }
    const outpoint = `${candidate.txid}:${candidate.vout}`;
    if (outpoints.has(outpoint)) throw new Error('Position transfer inputs must be unique');
    outpoints.add(outpoint);
  }
}

function replacementOwner(
  buyer: PositionTransferBuyerV1,
  seller: CommunityVaultOwnerInputV1
): CommunityVaultOwnerInputV1 {
  const payoutScriptPubKeyHex = address
    .toOutputScript(buyer.payoutAddress, networks.bitcoin)
    .toString('hex');
  return {
    ownerId: buyer.ownerId,
    capTableOrder: seller.capTableOrder,
    identityCommitmentHex: buyer.identityCommitmentHex,
    payoutAddress: buyer.payoutAddress,
    payoutScriptPubKeyHex,
    campaignRoot: { ...buyer.enrollment.campaignRoot },
    units: [...seller.units],
  };
}

function cloneOwner(owner: CommunityVaultOwnerInputV1): CommunityVaultOwnerInputV1 {
  return {
    ...owner,
    campaignRoot: { ...owner.campaignRoot },
    units: [...owner.units],
  };
}

function positiveSats(value: string, label: string): bigint {
  const parsed = nonNegativeSats(value, label);
  if (parsed === 0n) throw new Error(`${label} must be positive`);
  return parsed;
}

function nonNegativeSats(value: string, label: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error(`${label} is invalid`);
  const parsed = BigInt(value);
  if (parsed > 0xffff_ffff_ffff_ffffn) throw new Error(`${label} is too large`);
  return parsed;
}
