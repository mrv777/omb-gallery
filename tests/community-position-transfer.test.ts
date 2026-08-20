import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { address, networks } from 'bitcoinjs-lib';
import { Signer } from 'bip322-js';
import communityVector from '@drey/core/vectors/community-vault-v1.json';
import { HDKey } from '@scure/bip32';
import { p2wpkh, NETWORK, SigHash, Transaction } from '@scure/btc-signer';
import { createCommunityVaultPolicy } from '@drey/core/domain/community-vault/policy';
import {
  approveCommunityVaultSpend,
  finalizeCommunityVaultPsbt,
  validateCommunityVaultPsbt,
} from '@drey/core/domain/community-vault/psbt';
import type {
  CommunityVaultOwnerInputV1,
  CommunityVaultPolicyV1,
} from '@drey/core/domain/community-vault/contracts';
import { getCryptoProvider } from '@drey/core/domain/vault/crypto-provider';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@drey/core/domain/vault/encoding';
import { installPublicPolicyCrypto } from '@/lib/community-purchases/dreyCrypto';
import {
  positionTransferSellerAuthorizationPayload,
  positionTransferSellerMessage,
  buildValidatedPositionTransferPlan,
  type PositionTransferSellerAuthorizationV1,
} from '@/lib/community-purchases/positionTransfer';

const NOW_MS = 1_800_000_000_000n;
const currentPolicy = communityVector.policy as CommunityVaultPolicyV1;

beforeAll(() => installPublicPolicyCrypto());

