import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { address, networks } from 'bitcoinjs-lib';
import {
  constructCommunityVaultSalePsbt,
  createCommunityVaultSalePlan,
} from '@drey/core/domain/community-vault/sale';
import type {
  CommunityVaultSaleBuyerInputV1,
  CommunityVaultSalePlanV1,
  CommunityVaultSalePreflightV1,
} from '@drey/core/domain/community-vault/sale-contracts';
import { assertCommunityVaultPolicy } from '@drey/core/domain/community-vault/policy';
import type { CommunityVaultPolicyV1 } from '@drey/core/domain/community-vault/contracts';
import { scriptDustSats } from '@drey/core/domain/transactions/fees';
import { estimateFeeRateSatPerVb, getBlockchainInfo, getTxOut, type TxOut } from '@/lib/bitcoind';
import {
  fetchAddressCardinalOutputs,
  fetchInscriptionDetail,
  fetchOutputsBatch,
  type OrdOutputInfo,
} from '@/lib/ord';
import type { BuyerSession } from '@/lib/buyerSession';
import { CommunityPurchaseError, getCommunityCampaign } from './store';
import { installPublicPolicyCrypto } from './dreyCrypto';

const MAX_INPUTS = 499;
const RBF_SEQUENCE = 0xffff_fffd;
const OFFER_DURATIONS_HOURS = new Set([6, 24, 72]);
const MAINNET_TX_WEIGHT_LIMIT = 400_000;

export type SaleOfferDependencies = {
  fetchAddressOutputs: typeof fetchAddressCardinalOutputs;
  fetchOutputs: typeof fetchOutputsBatch;
  fetchInscription: typeof fetchInscriptionDetail;
  fetchTxOut: typeof getTxOut;
  getChainInfo: typeof getBlockchainInfo;
  estimateFeeRate: typeof estimateFeeRateSatPerVb;
  nowMs(): number;
  random32(): Buffer;
};

const dependencies: SaleOfferDependencies = {
  fetchAddressOutputs: fetchAddressCardinalOutputs,
  fetchOutputs: fetchOutputsBatch,
  fetchInscription: fetchInscriptionDetail,
  fetchTxOut: getTxOut,
  getChainInfo: getBlockchainInfo,
  estimateFeeRate: estimateFeeRateSatPerVb,
  nowMs: Date.now,
  random32: () => randomBytes(32),
};

export type PreparedCommunitySaleOffer = {
  policy: CommunityVaultPolicyV1;
  plan: CommunityVaultSalePlanV1;
  preflight: CommunityVaultSalePreflightV1;
  signingPsbtBase64: string;
  buyerInputIndexes: number[];
  feeRateSatPerVb: number;
};

