import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import communityVector from '@drey/core/vectors/community-vault-v1.json';
import { HDKey } from '@scure/bip32';
import { NETWORK, SigHash, Transaction, p2wpkh } from '@scure/btc-signer';
import {
  approveCommunityVaultPositionTransfer,
  communityVaultPositionTransferSellerMessage,
  validateCommunityVaultPositionTransferPsbt,
} from '@drey/core/domain/community-vault/position-transfer';
import { signBip322Simple } from '@drey/core/domain/transactions/bip322';
import { bytesToHex } from '@drey/core/domain/vault/encoding';
import type { CommunityVaultPolicyV1 } from '@drey/core/domain/community-vault/contracts';
import {
  COMMUNITY_PURCHASES_PROTOCOL,
  type CreatePositionTransferInvitePayloadV1,
  type AcceptPositionTransferPayloadV1,
  type ApprovePositionTransferPayloadV1,
} from '../src/lib/community-purchases/contracts';
import { installPublicPolicyCrypto } from '../src/lib/community-purchases/dreyCrypto';

const NOW = 1_800_000_000;
const tempDir = path.join(os.tmpdir(), `omb-position-transfer-${process.pid}`);
const policy = communityVector.policy as CommunityVaultPolicyV1;

let dbModule: typeof import('../src/lib/db');
let campaignStore: typeof import('../src/lib/community-purchases/store');
let transferStore: typeof import('../src/lib/community-purchases/positionTransferStore');

beforeEach(async () => {
  fs.mkdirSync(tempDir, { recursive: true });
  process.env.OMB_DB_PATH = path.join(tempDir, `${Math.random().toString(36).slice(2)}.db`);
  vi.resetModules();
  dbModule = await import('../src/lib/db');
  campaignStore = await import('../src/lib/community-purchases/store');
  transferStore = await import('../src/lib/community-purchases/positionTransferStore');
  seedHeldCampaign();
});