describe('private whole-position transfer', () => {
  it('atomically replaces one complete position, preserves the OMB output, and makes the buyer pay the fee', () => {
    const buyer = buyerFixture();
    const prepared = buildValidatedPositionTransferPlan(
      draft({
        buyer,
        sellerOwnerId: 'owner-5',
        sellerPriceSats: '500000',
        feeSats: '1000',
        buyerInputSats: '521000',
        buyerChangeSats: '20000',
        buyerChangeAddress: buyer.payoutAddress,
      })
    );

    expect(prepared.transferredUnits).toEqual(currentPolicy.owners[5]!.units);
    expect(prepared.nextPolicy.capTableVersion).toBe(currentPolicy.capTableVersion + 1);
    expect(prepared.nextPolicy.owners.map(owner => owner.ownerId)).toEqual(
      currentPolicy.owners.map(owner =>
        owner.ownerId === 'owner-5' ? buyer.ownerId : owner.ownerId
      )
    );
    expect(prepared.nextPolicy.owners[5]!.units).toEqual(currentPolicy.owners[5]!.units);
    expect(prepared.plan.kind).toBe('rotation');
    expect(prepared.plan.outputs[0]).toEqual({
      valueSats: '10000',
      scriptPubKeyHex: prepared.nextPolicy.scriptPubKeyHex,
    });
    expect(prepared.plan.outputs[1]).toEqual({
      valueSats: '500000',
      scriptPubKeyHex: currentPolicy.owners[5]!.payoutScriptPubKeyHex,
    });
    expect(prepared.plan.feeSats).toBe('1000');
    expect(prepared.plan.ordinalRoute).toMatchObject({ inputIndex: 0, outputIndex: 0 });
    expect(prepared.signingPsbtHex).toMatch(/^[0-9a-f]+$/u);

    let signedPsbt = fundBuyerInput(prepared.signingPsbtHex, currentPolicy.campaignId);
    for (let ownerIndex = 0; ownerIndex < 4; ownerIndex++) {
      signedPsbt = approveOwner(prepared, signedPsbt, ownerIndex);
    }
    expect(
      validateCommunityVaultPsbt(currentPolicy, prepared.plan, signedPsbt).signedUnits
    ).toHaveLength(68);
    expect(() => finalizeCommunityVaultPsbt(currentPolicy, prepared.plan, signedPsbt)).toThrow(
      /at least 69/i
    );

    signedPsbt = approveOwner(prepared, signedPsbt, 4);
    const finalized = finalizeCommunityVaultPsbt(currentPolicy, prepared.plan, signedPsbt);
    expect(finalized.signedUnits).toHaveLength(69);
    expect(finalized.transactionHex).toMatch(/^[0-9a-f]+$/u);
  });

  it('does not offer splitting or merging positions', () => {
    const buyer = buyerFixture();
    const prepared = buildValidatedPositionTransferPlan(draft({ buyer, sellerOwnerId: 'owner-5' }));
    expect(prepared.transferredUnits).toHaveLength(11);
    expect(
      prepared.nextPolicy.owners.find(owner => owner.ownerId === buyer.ownerId)?.units
    ).toEqual(currentPolicy.owners.find(owner => owner.ownerId === 'owner-5')?.units);

    expect(() =>
      buildValidatedPositionTransferPlan(
        draft({ buyer: buyerForExistingOwner('owner-4'), sellerOwnerId: 'owner-5' })
      )
    ).toThrow(/already owns/i);
  });

  it('rejects underfunding, mismatched recovery setup, and invitations longer than 24 hours', () => {
    const buyer = buyerFixture();
    expect(() =>
      buildValidatedPositionTransferPlan(draft({ buyer, buyerInputSats: '500999' }))
    ).toThrow(/exactly cover/i);
    const invalidSellerSignature = draft({ buyer });
    expect(() =>
      buildValidatedPositionTransferPlan({
        ...invalidSellerSignature,
        sellerAuthorization: {
          ...invalidSellerSignature.sellerAuthorization,
          signature: 'invalid',
        },
      })
    ).toThrow(/seller authorization signature/i);
    const changedAfterAuthorization = draft({ buyer });
    expect(() =>
      buildValidatedPositionTransferPlan({
        ...changedAfterAuthorization,
        sellerPriceSats: '500001',
      })
    ).toThrow(/does not match the exact position transfer/i);
    expect(() =>
      buildValidatedPositionTransferPlan(
        draft({
          buyer: {
            ...buyer,
            enrollment: { ...buyer.enrollment, campaignId: 'another-campaign' },
          },
        })
      )
    ).toThrow(/does not match/i);
    expect(() =>
      buildValidatedPositionTransferPlan(
        draft({ buyer, expiresAtMs: (NOW_MS + 24n * 60n * 60n * 1000n + 1n).toString() })
      )
    ).toThrow(/within 24 hours/i);
    expect(() =>
      buildValidatedPositionTransferPlan(
        draft({ currentPolicy: holderOnlyPolicy(), buyer, sellerOwnerId: 'owner-5' })
      )
    ).toThrow(/qualifying OMB/i);
  });

  it('keeps the 33-unit anchored creator permanent', () => {
    const anchored = anchoredPolicy();
    expect(() =>
      buildValidatedPositionTransferPlan(
        draft({
          currentPolicy: anchored,
          buyer: buyerFixture(anchored.campaignId),
          sellerOwnerId: 'owner-0',
        })
      )
    ).toThrow(/anchored creator/i);
  });
});

type DraftOverrides = Partial<Parameters<typeof buildValidatedPositionTransferPlan>[0]> & {
  buyer: Parameters<typeof buildValidatedPositionTransferPlan>[0]['buyer'];
  buyerInputSats?: string;
};

