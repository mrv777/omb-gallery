import 'server-only';

import { address, networks } from 'bitcoinjs-lib';
import {
  constructCommunityVaultPositionTransferPsbt,
  createCommunityVaultPositionTransferPlan,
} from '@drey/core/domain/community-vault/position-transfer';
import type {
  CommunityVaultPositionTransferBuyerV1,
  CommunityVaultPositionTransferPlanV1,
  CommunityVaultPositionTransferPreflightV1,
  CommunityVaultPositionTransferSellerAuthorizationV1,
} from '@drey/core/domain/community-vault/position-transfer-contracts';
import type { CommunityVaultPolicyV1 } from '@drey/core/domain/community-vault/contracts';
import type { CommunityVaultSaleBuyerInputV1 } from '@drey/core/domain/community-vault/sale-contracts';
import { scriptDustSats } from '@drey/core/domain/transactions/fees';
import { estimateFeeRateSatPerVb, getBlockchainInfo, getTxOut, type TxOut } from '@/lib/bitcoind';
import {
  fetchAddressCardinalOutputs,
  fetchInscriptionDetail,
  fetchOutputsBatch,
  type OrdOutputInfo,
} from '@/lib/ord';
import { CommunityPurchaseError } from './store';
import { installPublicPolicyCrypto } from './dreyCrypto';

const MAX_INPUTS = 499;
const RBF_SEQUENCE = 0xffff_fffd;
const MAINNET_TX_WEIGHT_LIMIT = 400_000;

export type PositionTransferOfferDependencies = {
  fetchAddressOutputs: typeof fetchAddressCardinalOutputs;
  fetchOutputs: typeof fetchOutputsBatch;
  fetchInscription: typeof fetchInscriptionDetail;
  fetchTxOut: typeof getTxOut;
  getChainInfo: typeof getBlockchainInfo;
  estimateFeeRate: typeof estimateFeeRateSatPerVb;
  nowMs(): number;
};

const dependencies: PositionTransferOfferDependencies = {
  fetchAddressOutputs: fetchAddressCardinalOutputs,
  fetchOutputs: fetchOutputsBatch,
  fetchInscription: fetchInscriptionDetail,
  fetchTxOut: getTxOut,
  getChainInfo: getBlockchainInfo,
  estimateFeeRate: estimateFeeRateSatPerVb,
  nowMs: Date.now,
};

export async function prepareCommunityPositionTransfer(args: {
  campaignId: string;
  inscriptionId: string;
  currentOutpoint: string;
  currentPolicy: CommunityVaultPolicyV1;
  nextPolicy: CommunityVaultPolicyV1;
  transferId: string;
  sellerOwnerId: string;
  buyer: CommunityVaultPositionTransferBuyerV1;
  sellerPriceSats: string;
  expiresAtMs: string;
  sellerAuthorization: {
    payload: CommunityVaultPositionTransferSellerAuthorizationV1;
    signature: string;
  };
  deps?: Partial<PositionTransferOfferDependencies>;
}): Promise<{
  plan: CommunityVaultPositionTransferPlanV1;
  preflight: CommunityVaultPositionTransferPreflightV1;
  signingPsbtHex: string;
}> {
  installPublicPolicyCrypto();
  const deps = { ...dependencies, ...args.deps };
  const paymentScript = outputScript(args.buyer.payoutAddress);
  if (paymentScript !== args.buyer.payoutScriptPubKeyHex) {
    throw new CommunityPurchaseError(
      'buyer-address-changed',
      'The buyer payment address changed.',
      409
    );
  }
  const [asset, inscription, outputs, feeRateSatPerVb] = await Promise.all([
    exactTxOut(args.currentOutpoint, deps.fetchTxOut),
    deps.fetchInscription(args.inscriptionId),
    deps.fetchAddressOutputs(args.buyer.payoutAddress),
    deps.estimateFeeRate(),
  ]);
  if (
    asset.confirmations < 1 ||
    asset.scriptPubKey.hex.toLowerCase() !== args.currentPolicy.scriptPubKeyHex ||
    inscription.output !== args.currentOutpoint ||
    !inscription.satpoint?.startsWith(`${args.currentOutpoint}:`)
  ) {
    throw new CommunityPurchaseError(
      'vault-output-changed',
      'The held OMB changed before the transfer could be prepared.',
      409
    );
  }
  const inscriptionOffset = parseSatpointOffset(inscription.satpoint);
  const vaultValueSats = btcToSats(asset.value);
  if (inscriptionOffset >= BigInt(vaultValueSats)) {
    throw new CommunityPurchaseError('ordinal-route-invalid', 'The OMB satpoint is invalid.', 409);
  }
  const candidates = await verifiedFundingCandidates({
    outputs,
    expectedScript: paymentScript,
    fetchTxOut: deps.fetchTxOut,
  });
  const seller = args.currentPolicy.owners.find(owner => owner.ownerId === args.sellerOwnerId);
  if (!seller)
    throw new CommunityPurchaseError('seller-missing', 'The seller is no longer an owner.', 409);
  const selected = selectPositionTransferFunding({
    policy: args.currentPolicy,
    candidates,
    sellerPriceSats: args.sellerPriceSats,
    nextVaultScriptPubKeyHex: args.nextPolicy.scriptPubKeyHex,
    sellerPayoutScriptPubKeyHex: seller.payoutScriptPubKeyHex,
    changeScriptPubKeyHex: paymentScript,
    feeRateSatPerVb,
  });
  const nowMs = deps.nowMs();
  const plan = createCommunityVaultPositionTransferPlan({
    currentPolicy: args.currentPolicy,
    nextPolicy: args.nextPolicy,
    transferId: args.transferId,
    vaultOutpoint: parseOutpoint(args.currentOutpoint),
    vaultValueSats,
    inscriptionInputOffsetSats: inscriptionOffset.toString(),
    postageSats: (BigInt(vaultValueSats) - inscriptionOffset).toString(),
    sellerOwnerId: args.sellerOwnerId,
    buyer: args.buyer,
    sellerPriceSats: args.sellerPriceSats,
    settlementFeeSats: selected.feeSats,
    buyerInputs: selected.inputs,
    buyerChange: selected.changeSats
      ? { valueSats: selected.changeSats, scriptPubKeyHex: paymentScript }
      : null,
    createdAtMs: String(nowMs),
    expiresAtMs: args.expiresAtMs,
    sellerAuthorization: args.sellerAuthorization,
  });
  const preflight = await refreshCommunityPositionTransferPreflight({
    currentPolicy: args.currentPolicy,
    plan,
    deps,
  });
  return {
    plan,
    preflight,
    signingPsbtHex: constructCommunityVaultPositionTransferPsbt(args.currentPolicy, plan),
  };
}