afterEach(() => {
  delete process.env.OMB_DB_PATH;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('private whole-position transfer coordination', () => {
  it('stores only a token hash and exposes only a generic public state', () => {
    const seller = policy.owners[1]!;
    const created = transferStore.createPrivatePositionTransferInvite({
      payload: invitePayload(seller.ownerId),
      signature: 'public-create-receipt',
      walletAddress: seller.payoutAddress,
      now: NOW,
      random32: deterministicRandom(),
    });
    const row = dbModule
      .getDb()
      .prepare(
        `SELECT invite_token_hash, seller_price_sats FROM community_position_transfers WHERE id = ?`
      )
      .get(created.transferId) as { invite_token_hash: string; seller_price_sats: number };

    expect(row.invite_token_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(row.invite_token_hash).not.toContain(created.inviteToken);
    expect(JSON.stringify(created.campaign)).not.toContain(created.inviteToken);
    expect(created.campaign.ownershipChange).toEqual({
      stage: 'awaiting-buyer',
      signedUnitCount: 0,
      requiredUnitCount: 69,
    });
    expect(created.campaign).not.toHaveProperty('sellerPriceSats');
    const events = JSON.stringify(
      dbModule
        .getDb()
        .prepare(
          `SELECT event_type, detail_json FROM community_campaign_events WHERE campaign_id = ?`
        )
        .all(policy.campaignId)
    );
    expect(events).not.toContain(created.inviteToken);
    expect(events).not.toContain(String(row.seller_price_sats));
  });

  it('prevents a sale or second transfer from racing the active invite', () => {
    const seller = policy.owners[1]!;
    transferStore.createPrivatePositionTransferInvite({
      payload: invitePayload(seller.ownerId),
      signature: 'receipt',
      walletAddress: seller.payoutAddress,
      now: NOW,
      random32: deterministicRandom(),
    });
    expect(() =>
      transferStore.createPrivatePositionTransferInvite({
        payload: { ...invitePayload(policy.owners[2]!.ownerId), nonce: 'second-invite' },
        signature: 'receipt-2',
        walletAddress: policy.owners[2]!.payoutAddress,
        now: NOW,
        random32: deterministicRandom(9),
      })
    ).toThrow(/already in progress/u);
    expect(
      dbModule
        .getDb()
        .prepare(`SELECT active_operation_kind FROM community_campaigns WHERE id = ?`)
        .get(policy.campaignId)
    ).toEqual({ active_operation_kind: 'position-transfer' });
  });

  it('rejects the creator position and releases an expired invite lock', () => {
    const creator = policy.owners.find(owner => owner.ownerId === policy.creatorOwnerId)!;
    expect(() =>
      transferStore.createPrivatePositionTransferInvite({
        payload: invitePayload(creator.ownerId),
        signature: 'creator-receipt',
        walletAddress: creator.payoutAddress,
        now: NOW,
      })
    ).toThrow(/creator position/u);

    const seller = policy.owners[1]!;
    transferStore.createPrivatePositionTransferInvite({
      payload: { ...invitePayload(seller.ownerId), expiresAt: NOW + 2 },
      signature: 'short-receipt',
      walletAddress: seller.payoutAddress,
      now: NOW,
      random32: deterministicRandom(3),
    });
    const after = campaignStore.getCommunityCampaign(policy.campaignId, NOW + 3)!;
    expect(after.ownershipChange).toBeNull();
    expect(
      dbModule
        .getDb()
        .prepare(
          `SELECT active_operation_kind, active_operation_id FROM community_campaigns WHERE id = ?`
        )
        .get(policy.campaignId)
    ).toEqual({ active_operation_kind: null, active_operation_id: null });
  });

  it('keeps the seller public through broadcast, then changes the owner after confirmation', async () => {
    installPublicPolicyCrypto();
    const seller = policy.owners[1]!;
    const created = transferStore.createPrivatePositionTransferInvite({
      payload: invitePayload(seller.ownerId),
      signature: 'create-receipt',
      walletAddress: seller.payoutAddress,
      now: NOW,
      random32: deterministicRandom(20),
    });
    const buyerRoot = fixtureRoot(500);
    const buyerPaymentKey = buyerRoot.deriveChild(1_000);
    if (!buyerPaymentKey.privateKey || !buyerPaymentKey.publicKey)
      throw new Error('buyer key missing');
    const buyerPayment = p2wpkh(buyerPaymentKey.publicKey, NETWORK);
    const buyerSession = {
      v: 1 as const,
      ord_addr: buyerPayment.address,
      pay_addr: buyerPayment.address,
      ord_pubkey: null,
      pay_pubkey: bytesToHex(buyerPaymentKey.publicKey),
      accepted_terms_at: NOW,
      issued_at: NOW,
    };
    const acceptPayload: AcceptPositionTransferPayloadV1 = {
      protocol: COMMUNITY_PURCHASES_PROTOCOL,
      version: 1,
      network: 'mainnet',
      action: 'accept-position-transfer',
      campaignId: policy.campaignId,
      transferId: created.transferId,
      buyerOwnerId: 'incoming-owner',
      payoutAddress: buyerPayment.address,
      qualifyingInscriptionNumber: null,
      enrollment: {
        version: 1,
        network: 'mainnet',
        campaignId: policy.campaignId,
        ownerId: 'incoming-owner',
        campaignRoot: {
          version: 1,
          masterFingerprintHex: buyerRoot.fingerprint.toString(16).padStart(8, '0'),
          originPath: 'm',
          campaignXpub: buyerRoot.publicExtendedKey,
        },
      },
      recoveryConfirmed: true,
      noAlternateIdentityAttestation: true,
      identityDisclosureConsent: true,
      expiresAt: NOW + 600,
      nonce: 'buyer-acceptance',
    };
    transferStore.acceptPrivatePositionTransfer({
      token: created.inviteToken,
      payload: acceptPayload,
      signature: 'buyer-acceptance-signature',
      session: buyerSession,
      now: NOW + 1,
    });
    const sellerSession = {
      ...buyerSession,
      ord_addr: seller.payoutAddress,
      pay_addr: seller.payoutAddress,
    };
    const sellerView = await transferStore.getPositionTransferForOwner({
      campaignId: policy.campaignId,
      session: sellerSession,
      nowMs: (NOW + 2) * 1_000,
    });
    const sellerRoot = fixtureRoot(1);
    const sellerPayoutKey = sellerRoot.deriveChild(1_001);
    if (!sellerPayoutKey.privateKey) throw new Error('seller key missing');
    const sellerAuthorizationSignature = signBip322Simple({
      message: communityVaultPositionTransferSellerMessage(sellerView.sellerAuthorizationPayload!),
      privateKey: sellerPayoutKey.privateKey,
      addressKind: 'payment',
      random: length => new Uint8Array(length).fill(9),
    });
    const deps = transferDependencies(buyerPayment.address, bytesToHex(buyerPayment.script));
    await transferStore.authorizePrivatePositionTransfer({
      campaignId: policy.campaignId,
      transferId: created.transferId,
      signature: sellerAuthorizationSignature,
      session: sellerSession,
      nowMs: (NOW + 3) * 1_000,
      deps,
    });
    const buyerView = await transferStore.getPrivatePositionTransferByToken({
      token: created.inviteToken,
      session: buyerSession,
      nowMs: (NOW + 4) * 1_000,
      deps,
    });
    const buyerTx = Transaction.fromPSBT(
      Uint8Array.from(Buffer.from(buyerView.signingPsbtBase64!, 'base64')),
      { PSBTVersion: 0, lowR: true }
    );
    buyerTx.signIdx(buyerPaymentKey.privateKey, 1, [SigHash.ALL]);
    buyerTx.finalizeIdx(1);
    const buyerFundedBase64 = Buffer.from(buyerTx.toPSBT(0)).toString('base64');
    await transferStore.submitPositionTransferBuyerFunding({
      token: created.inviteToken,
      signedPsbtBase64: buyerFundedBase64,
      session: buyerSession,
      nowMs: (NOW + 5) * 1_000,
      deps,
    });

    let ownerView = await transferStore.getPositionTransferForOwner({
      campaignId: policy.campaignId,
      session: sellerSession,
      nowMs: (NOW + 6) * 1_000,
      deps,
    });
    const nextVaultAddress = ownerView.ownerContext!.plan.nextPolicy.address;
    for (let index = 0; index < 5; index++) {
      const owner = policy.owners[index]!;
      const session = {
        ...buyerSession,
        ord_addr: owner.payoutAddress,
        pay_addr: owner.payoutAddress,
      };
      ownerView = await transferStore.getPositionTransferForOwner({
        campaignId: policy.campaignId,
        session,
        nowMs: (NOW + 7 + index) * 1_000,
        deps,
      });
      const approved = approveCommunityVaultPositionTransfer({
        currentPolicy: policy,
        plan: ownerView.ownerContext!.plan,
        psbtHex: Buffer.from(ownerView.signingPsbtBase64!, 'base64').toString('hex'),
        ownerId: owner.ownerId,
        signerRoot: fixtureRoot(index),
        nowMs: String((NOW + 7 + index) * 1_000),
        random: length => new Uint8Array(length).fill(index + 1),
      });
      const checked = validateCommunityVaultPositionTransferPsbt({
        currentPolicy: policy,
        plan: ownerView.ownerContext!.plan,
        psbtHex: approved.psbtHex,
      });
      const payload: ApprovePositionTransferPayloadV1 = {
        protocol: COMMUNITY_PURCHASES_PROTOCOL,
        version: 1,
        network: 'mainnet',
        action: 'approve-position-transfer',
        campaignId: policy.campaignId,
        transferId: created.transferId,
        ownerId: owner.ownerId,
        capTableVersion: policy.capTableVersion,
        transferDigest: ownerView.ownerContext!.plan.transferDigest,
        signedPsbtHash: checked.psbtHash,
        approvedAt: NOW + 7 + index,
        expiresAt: NOW + 600,
        nonce: `approval-${index}`,
      };
      ownerView = transferStore.submitPositionTransferApproval({
        campaignId: policy.campaignId,
        transferId: created.transferId,
        payload,
        signature: `approval-receipt-${index}`,
        walletAddress: owner.payoutAddress,
        signedPsbtBase64: Buffer.from(approved.psbtHex, 'hex').toString('base64'),
        now: NOW + 7 + index,
      });
      if (index === 3) {
        expect(ownerView.signedUnitCount).toBe(68);
        expect(ownerView.status).toBe('signing');
      }
    }
    expect(ownerView.status).toBe('ready');
    expect(ownerView.signedUnitCount).toBe(69);
    expect(campaignStore.getCommunityCampaign(policy.campaignId, NOW + 20)?.participants).toEqual(
      expect.arrayContaining([expect.objectContaining({ ownerId: seller.ownerId })])
    );

    const ready = transferStore.getReadyCommunityPositionTransfer(
      created.transferId,
      (NOW + 20) * 1_000
    );
    transferStore.recordPositionTransferBroadcast({
      transferId: created.transferId,
      txid: ready.txid,
      now: NOW + 21,
    });
    expect(campaignStore.getCommunityCampaign(policy.campaignId, NOW + 21)?.participants).toEqual(
      expect.arrayContaining([expect.objectContaining({ ownerId: seller.ownerId })])
    );
    const expectedOutpoint = `${ready.txid}:0`;
    const confirmed = await transferStore.confirmPositionTransfer({
      transferId: created.transferId,
      now: NOW + 22,
      fetchDetail: async () => ({
        inscription_number: 1,
        inscription_id: policy.inscriptionId,
        output: expectedOutpoint,
        address: nextVaultAddress,
        block_height: 900_000,
        block_timestamp: NOW + 22,
        satpoint: `${expectedOutpoint}:0`,
      }),
      fetchConfirmations: async () => 1,
    });
    expect(confirmed.currentOutpoint).toBe(expectedOutpoint);
    expect(confirmed.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ownerId: 'incoming-owner', allocatedUnits: seller.units }),
      ])
    );
    expect(confirmed.participants.some(item => item.ownerId === seller.ownerId)).toBe(false);
  }, 30_000);
});

