import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import communityVector from '@drey/core/vectors/community-vault-v1.json';
import {
  COMMUNITY_PURCHASES_PROTOCOL,
  COMMUNITY_PURCHASES_TERMS_VERSION,
  type CommunityEnrollmentV1,
  type ConfirmReadinessPayloadV1,
  type CreateCampaignPayloadV1,
  type ReserveUnitsPayloadV1,
} from '../src/lib/community-purchases/contracts';

let dbModule: typeof import('../src/lib/db');
let store: typeof import('../src/lib/community-purchases/store');
const tempDir = path.join(
  os.tmpdir(),
  `omb-community-${process.pid}-${Math.random().toString(36).slice(2)}`
);
const NOW = 1_800_000_000;
const TARGET_ID = `${'ab'.repeat(32)}i0`;
const TARGET_OUTPOINT = `${'cd'.repeat(32)}:0`;
const roots = communityVector.policy.owners.slice(0, 8);

beforeEach(async () => {
  fs.mkdirSync(tempDir, { recursive: true });
  process.env.OMB_DB_PATH = path.join(tempDir, `${Math.random().toString(36).slice(2)}.db`);
  vi.resetModules();
  dbModule = await import('../src/lib/db');
  store = await import('../src/lib/community-purchases/store');
});

afterEach(() => {
  delete process.env.OMB_DB_PATH;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Windows and native SQLite can briefly retain a handle after a failed test.
  }
});