function draft(
  overrides: DraftOverrides
): Parameters<typeof buildValidatedPositionTransferPlan>[0] {
  const policy = overrides.currentPolicy ?? currentPolicy;
  const sellerOwnerId = overrides.sellerOwnerId ?? 'owner-5';
  const sellerPriceSats = overrides.sellerPriceSats ?? '500000';
  const feeSats = overrides.feeSats ?? '1000';
  const buyerInputSats =
    overrides.buyerInputSats ?? (BigInt(sellerPriceSats) + BigInt(feeSats)).toString();
  const base = {
    transferId: 'position-transfer-1',
    currentPolicy: policy,
    currentVault: {
      txid: '99'.repeat(32),
      vout: 0,
      valueSats: '10000',
      inscriptionOffsetSats: '0',
      postageSats: '546',
    },
    sellerOwnerId,
    buyer: overrides.buyer,
    buyerInputs: [
      {
        txid: '88'.repeat(32),
        vout: 1,
        valueSats: buyerInputSats,
        scriptPubKeyHex: address
          .toOutputScript(overrides.buyer.payoutAddress, networks.bitcoin)
          .toString('hex'),
        sequence: 0xffff_fffd,
      },
    ],
    buyerChangeAddress: overrides.buyerChangeAddress ?? null,
    buyerChangeSats: overrides.buyerChangeSats ?? '0',
    sellerPriceSats,
    feeSats,
    createdAtMs: NOW_MS.toString(),
    expiresAtMs: overrides.expiresAtMs ?? (NOW_MS + 60n * 60n * 1000n).toString(),
  };
  const payload = positionTransferSellerAuthorizationPayload({
    transferId: base.transferId,
    currentPolicy: base.currentPolicy,
    currentVault: base.currentVault,
    sellerOwnerId: base.sellerOwnerId,
    buyer: base.buyer,
    sellerPriceSats: base.sellerPriceSats,
    expiresAtMs: base.expiresAtMs,
    nonce: 'cd'.repeat(16),
  });
  return {
    ...base,
    sellerAuthorization: {
      payload,
      signature: signSellerAuthorization(policy, payload),
    },
  };
}

function buyerFixture(campaignId = currentPolicy.campaignId) {
  const root = buyerRoot(campaignId);
  const payoutKey = root.deriveChild(1000);
  if (!payoutKey.publicKey) throw new Error('buyer payout key unavailable');
  const payoutAddress = p2wpkh(payoutKey.publicKey, NETWORK).address;
  if (!payoutAddress) throw new Error('buyer payout address unavailable');
  payoutKey.wipePrivateData();
  const ownerId = 'buyer-new';
  const buyer = {
    ownerId,
    identityCommitmentHex: 'ab'.repeat(32),
    payoutAddress,
    qualifyingInscriptionNumber: null,
    enrollment: {
      version: 1 as const,
      network: 'mainnet' as const,
      campaignId,
      ownerId,
      campaignRoot: {
        version: 1 as const,
        masterFingerprintHex: root.fingerprint.toString(16).padStart(8, '0'),
        originPath: 'm' as const,
        campaignXpub: root.publicExtendedKey,
      },
    },
  };
  root.wipePrivateData();
  return buyer;
}

function buyerForExistingOwner(ownerId: string) {
  const buyer = buyerFixture();
  return { ...buyer, ownerId, enrollment: { ...buyer.enrollment, ownerId } };
}

function anchoredPolicy(): CommunityVaultPolicyV1 {
  const allocations = [33, 20, 20, 20, 7];
  let unit = 0;
  const owners: CommunityVaultOwnerInputV1[] = allocations.map((count, index) => {
    const source = currentPolicy.owners[index]!;
    const units = Array.from({ length: count }, () => unit++);
    return {
      ownerId: source.ownerId,
      capTableOrder: index,
      identityCommitmentHex: source.identityCommitmentHex,
      payoutAddress: source.payoutAddress,
      payoutScriptPubKeyHex: source.payoutScriptPubKeyHex,
      campaignRoot: { ...source.campaignRoot },
      units,
    };
  });
  return createCommunityVaultPolicy({
    version: 1,
    policyVersion: 1,
    network: 'mainnet',
    campaignId: 'fixture-anchored-transfer',
    inscriptionId: currentPolicy.inscriptionId,
    currentOutpoint: { ...currentPolicy.currentOutpoint },
    mode: 'anchored',
    eligibility: 'anyone',
    creatorOwnerId: 'owner-0',
    termsVersion: currentPolicy.termsVersion,
    capTableVersion: 1,
    owners,
  });
}