export async function prepareCommunitySaleOffer(args: {
  campaignId: string;
  session: BuyerSession;
  grossOfferSats: string;
  durationHours: number;
  deps?: Partial<SaleOfferDependencies>;
}): Promise<PreparedCommunitySaleOffer> {
  installPublicPolicyCrypto();
  const deps = { ...dependencies, ...args.deps };
  const campaign = getCommunityCampaign(args.campaignId);
  if (!campaign || campaign.status !== 'held' || !campaign.policy || campaign.sale) {
    throw new CommunityPurchaseError(
      'sale-offer-unavailable',
      campaign?.sale ? 'This OMB already has a funded offer.' : 'This OMB is not ready for offers.',
      409
    );
  }
  if (!args.session.pay_addr) {
    throw new CommunityPurchaseError(
      'payment-address-required',
      'Reconnect Drey with a payment address before making an offer.',
      409
    );
  }
  if (!/^(?:[1-9][0-9]*)$/u.test(args.grossOfferSats)) {
    throw new CommunityPurchaseError('offer-amount-invalid', 'Enter an offer greater than zero.');
  }
  if (!OFFER_DURATIONS_HOURS.has(args.durationHours)) {
    throw new CommunityPurchaseError(
      'offer-duration-invalid',
      'Choose 6 hours, 24 hours, or 3 days.'
    );
  }

  const policy = campaign.policy as CommunityVaultPolicyV1;
  assertCommunityVaultPolicy(policy);
  const paymentScript = outputScript(args.session.pay_addr);
  const destinationScript = outputScript(args.session.ord_addr);
  const [asset, inscription, addressOutputs, feeRateSatPerVb] = await Promise.all([
    exactTxOut(campaign.currentOutpoint, deps.fetchTxOut),
    deps.fetchInscription(campaign.inscriptionId),
    deps.fetchAddressOutputs(args.session.pay_addr),
    deps.estimateFeeRate(),
  ]);
  if (
    asset.confirmations < 1 ||
    asset.scriptPubKey.hex.toLowerCase() !== policy.scriptPubKeyHex ||
    inscription.output !== campaign.currentOutpoint ||
    !inscription.satpoint?.startsWith(`${campaign.currentOutpoint}:`)
  ) {
    throw new CommunityPurchaseError(
      'vault-output-changed',
      'The held OMB changed before the offer could be prepared.',
      409
    );
  }
  const inscriptionOffset = parseSatpointOffset(inscription.satpoint);
  const vaultValueSats = btcToSats(asset.value);
  if (inscriptionOffset >= BigInt(vaultValueSats)) {
    throw new CommunityPurchaseError(
      'ordinal-route-invalid',
      'The OMB satpoint is outside its vault output.',
      409
    );
  }

  const candidates = await verifiedFundingCandidates({
    outputs: addressOutputs,
    expectedScript: paymentScript,
    fetchTxOut: deps.fetchTxOut,
  });
  const selected = selectCommunitySaleFunding({
    policy,
    candidates,
    grossOfferSats: args.grossOfferSats,
    destinationScriptPubKeyHex: destinationScript,
    changeScriptPubKeyHex: paymentScript,
    feeRateSatPerVb,
  });
  const createdAtMs = deps.nowMs();
  const plan = createCommunityVaultSalePlan({
    policy,
    vaultOutpoint: parseOutpoint(campaign.currentOutpoint),
    offerId: deps.random32().toString('hex'),
    buyerId: buyerId(args.session.ord_addr),
    nonceHex: deps.random32().toString('hex'),
    createdAtMs: String(createdAtMs),
    expiresAtMs: String(createdAtMs + args.durationHours * 60 * 60 * 1_000),
    vaultValueSats,
    inscriptionInputOffsetSats: inscriptionOffset.toString(),
    postageSats: (BigInt(vaultValueSats) - inscriptionOffset).toString(),
    grossOfferSats: args.grossOfferSats,
    settlementFeeSats: selected.feeSats,
    buyerDestinationAddress: args.session.ord_addr,
    buyerDestinationScriptPubKeyHex: destinationScript,
    buyerInputs: selected.inputs,
    buyerChange: selected.changeSats
      ? { valueSats: selected.changeSats, scriptPubKeyHex: paymentScript }
      : null,
  });
  const preflight = await refreshCommunitySalePlanPreflight({ policy, plan, deps });
  const signingPsbtHex = constructCommunityVaultSalePsbt(policy, plan);
  return {
    policy,
    plan,
    preflight,
    signingPsbtBase64: Buffer.from(signingPsbtHex, 'hex').toString('base64'),
    buyerInputIndexes: plan.buyerInputs.map((_input, index) => index + 1),
    feeRateSatPerVb,
  };
}

export async function refreshCommunitySalePlanPreflight(args: {
  policy: CommunityVaultPolicyV1;
  plan: CommunityVaultSalePlanV1;
  deps?: Partial<SaleOfferDependencies>;
}): Promise<CommunityVaultSalePreflightV1> {
  const deps = { ...dependencies, ...args.deps };
  const planned = args.plan.spendPlan.inputs;
  const outpoints = planned.map(input => `${input.txid}:${input.vout}`);
  const [ordOutputs, chainInfo, ...txOutputs] = await Promise.all([
    deps.fetchOutputs(outpoints),
    deps.getChainInfo(),
    ...planned.map(input => deps.fetchTxOut(input.txid, input.vout)),
  ]);
  if (chainInfo.chain !== 'main' || !/^[0-9a-f]{64}$/iu.test(chainInfo.bestblockhash)) {
    throw new CommunityPurchaseError(
      'mainnet-required',
      'Mainnet verification is unavailable.',
      503
    );
  }
  const ordByOutpoint = new Map(ordOutputs.map(output => [output.outpoint, output]));
  const inputs = planned.map((input, inputIndex) => {
    const outpoint = outpoints[inputIndex]!;
    const ordOutput = ordByOutpoint.get(outpoint);
    const txOutput = txOutputs[inputIndex] as TxOut | null;
    const expectedInscriptions =
      inputIndex === args.plan.spendPlan.vaultInputIndex ? [args.plan.inscriptionId] : [];
    if (
      !ordOutput ||
      !txOutput ||
      ordOutput.spent ||
      ordOutput.confirmations < 1 ||
      txOutput.confirmations < 1 ||
      ordOutput.valueSats !== input.valueSats ||
      btcToSats(txOutput.value) !== input.valueSats ||
      ordOutput.scriptPubKeyHex !== input.scriptPubKeyHex ||
      txOutput.scriptPubKey.hex.toLowerCase() !== input.scriptPubKeyHex ||
      JSON.stringify(ordOutput.inscriptionIds) !== JSON.stringify(expectedInscriptions) ||
      ordOutput.runeIds.length > 0
    ) {
      throw new CommunityPurchaseError(
        'sale-funds-changed',
        inputIndex === 0
          ? 'The held OMB changed. This offer cannot continue.'
          : 'The buyer funds moved or are no longer clean. This offer is closed.',
        409
      );
    }
    return {
      inputIndex,
      txid: input.txid,
      vout: input.vout,
      valueSats: input.valueSats,
      scriptPubKeyHex: input.scriptPubKeyHex,
      unspent: true,
      inscriptionIds: expectedInscriptions,
      runeIds: [],
    };
  });
  return {
    version: 1,
    network: 'mainnet',
    source: 'ord',
    verifiedAtMs: String(deps.nowMs()),
    blockHeight: chainInfo.blocks,
    blockHash: chainInfo.bestblockhash.toLowerCase(),
    inputs,
  };
}

