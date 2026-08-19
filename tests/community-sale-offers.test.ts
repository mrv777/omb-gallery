import { beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import communityVector from '@drey/core/vectors/community-vault-v1.json';
import type { CommunityVaultPolicyV1 } from '@drey/core/domain/community-vault/contracts';
import { createCommunityVaultSalePlan } from '@drey/core/domain/community-vault/sale';
import type { CommunityVaultSaleBuyerInputV1 } from '@drey/core/domain/community-vault/sale-contracts';
import { installPublicPolicyCrypto } from '@/lib/community-purchases/dreyCrypto';
import {
  estimateCommunitySaleVsize,
  refreshCommunitySalePlanPreflight,
  selectCommunitySaleFunding,
} from '@/lib/community-purchases/saleOffers';

const policy = communityVector.policy as CommunityVaultPolicyV1;
const fundingScript = policy.owners[0]!.payoutScriptPubKeyHex;
const destinationScript = policy.owners[1]!.payoutScriptPubKeyHex;
const destinationAddress = policy.owners[1]!.payoutAddress;

beforeAll(() => installPublicPolicyCrypto());

function candidate(index: number, valueSats: string): CommunityVaultSaleBuyerInputV1 {
  return {
    txid: index.toString(16).padStart(64, '0'),
    vout: index,
    valueSats,
    scriptPubKeyHex: fundingScript,
    sequence: 0xffff_fffd,
    scriptKind: 'p2wpkh',
    sighashType: 1,
  };
}

describe('Community Vault buyer offer funding', () => {
  it('selects the fewest largest clean inputs and gives exact change', () => {
    const result = selectCommunitySaleFunding({
      policy,
      candidates: [candidate(1, '60000'), candidate(2, '200000'), candidate(3, '70000')],
      grossOfferSats: '100000',
      destinationScriptPubKeyHex: destinationScript,
      changeScriptPubKeyHex: fundingScript,
      feeRateSatPerVb: 2,
    });
    expect(result.inputs.map(input => input.valueSats)).toEqual(['200000']);
    expect(BigInt(result.feeSats)).toBe(BigInt(result.vsize) * 2n);
    expect(BigInt(result.changeSats!)).toBe(200_000n - 100_000n - BigInt(result.feeSats));
    expect(result.vsize).toBe(2388);
  });

  it('absorbs only sub-dust remainder and rejects insufficient funding', () => {
    const vsize = estimateCommunitySaleVsize({
      policy,
      buyerInputs: [candidate(1, '1')],
      destinationScriptPubKeyHex: destinationScript,
    });
    const noChangeValue = 100_000n + BigInt(vsize) + 100n;
    const result = selectCommunitySaleFunding({
      policy,
      candidates: [candidate(1, noChangeValue.toString())],
      grossOfferSats: '100000',
      destinationScriptPubKeyHex: destinationScript,
      changeScriptPubKeyHex: fundingScript,
      feeRateSatPerVb: 1,
    });
    expect(result.changeSats).toBeNull();
    expect(result.feeSats).toBe((BigInt(vsize) + 100n).toString());
    expect(() =>
      selectCommunitySaleFunding({
        policy,
        candidates: [candidate(2, '100001')],
        grossOfferSats: '100000',
        destinationScriptPubKeyHex: destinationScript,
        changeScriptPubKeyHex: fundingScript,
        feeRateSatPerVb: 1,
      })
    ).toThrow(/enough confirmed, clean BTC/u);
  });

  it('keeps fee/change conservation across generated offer amounts', () => {
    fc.assert(
      fc.property(fc.integer({ min: 100_000, max: 10_000_000 }), gross => {
        const result = selectCommunitySaleFunding({
          policy,
          candidates: [candidate(1, String(gross + 100_000))],
          grossOfferSats: String(gross),
          destinationScriptPubKeyHex: destinationScript,
          changeScriptPubKeyHex: fundingScript,
          feeRateSatPerVb: 3,
        });
        expect(BigInt(gross) + BigInt(result.feeSats) + BigInt(result.changeSats ?? '0')).toBe(
          BigInt(result.inputs[0]!.valueSats)
        );
      }),
      { numRuns: 100 }
    );
  });

  it('keeps the maximum policy input shape below Bitcoin mainnet transaction weight', () => {
    const vsize = estimateCommunitySaleVsize({
      policy,
      buyerInputs: Array.from({ length: 499 }, (_item, index) => candidate(index + 1, '10000')),
      destinationScriptPubKeyHex: destinationScript,
      changeScriptPubKeyHex: fundingScript,
    });
    expect(vsize).toBe(36_379);
    expect(vsize * 4).toBeLessThanOrEqual(400_000);
  });

  it('rechecks every exact input and rejects moved buyer funds', async () => {
    const selected = selectCommunitySaleFunding({
      policy,
      candidates: [candidate(9, '200000')],
      grossOfferSats: '100000',
      destinationScriptPubKeyHex: destinationScript,
      changeScriptPubKeyHex: fundingScript,
      feeRateSatPerVb: 2,
    });
    const plan = createCommunityVaultSalePlan({
      policy,
      vaultOutpoint: { txid: 'ee'.repeat(32), vout: 0 },
      offerId: 'aa'.repeat(32),
      buyerId: 'buyer-fixture',
      nonceHex: 'bb'.repeat(32),
      createdAtMs: '1800000000000',
      expiresAtMs: '1800086400000',
      vaultValueSats: '10000',
      inscriptionInputOffsetSats: '0',
      postageSats: '10000',
      grossOfferSats: '100000',
      settlementFeeSats: selected.feeSats,
      buyerDestinationAddress: destinationAddress,
      buyerDestinationScriptPubKeyHex: destinationScript,
      buyerInputs: selected.inputs,
      buyerChange: selected.changeSats
        ? { valueSats: selected.changeSats, scriptPubKeyHex: fundingScript }
        : null,
    });
    const ordOutputs = plan.spendPlan.inputs.map((input, inputIndex) => ({
      outpoint: `${input.txid}:${input.vout}`,
      valueSats: input.valueSats,
      scriptPubKeyHex: input.scriptPubKeyHex,
      confirmations: 6,
      spent: false,
      inscriptionIds: inputIndex === 0 ? [plan.inscriptionId] : [],
      runeIds: [],
    }));
    const txOutputs = new Map(
      plan.spendPlan.inputs.map(input => [
        `${input.txid}:${input.vout}`,
        {
          confirmations: 6,
          value: Number(input.valueSats) / 100_000_000,
          scriptPubKey: { hex: input.scriptPubKeyHex },
          coinbase: false,
        },
      ])
    );
    const deps = {
      fetchOutputs: async () => ordOutputs,
      getChainInfo: async () => ({ blocks: 910000, bestblockhash: 'cc'.repeat(32), chain: 'main' }),
      fetchTxOut: async (txid: string, vout: number) => txOutputs.get(`${txid}:${vout}`) ?? null,
      nowMs: () => 1_800_000_010_000,
    };
    const preflight = await refreshCommunitySalePlanPreflight({ policy, plan, deps });
    expect(preflight.inputs).toHaveLength(2);
    expect(preflight.inputs[0]!.inscriptionIds).toEqual([policy.inscriptionId]);
    await expect(
      refreshCommunitySalePlanPreflight({
        policy,
        plan,
        deps: {
          ...deps,
          fetchTxOut: async (txid: string, vout: number) =>
            txid === selected.inputs[0]!.txid ? null : (txOutputs.get(`${txid}:${vout}`) ?? null),
        },
      })
    ).rejects.toThrow(/funds moved/u);
  });
});