describe('Community Purchases coordination', () => {
  it('creates public-only schema at v41', () => {
    const db = dbModule.getDb();
    expect(db.pragma('user_version', { simple: true })).toBe(41);
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'community_%' ORDER BY name`
      )
      .all() as Array<{ name: string }>;
    expect(tables.map(row => row.name)).toEqual([
      'community_campaign_events',
      'community_campaigns',
      'community_participants',
      'community_units',
    ]);
    const columns = db.prepare(`PRAGMA table_info(community_participants)`).all() as Array<{
      name: string;
    }>;
    expect(columns.map(column => column.name)).not.toEqual(
      expect.arrayContaining(['private_key', 'mnemonic', 'seed', 'recovery_key'])
    );
  });

  it('aggregates Matrica siblings under one 20-unit identity cap', async () => {
    const fixture = seedListedTarget();
    const creator = await createOpenCampaign(fixture);
    const db = dbModule.getDb();
    db.prepare(
      `INSERT INTO matrica_users (user_id, username, avatar_url, updated_at) VALUES ('m1','alice',NULL,?)`
    ).run(NOW);
    for (const wallet of [roots[1]!.payoutAddress, roots[2]!.payoutAddress]) {
      db.prepare(
        `INSERT INTO wallet_links (wallet_addr, matrica_user_id, checked_at) VALUES (?, 'm1', ?)`
      ).run(wallet, NOW);
    }
    const first = reservePayload(creator, 1, 20);
    store.reserveCommunityUnits({
      payload: first,
      signature: 'sig-1',
      walletAddress: roots[1]!.payoutAddress,
      now: NOW + 1,
    });
    const current = store.getCommunityCampaign(creator.id, NOW + 1)!;
    const second = reservePayload(current, 2, 1);
    expect(() =>
      store.reserveCommunityUnits({
        payload: second,
        signature: 'sig-2',
        walletAddress: roots[2]!.payoutAddress,
        now: NOW + 2,
      })
    ).toThrow(/recognized identity/i);
  });

  it('freezes only after exactly 100 units and every selected owner is ready', async () => {
    const fixture = seedListedTarget();
    let campaign = await createOpenCampaign(fixture);
    for (let index = 1; index < 5; index++) {
      campaign = store.reserveCommunityUnits({
        payload: reservePayload(campaign, index, 20),
        signature: `reserve-${index}`,
        walletAddress: roots[index]!.payoutAddress,
        now: NOW + index,
      });
    }
    expect(campaign.allocatedUnitCount).toBe(100);
    expect(campaign.status).toBe('readiness');
    expect(campaign.policy).toBeNull();

    for (let index = 0; index < 5; index++) {
      const owner = campaign.participants.find(
        row => row.walletAddress === roots[index]!.payoutAddress
      )!;
      const payload: ConfirmReadinessPayloadV1 = {
        protocol: COMMUNITY_PURCHASES_PROTOCOL,
        version: 1,
        network: 'mainnet',
        action: 'confirm-readiness',
        campaignId: campaign.id,
        ownerId: owner.ownerId,
        capTableVersion: campaign.capTableVersion,
        fundingOutpoints: [`${String(index + 1).padStart(64, '0')}:0`],
        confirmedAt: NOW + 10 + index,
        expiresAt: NOW + 600,
        nonce: `ready-${index}`,
      };
      campaign = store.confirmCommunityReadiness({
        payload,
        signature: `ready-signature-${index}`,
        walletAddress: roots[index]!.payoutAddress,
        now: NOW + 10 + index,
      });
      if (index < 4) expect(campaign.status).toBe('readiness');
    }

    expect(campaign.status).toBe('frozen');
    expect(campaign.policyId).toMatch(/^[0-9a-f]{64}$/);
    expect(campaign.capTableHash).toMatch(/^[0-9a-f]{64}$/);
    expect(campaign.vaultAddress).toMatch(/^bc1p/);
    const policy = campaign.policy as typeof communityVector.policy;
    expect(policy.threshold).toBe(69);
    expect(policy.unitCount).toBe(100);
    expect(policy.internalKeyHex).toBe(
      '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0'
    );
    expect(policy.owners).toHaveLength(5);
    expect(policy.owners.flatMap(owner => owner.units).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 100 }, (_, unit) => unit)
    );
  });

  it('accepts excess demand into an ordered waitlist without mutating the frozen roster version', async () => {
    const fixture = seedListedTarget();
    let campaign = await createOpenCampaign(fixture);
    for (let index = 1; index < 5; index++) {
      campaign = store.reserveCommunityUnits({
        payload: reservePayload(campaign, index, 20),
        signature: `reserve-${index}`,
        walletAddress: roots[index]!.payoutAddress,
        now: NOW + index,
      });
    }
    const fullVersion = campaign.capTableVersion;
    const waiting = store.reserveCommunityUnits({
      payload: reservePayload(campaign, 5, 10),
      signature: 'waitlist',
      walletAddress: roots[5]!.payoutAddress,
      now: NOW + 20,
    });
    expect(waiting.status).toBe('readiness');
    expect(waiting.capTableVersion).toBe(fullVersion);
    expect(waiting.participants.find(row => row.ownerId === 'owner-5')).toMatchObject({
      allocatedUnits: [],
      waitlistedUnits: 10,
    });
  });

  it('rejects duplicate funding outpoints across selected owners', async () => {
    const fixture = seedListedTarget();
    let campaign = await createOpenCampaign(fixture);
    for (let index = 1; index < 5; index++) {
      campaign = store.reserveCommunityUnits({
        payload: reservePayload(campaign, index, 20),
        signature: `reserve-${index}`,
        walletAddress: roots[index]!.payoutAddress,
        now: NOW + index,
      });
    }
    const shared = `${'11'.repeat(32)}:0`;
    const firstOwner = campaign.participants[0]!;
    const first = readinessPayload(campaign, firstOwner.ownerId, shared, 'first');
    store.confirmCommunityReadiness({
      payload: first,
      signature: 'first',
      walletAddress: firstOwner.walletAddress,
      now: NOW + 10,
    });
    const secondOwner = campaign.participants[1]!;
    const second = readinessPayload(campaign, secondOwner.ownerId, shared, 'second');
    expect(() =>
      store.confirmCommunityReadiness({
        payload: second,
        signature: 'second',
        walletAddress: secondOwner.walletAddress,
        now: NOW + 11,
      })
    ).toThrow(/already committed/i);
  });

  it('promotes the ordered waitlist after a readiness timeout without moving funds', async () => {
    const fixture = seedListedTarget();
    let campaign = await createOpenCampaign(fixture);
    for (let index = 1; index < 5; index++) {
      campaign = store.reserveCommunityUnits({
        payload: reservePayload(campaign, index, 20),
        signature: `reserve-${index}`,
        walletAddress: roots[index]!.payoutAddress,
        now: NOW + index,
      });
    }
    campaign = store.reserveCommunityUnits({
      payload: reservePayload(campaign, 5, 10),
      signature: 'waitlist',
      walletAddress: roots[5]!.payoutAddress,
      now: NOW + 20,
    });
    for (const index of [0, 2, 3, 4]) {
      const participant = campaign.participants.find(
        row => row.walletAddress === roots[index]!.payoutAddress
      )!;
      campaign = store.confirmCommunityReadiness({
        payload: readinessPayload(
          campaign,
          participant.ownerId,
          `${String(index + 10).padStart(64, '0')}:0`,
          `ready-${index}`
        ),
        signature: `ready-${index}`,
        walletAddress: participant.walletAddress,
        now: NOW + 30 + index,
      });
    }
    const versionBeforeTimeout = campaign.capTableVersion;
    const after = store.getCommunityCampaign(campaign.id, campaign.readinessDeadline! + 1)!;
    expect(after.status).toBe('open');
    expect(after.allocatedUnitCount).toBe(90);
    expect(after.capTableVersion).toBe(versionBeforeTimeout + 1);
    expect(after.participants.find(row => row.ownerId === 'owner-1')?.readiness).toBe('timed-out');
    expect(after.participants.find(row => row.ownerId === 'owner-5')).toMatchObject({
      allocatedUnits: expect.arrayContaining([20]),
      waitlistedUnits: 0,
      readiness: 'waiting',
    });
    expect(after.policy).toBeNull();
  });

  it('invalidates a listed campaign when an immutable listing term changes', async () => {
    const fixture = seedListedTarget();
    const campaign = await createOpenCampaign(fixture);
    dbModule
      .getDb()
      .prepare(
        `UPDATE active_listings SET price_sats = price_sats + 1 WHERE satflow_id = 'listing-1'`
      )
      .run();
    const after = store.getCommunityCampaign(campaign.id, NOW + 1)!;
    expect(after.status).toBe('failed');
    expect(after.allocatedUnitCount).toBe(20);
  });

  it('derives creator-fronted landed cost from the confirmed buyer debit', async () => {
    const db = dbModule.getDb();
    const rows = db
      .prepare(`SELECT inscription_number FROM inscriptions ORDER BY inscription_number LIMIT 2`)
      .all() as Array<{ inscription_number: number }>;
    const txid = 'ef'.repeat(32);
    const creator = roots[0]!;
    const paymentAddress = roots[1]!.payoutAddress;
    db.prepare(
      `UPDATE inscriptions SET inscription_id = ?, current_output = ?, current_owner = ?,
       effective_owner = ?, active_loan_count = 0, last_movement_at = ?
       WHERE inscription_number = ?`
    ).run(
      TARGET_ID,
      `${txid}:1`,
      creator.payoutAddress,
      creator.payoutAddress,
      NOW - 60,
      rows[0]!.inscription_number
    );
    db.prepare(
      `UPDATE inscriptions SET current_owner = ?, effective_owner = ?, active_loan_count = 0,
       last_movement_at = ? WHERE inscription_number = ?`
    ).run(creator.payoutAddress, creator.payoutAddress, NOW - 100, rows[1]!.inscription_number);
    const intentId = Number(
      db
        .prepare(
          `INSERT INTO buy_intents (
           inscription_id, inscription_number, buyer_ord_addr, buyer_pay_addr, marketplace,
           price_sats, status, txid, preflight_json, is_mock, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'satflow', 1000000, 'confirmed', ?, '{}', 0, ?, ?)`
        )
        .run(
          TARGET_ID,
          rows[0]!.inscription_number,
          creator.payoutAddress,
          paymentAddress,
          txid,
          NOW - 60,
          NOW - 60
        ).lastInsertRowid
    );
    const payload: CreateCampaignPayloadV1 = {
      protocol: COMMUNITY_PURCHASES_PROTOCOL,
      version: 1,
      network: 'mainnet',
      action: 'create-campaign',
      campaignId: 'fronted-test',
      creatorOwnerId: 'owner-0',
      inscriptionNumber: rows[0]!.inscription_number,
      source: 'creator-fronted',
      ownershipMode: 'open',
      eligibilityMode: 'anyone',
      creatorUnits: 20,
      maxLandedCostSats: '1600000',
      listingId: null,
      marketplace: null,
      frontedBuyIntentId: intentId,
      payoutAddress: creator.payoutAddress,
      enrollment: enrollment(0, 'fronted-test'),
      recoveryConfirmed: true,
      permanentAnchorAccepted: false,
      identityDisclosureConsent: true,
      termsVersion: COMMUNITY_PURCHASES_TERMS_VERSION,
      expiresAt: NOW + 72 * 60 * 60,
      nonce: 'fronted-create',
    };
    const campaign = await store.createCommunityCampaign({
      payload,
      signature: 'fronted-signature',
      walletAddress: creator.payoutAddress,
      now: NOW,
      fetchTransaction: async () => ({
        txid,
        vin: [
          {
            prevout: {
              value: 0.02,
              scriptPubKey: { address: paymentAddress },
            },
          },
          { prevout: { value: 0.0001, scriptPubKey: { address: 'seller' } } },
        ],
        vout: [
          { value: 0.005, scriptPubKey: { address: paymentAddress } },
          { value: 0.0001, scriptPubKey: { address: creator.payoutAddress } },
          { value: 0.01005, scriptPubKey: { address: 'seller' } },
        ],
      }),
    });
    // 2,000,000 sats payment input - 500,000 sats clean change. The
    // inscription postage stays in landed cost by design.
    expect(campaign.landedCostSats).toBe('1500000');
    expect(campaign.source).toBe('creator-fronted');
  });
});

function seedListedTarget() {
  const db = dbModule.getDb();
  const rows = db
    .prepare(`SELECT inscription_number FROM inscriptions ORDER BY inscription_number LIMIT 2`)
    .all() as Array<{ inscription_number: number }>;
  const targetNumber = rows[0]!.inscription_number;
  const creatorOmbNumber = rows[1]!.inscription_number;
  db.prepare(
    `UPDATE inscriptions SET inscription_id = ?, current_output = ?, current_owner = 'seller',
       effective_owner = 'seller', active_loan_count = 0, last_movement_at = ?
     WHERE inscription_number = ?`
  ).run(TARGET_ID, TARGET_OUTPOINT, NOW - 100, targetNumber);
  db.prepare(
    `UPDATE inscriptions SET current_owner = ?, effective_owner = ?, active_loan_count = 0,
       last_movement_at = ? WHERE inscription_number = ?`
  ).run(roots[0]!.payoutAddress, roots[0]!.payoutAddress, NOW - 100, creatorOmbNumber);
  db.prepare(
    `INSERT INTO active_listings (
       inscription_number, inscription_id, satflow_id, price_sats, seller,
       marketplace, listed_at, refreshed_at
     ) VALUES (?, ?, 'listing-1', 1000000, 'seller', 'satflow', ?, ?)`
  ).run(targetNumber, TARGET_ID, NOW - 60, NOW);
  return { targetNumber };
}

async function createOpenCampaign(fixture: { targetNumber: number }) {
  const payload: CreateCampaignPayloadV1 = {
    protocol: COMMUNITY_PURCHASES_PROTOCOL,
    version: 1,
    network: 'mainnet',
    action: 'create-campaign',
    campaignId: 'campaign-test',
    creatorOwnerId: 'owner-0',
    inscriptionNumber: fixture.targetNumber,
    source: 'listed',
    ownershipMode: 'open',
    eligibilityMode: 'anyone',
    creatorUnits: 20,
    maxLandedCostSats: '2000000',
    listingId: 'listing-1',
    marketplace: 'satflow',
    frontedBuyIntentId: null,
    payoutAddress: roots[0]!.payoutAddress,
    enrollment: enrollment(0, 'campaign-test'),
    recoveryConfirmed: true,
    permanentAnchorAccepted: false,
    identityDisclosureConsent: true,
    termsVersion: COMMUNITY_PURCHASES_TERMS_VERSION,
    expiresAt: NOW + 3600,
    nonce: 'create-1',
  };
  return store.createCommunityCampaign({
    payload,
    signature: 'creator-signature',
    walletAddress: roots[0]!.payoutAddress,
    now: NOW,
  });
}

function reservePayload(
  campaign: Awaited<ReturnType<typeof createOpenCampaign>>,
  index: number,
  requestedUnits: number
): ReserveUnitsPayloadV1 {
  return {
    protocol: COMMUNITY_PURCHASES_PROTOCOL,
    version: 1,
    network: 'mainnet',
    action: 'reserve-units',
    campaignId: campaign.id,
    ownerId: `owner-${index}`,
    requestedUnits,
    maxContributionSats: String(
      Math.ceil((Number(campaign.maxLandedCostSats) * requestedUnits) / 100)
    ),
    qualifyingInscriptionNumber: null,
    payoutAddress: roots[index]!.payoutAddress,
    enrollment: enrollment(index, campaign.id),
    recoveryConfirmed: true,
    noAlternateIdentityAttestation: true,
    identityDisclosureConsent: true,
    termsVersion: COMMUNITY_PURCHASES_TERMS_VERSION,
    capTableVersion: campaign.capTableVersion,
    expiresAt: NOW + 600,
    nonce: `reserve-${index}`,
  };
}

function readinessPayload(
  campaign: Awaited<ReturnType<typeof createOpenCampaign>>,
  ownerId: string,
  outpoint: string,
  nonce: string
): ConfirmReadinessPayloadV1 {
  return {
    protocol: COMMUNITY_PURCHASES_PROTOCOL,
    version: 1,
    network: 'mainnet',
    action: 'confirm-readiness',
    campaignId: campaign.id,
    ownerId,
    capTableVersion: campaign.capTableVersion,
    fundingOutpoints: [outpoint],
    confirmedAt: NOW + 10,
    expiresAt: NOW + 600,
    nonce,
  };
}

function enrollment(index: number, campaignId: string): CommunityEnrollmentV1 {
  const root = roots[index]!;
  return {
    version: 1,
    network: 'mainnet',
    campaignId,
    ownerId: `owner-${index}`,
    campaignRoot: {
      version: 1,
      masterFingerprintHex: root.campaignRoot.masterFingerprintHex,
      originPath: 'm',
      campaignXpub: root.campaignRoot.campaignXpub,
    },
  };
}