export type SaleFundingSelection = {
  inputs: CommunityVaultSaleBuyerInputV1[];
  feeSats: string;
  changeSats: string | null;
  vsize: number;
};

export function selectCommunitySaleFunding(args: {
  policy: CommunityVaultPolicyV1;
  candidates: CommunityVaultSaleBuyerInputV1[];
  grossOfferSats: string;
  destinationScriptPubKeyHex: string;
  changeScriptPubKeyHex: string;
  feeRateSatPerVb: number;
}): SaleFundingSelection {
  const gross = BigInt(args.grossOfferSats);
  if (gross <= 0n || !Number.isFinite(args.feeRateSatPerVb) || args.feeRateSatPerVb < 1) {
    throw new CommunityPurchaseError(
      'offer-amount-invalid',
      'The offer amount or fee rate is invalid.'
    );
  }
  const candidates = [...args.candidates]
    .sort((left, right) => {
      const valueOrder = BigInt(right.valueSats) - BigInt(left.valueSats);
      return valueOrder > 0n
        ? 1
        : valueOrder < 0n
          ? -1
          : `${left.txid}:${left.vout}`.localeCompare(`${right.txid}:${right.vout}`);
    })
    .slice(0, MAX_INPUTS);
  const selected: CommunityVaultSaleBuyerInputV1[] = [];
  let total = 0n;
  for (const candidate of candidates) {
    selected.push(candidate);
    total += BigInt(candidate.valueSats);
    const withChangeVsize = estimateCommunitySaleVsize({
      policy: args.policy,
      buyerInputs: selected,
      destinationScriptPubKeyHex: args.destinationScriptPubKeyHex,
      changeScriptPubKeyHex: args.changeScriptPubKeyHex,
    });
    const withChangeFee = feeForVsize(withChangeVsize, args.feeRateSatPerVb);
    if (total >= gross + withChangeFee) {
      const change = total - gross - withChangeFee;
      if (change >= scriptDustSats(args.changeScriptPubKeyHex)) {
        return {
          inputs: selected,
          feeSats: withChangeFee.toString(),
          changeSats: change.toString(),
          vsize: withChangeVsize,
        };
      }
    }
    const withoutChangeVsize = estimateCommunitySaleVsize({
      policy: args.policy,
      buyerInputs: selected,
      destinationScriptPubKeyHex: args.destinationScriptPubKeyHex,
    });
    const withoutChangeFee = feeForVsize(withoutChangeVsize, args.feeRateSatPerVb);
    const remainder = total - gross;
    if (
      remainder >= withoutChangeFee &&
      remainder < withoutChangeFee + scriptDustSats(args.changeScriptPubKeyHex)
    ) {
      return {
        inputs: selected,
        feeSats: remainder.toString(),
        changeSats: null,
        vsize: withoutChangeVsize,
      };
    }
  }
  throw new CommunityPurchaseError(
    'offer-funds-insufficient',
    'Drey does not have enough confirmed, clean BTC for this offer and its network fee.',
    409
  );
}

export function estimateCommunitySaleVsize(args: {
  policy: CommunityVaultPolicyV1;
  buyerInputs: CommunityVaultSaleBuyerInputV1[];
  destinationScriptPubKeyHex: string;
  changeScriptPubKeyHex?: string;
}): number {
  const scripts = [
    args.destinationScriptPubKeyHex,
    ...args.policy.owners
      .toSorted((left, right) => left.capTableOrder - right.capTableOrder)
      .map(owner => owner.payoutScriptPubKeyHex),
    ...(args.changeScriptPubKeyHex ? [args.changeScriptPubKeyHex] : []),
  ];
  const inputCount = 1 + args.buyerInputs.length;
  const strippedBytes =
    4 +
    compactSizeBytes(inputCount) +
    inputCount * 41 +
    compactSizeBytes(scripts.length) +
    scripts.reduce((sum, script) => {
      const length = script.length / 2;
      return sum + 8 + compactSizeBytes(length) + length;
    }, 0) +
    4;
  const tapscriptBytes = args.policy.tapscriptHex.length / 2;
  const controlBlockBytes = args.policy.controlBlockHex.length / 2;
  const vaultWitnessBytes =
    compactSizeBytes(102) +
    69 * (1 + 64) +
    31 +
    compactSizeBytes(tapscriptBytes) +
    tapscriptBytes +
    compactSizeBytes(controlBlockBytes) +
    controlBlockBytes;
  const buyerWitnessBytes = args.buyerInputs.reduce(
    (sum, input) => sum + (input.scriptKind === 'p2wpkh' ? 109 : 66),
    0
  );
  const weight = strippedBytes * 4 + 2 + vaultWitnessBytes + buyerWitnessBytes;
  if (weight > MAINNET_TX_WEIGHT_LIMIT) {
    throw new CommunityPurchaseError(
      'sale-transaction-too-large',
      'This offer needs too many funding inputs.',
      409
    );
  }
  return Math.ceil(weight / 4);
}