function seedHeldCampaign() {
  const db = dbModule.getDb();
  const inscription = db
    .prepare(`SELECT inscription_number FROM inscriptions ORDER BY inscription_number LIMIT 1`)
    .get() as { inscription_number: number };
  const outpoint = `${'aa'.repeat(32)}:0`;
  db.prepare(
    `UPDATE inscriptions SET inscription_id = ?, current_output = ?, current_owner = ?
     WHERE inscription_number = ?`
  ).run(policy.inscriptionId, outpoint, policy.address, inscription.inscription_number);
  db.prepare(
    `INSERT INTO community_campaigns (
       id, inscription_number, inscription_id, current_outpoint, source, ownership_mode,
       eligibility_mode, creator_owner_id, status, terms_version, landed_cost_sats,
       max_landed_cost_sats, source_fingerprint, opened_at, expires_at, cap_table_version,
       cap_table_hash, policy_id, vault_address, policy_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'creator-fronted', ?, ?, ?, 'held', ?, 100000, 100000,
       'fixture', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    policy.campaignId,
    inscription.inscription_number,
    policy.inscriptionId,
    outpoint,
    policy.mode,
    policy.eligibility,
    policy.creatorOwnerId,
    policy.termsVersion,
    NOW - 100,
    NOW + 100_000,
    policy.capTableVersion,
    policy.capTableHash,
    policy.policyId,
    policy.address,
    JSON.stringify(policy),
    NOW - 100,
    NOW
  );
  const insertParticipant = db.prepare(
    `INSERT INTO community_participants (
       campaign_id, owner_id, cap_table_order, identity_key, wallet_address,
       payout_address, payout_script_pubkey_hex, is_creator, requested_units,
       max_contribution_sats, root_fingerprint_hex, campaign_xpub, recovery_confirmed,
       reservation_payload_json, reservation_signature, reservation_nonce, readiness_status,
       joined_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, '{}', 'fixture', ?, 'ready', ?)`
  );
  const insertUnit = db.prepare(
    `INSERT INTO community_units (campaign_id, unit_number, participant_id) VALUES (?, ?, ?)`
  );
  for (const owner of policy.owners) {
    const participantId = Number(
      insertParticipant.run(
        policy.campaignId,
        owner.ownerId,
        owner.capTableOrder,
        `wallet:${owner.payoutAddress}`,
        owner.payoutAddress,
        owner.payoutAddress,
        owner.payoutScriptPubKeyHex,
        owner.ownerId === policy.creatorOwnerId ? 1 : 0,
        owner.units.length,
        owner.campaignRoot.masterFingerprintHex,
        owner.campaignRoot.campaignXpub,
        `reservation-${owner.ownerId}`,
        NOW - 100
      ).lastInsertRowid
    );
    for (const unit of owner.units) insertUnit.run(policy.campaignId, unit, participantId);
  }
}

function invitePayload(sellerOwnerId: string): CreatePositionTransferInvitePayloadV1 {
  return {
    protocol: COMMUNITY_PURCHASES_PROTOCOL,
    version: 1,
    network: 'mainnet',
    action: 'create-position-transfer-invite',
    campaignId: policy.campaignId,
    sellerOwnerId,
    sellerPriceSats: '100000',
    expiresAt: NOW + 24 * 60 * 60,
    nonce: `invite-${sellerOwnerId}`,
  };
}

function deterministicRandom(seed = 1): () => Buffer {
  let value = seed;
  return () => Buffer.alloc(32, value++);
}

function fixtureRoot(index: number): HDKey {
  return HDKey.fromMasterSeed(
    createHash('sha256').update(`drey-community-vault-v1-owner-${index}`).digest()
  );
}

function transferDependencies(buyerAddress: string, buyerScript: string) {
  const vaultOutpoint = `${'aa'.repeat(32)}:0`;
  const buyerOutpoint = `${'bb'.repeat(32)}:1`;
  const output = (outpoint: string) =>
    outpoint === vaultOutpoint
      ? {
          outpoint,
          valueSats: '10000',
          scriptPubKeyHex: policy.scriptPubKeyHex,
          confirmations: 6,
          spent: false,
          inscriptionIds: [policy.inscriptionId],
          runeIds: [],
        }
      : {
          outpoint,
          valueSats: '200000',
          scriptPubKeyHex: buyerScript,
          confirmations: 6,
          spent: false,
          inscriptionIds: [],
          runeIds: [],
        };
  return {
    fetchAddressOutputs: async (address: string) =>
      address === buyerAddress ? [output(buyerOutpoint)] : [],
    fetchOutputs: async (outpoints: string[]) => outpoints.map(output),
    fetchInscription: async () => ({
      inscription_number: 1,
      inscription_id: policy.inscriptionId,
      output: vaultOutpoint,
      address: policy.address,
      block_height: 899_999,
      block_timestamp: NOW,
      satpoint: `${vaultOutpoint}:0`,
    }),
    fetchTxOut: async (txid: string, vout: number) => {
      const outpoint = `${txid}:${vout}`;
      if (outpoint === vaultOutpoint) {
        return {
          confirmations: 6,
          value: 0.0001,
          scriptPubKey: { hex: policy.scriptPubKeyHex },
          coinbase: false,
        };
      }
      if (outpoint === buyerOutpoint) {
        return {
          confirmations: 6,
          value: 0.002,
          scriptPubKey: { hex: buyerScript },
          coinbase: false,
        };
      }
      return null;
    },
    getChainInfo: async () => ({ chain: 'main', blocks: 900_000, bestblockhash: 'cc'.repeat(32) }),
    estimateFeeRate: async () => 1,
    nowMs: () => (NOW + 4) * 1_000,
  };
}