export async function refreshCommunityPositionTransferPreflight(args: {
  currentPolicy: CommunityVaultPolicyV1;
  plan: CommunityVaultPositionTransferPlanV1;
  deps?: Partial<PositionTransferOfferDependencies>;
}): Promise<CommunityVaultPositionTransferPreflightV1> {
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
    const inscriptions = inputIndex === 0 ? [args.currentPolicy.inscriptionId] : [];
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
      JSON.stringify(ordOutput.inscriptionIds) !== JSON.stringify(inscriptions) ||
      ordOutput.runeIds.length > 0
    ) {
      throw new CommunityPurchaseError(
        'position-transfer-funds-changed',
        inputIndex === 0
          ? 'The held OMB changed. This transfer cannot continue.'
          : 'The buyer funds moved or are no longer clean. This transfer is closed.',
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
      inscriptionIds: inscriptions,
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

export function selectPositionTransferFunding(args: {
  policy: CommunityVaultPolicyV1;
  candidates: CommunityVaultSaleBuyerInputV1[];
  sellerPriceSats: string;
  nextVaultScriptPubKeyHex: string;
  sellerPayoutScriptPubKeyHex: string;
  changeScriptPubKeyHex: string;
  feeRateSatPerVb: number;
}): { inputs: CommunityVaultSaleBuyerInputV1[]; feeSats: string; changeSats: string | null } {
  const price = BigInt(args.sellerPriceSats);
  if (price <= 0n || !Number.isFinite(args.feeRateSatPerVb) || args.feeRateSatPerVb < 1) {
    throw new CommunityPurchaseError('transfer-price-invalid', 'The price or fee rate is invalid.');
  }
  const candidates = [...args.candidates]
    .toSorted((left, right) => {
      const order = BigInt(right.valueSats) - BigInt(left.valueSats);
      return order > 0n
        ? 1
        : order < 0n
          ? -1
          : `${left.txid}:${left.vout}`.localeCompare(`${right.txid}:${right.vout}`);
    })
    .slice(0, MAX_INPUTS);
  const selected: CommunityVaultSaleBuyerInputV1[] = [];
  let total = 0n;
  for (const candidate of candidates) {
    selected.push(candidate);
    total += BigInt(candidate.valueSats);
    const withChange = estimatePositionTransferVsize({
      ...args,
      buyerInputs: selected,
      includeChange: true,
    });
    const withChangeFee = feeForVsize(withChange, args.feeRateSatPerVb);
    const change = total - price - withChangeFee;
    if (change >= scriptDustSats(args.changeScriptPubKeyHex)) {
      return { inputs: selected, feeSats: withChangeFee.toString(), changeSats: change.toString() };
    }
    const withoutChange = estimatePositionTransferVsize({
      ...args,
      buyerInputs: selected,
      includeChange: false,
    });
    const withoutChangeFee = feeForVsize(withoutChange, args.feeRateSatPerVb);
    const remainder = total - price;
    if (
      remainder >= withoutChangeFee &&
      remainder < withoutChangeFee + scriptDustSats(args.changeScriptPubKeyHex)
    ) {
      return { inputs: selected, feeSats: remainder.toString(), changeSats: null };
    }
  }
  throw new CommunityPurchaseError(
    'transfer-funds-insufficient',
    'Drey does not have enough confirmed, clean BTC for the price and network fee.',
    409
  );
}

function estimatePositionTransferVsize(args: {
  policy: CommunityVaultPolicyV1;
  buyerInputs: CommunityVaultSaleBuyerInputV1[];
  nextVaultScriptPubKeyHex: string;
  sellerPayoutScriptPubKeyHex: string;
  changeScriptPubKeyHex: string;
  includeChange: boolean;
}): number {
  const scripts = [
    args.nextVaultScriptPubKeyHex,
    args.sellerPayoutScriptPubKeyHex,
    ...(args.includeChange ? [args.changeScriptPubKeyHex] : []),
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
    69 * 65 +
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
      'transfer-too-large',
      'This transfer needs too many funding inputs.',
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
        ? ('p2wpkh' as const)
        : /^5120[0-9a-f]{64}$/u.test(args.expectedScript)
          ? ('p2tr' as const)
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
    throw new CommunityPurchaseError('output-spent', 'The required output is spent.', 409);
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

function feeForVsize(vsize: number, feeRateSatPerVb: number): bigint {
  return BigInt(Math.ceil(vsize * feeRateSatPerVb));
}

function compactSizeBytes(value: number): number {
  if (value < 0xfd) return 1;
  if (value <= 0xffff) return 3;
  if (value <= 0xffff_ffff) return 5;
  return 9;
}