async function verifiedFundingCandidates(args: {
  outputs: OrdOutputInfo[];
  expectedScript: string;
  fetchTxOut: typeof getTxOut;
}): Promise<CommunityVaultSaleBuyerInputV1[]> {
  const clean = args.outputs
    .filter(
      output =>
        !output.spent &&
        output.confirmations >= 1 &&
        output.inscriptionIds.length === 0 &&
        output.runeIds.length === 0 &&
        output.scriptPubKeyHex === args.expectedScript
    )
    .slice(0, MAX_INPUTS);
  const checked = await Promise.all(
    clean.map(async output => {
      const { txid, vout } = parseOutpoint(output.outpoint);
      const txout = await args.fetchTxOut(txid, vout);
      if (
        !txout ||
        txout.confirmations < 1 ||
        txout.scriptPubKey.hex.toLowerCase() !== args.expectedScript ||
        btcToSats(txout.value) !== output.valueSats
      )
        return null;
      const scriptKind = /^0014[0-9a-f]{40}$/u.test(args.expectedScript)
        ? 'p2wpkh'
        : /^5120[0-9a-f]{64}$/u.test(args.expectedScript)
          ? 'p2tr'
          : null;
      if (!scriptKind) return null;
      return {
        txid,
        vout,
        valueSats: output.valueSats,
        scriptPubKeyHex: args.expectedScript,
        sequence: RBF_SEQUENCE,
        scriptKind,
        sighashType: scriptKind === 'p2wpkh' ? (1 as const) : (0 as const),
      };
    })
  );
  return checked.filter((item): item is CommunityVaultSaleBuyerInputV1 => item !== null);
}

async function exactTxOut(outpoint: string, fetchTxOut: typeof getTxOut): Promise<TxOut> {
  const { txid, vout } = parseOutpoint(outpoint);
  const output = await fetchTxOut(txid, vout);
  if (!output)
    throw new CommunityPurchaseError('output-spent', 'The required output is already spent.', 409);
  return output;
}

function outputScript(value: string): string {
  try {
    return Buffer.from(address.toOutputScript(value, networks.bitcoin)).toString('hex');
  } catch {
    throw new CommunityPurchaseError(
      'mainnet-address-invalid',
      'Drey returned an invalid mainnet address.',
      409
    );
  }
}

function parseOutpoint(outpoint: string): { txid: string; vout: number } {
  const match = /^([0-9a-f]{64}):((?:0|[1-9][0-9]*))$/iu.exec(outpoint);
  if (!match)
    throw new CommunityPurchaseError('outpoint-invalid', 'An output reference is invalid.', 409);
  return { txid: match[1]!.toLowerCase(), vout: Number(match[2]) };
}

function parseSatpointOffset(satpoint: string): bigint {
  const match = /^[0-9a-f]{64}:(?:0|[1-9][0-9]*):((?:0|[1-9][0-9]*))$/iu.exec(satpoint);
  if (!match)
    throw new CommunityPurchaseError('satpoint-invalid', 'The OMB satpoint is invalid.', 409);
  return BigInt(match[1]!);
}

function btcToSats(value: number): string {
  const sats = Math.round(value * 100_000_000);
  if (!Number.isSafeInteger(sats) || sats < 0 || Math.abs(value * 100_000_000 - sats) > 0.001) {
    throw new CommunityPurchaseError(
      'bitcoin-value-invalid',
      'Bitcoin Core returned an invalid value.',
      503
    );
  }
  return String(sats);
}

function buyerId(ordAddress: string): string {
  return `buyer-${createHash('sha256').update(ordAddress).digest('hex').slice(0, 24)}`;
}

function feeForVsize(vsize: number, feeRateSatPerVb: number): bigint {
  return BigInt(Math.ceil(vsize * feeRateSatPerVb));
}

function compactSizeBytes(value: number): number {
  if (value < 0xfd) return 1;
  if (value <= 0xffff) return 3;
  if (value <= 0xffff_ffff) return 5;
  return 9;
}