function holderOnlyPolicy(): CommunityVaultPolicyV1 {
  return createCommunityVaultPolicy({
    version: 1,
    policyVersion: 1,
    network: 'mainnet',
    campaignId: currentPolicy.campaignId,
    inscriptionId: currentPolicy.inscriptionId,
    currentOutpoint: { ...currentPolicy.currentOutpoint },
    mode: currentPolicy.mode,
    eligibility: 'omb-holders-only',
    creatorOwnerId: currentPolicy.creatorOwnerId,
    termsVersion: currentPolicy.termsVersion,
    capTableVersion: currentPolicy.capTableVersion,
    owners: currentPolicy.owners.map(owner => ({
      ...owner,
      campaignRoot: { ...owner.campaignRoot },
      units: [...owner.units],
    })),
  });
}

function fundBuyerInput(psbtHex: string, campaignId: string): string {
  const root = buyerRoot(campaignId);
  const payment = root.deriveChild(1000);
  try {
    if (!payment.privateKey) throw new Error('buyer payment key unavailable');
    const tx = Transaction.fromPSBT(hexToBytes(psbtHex), { PSBTVersion: 0, lowR: true });
    tx.updateInput(1, { sighashType: SigHash.ALL }, true);
    tx.signIdx(payment.privateKey, 1, [SigHash.ALL]);
    tx.finalizeIdx(1);
    return bytesToHex(tx.toPSBT(0));
  } finally {
    payment.wipePrivateData();
    root.wipePrivateData();
  }
}

function approveOwner(
  prepared: ReturnType<typeof buildValidatedPositionTransferPlan>,
  psbtHex: string,
  ownerIndex: number
): string {
  const root = HDKey.fromMasterSeed(
    getCryptoProvider().sha256(utf8ToBytes(`drey-community-vault-v1-owner-${ownerIndex}`))
  );
  try {
    return approveCommunityVaultSpend({
      policy: prepared.previousPolicy,
      plan: prepared.plan,
      psbtHex,
      ownerId: `owner-${ownerIndex}`,
      signerRoot: root,
      nowMs: (NOW_MS + 1n).toString(),
      random: length => new Uint8Array(length).fill(ownerIndex + 1),
    }).psbtHex;
  } finally {
    root.wipePrivateData();
  }
}

function buyerRoot(campaignId: string): HDKey {
  return HDKey.fromMasterSeed(
    getCryptoProvider().sha256(utf8ToBytes(`position-transfer-buyer-${campaignId}`))
  );
}

function signSellerAuthorization(
  policy: CommunityVaultPolicyV1,
  payload: PositionTransferSellerAuthorizationV1
): string {
  const ownerIndex = Number(payload.sellerOwnerId.replace('owner-', ''));
  const owner = policy.owners.find(candidate => candidate.ownerId === payload.sellerOwnerId);
  if (!owner || !Number.isInteger(ownerIndex)) throw new Error('seller fixture unavailable');
  const root = HDKey.fromMasterSeed(
    getCryptoProvider().sha256(utf8ToBytes(`drey-community-vault-v1-owner-${ownerIndex}`))
  );
  const payoutKey = root.deriveChild(1000 + ownerIndex);
  try {
    if (!payoutKey.privateKey) throw new Error('seller payout key unavailable');
    return Signer.sign(
      privateKeyToWif(payoutKey.privateKey),
      owner.payoutAddress,
      positionTransferSellerMessage(payload)
    );
  } finally {
    payoutKey.wipePrivateData();
    root.wipePrivateData();
  }
}

function privateKeyToWif(privateKey: Uint8Array): string {
  const payload = Buffer.concat([
    Buffer.from([0x80]),
    Buffer.from(privateKey),
    Buffer.from([0x01]),
  ]);
  const first = createHash('sha256').update(payload).digest();
  const checksum = createHash('sha256').update(first).digest().subarray(0, 4);
  return base58Encode(Buffer.concat([payload, checksum]));
}

function base58Encode(value: Uint8Array): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let number = BigInt(`0x${Buffer.from(value).toString('hex')}`);
  let encoded = '';
  while (number > 0n) {
    encoded = alphabet[Number(number % 58n)] + encoded;
    number /= 58n;
  }
  for (const byte of value) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded;
}
