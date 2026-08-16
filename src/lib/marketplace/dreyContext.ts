import 'server-only';

import { createHash } from 'node:crypto';
import { Psbt, Transaction, address, networks } from 'bitcoinjs-lib';
import type { MarketplaceContext, MarketplaceListing, PurchasePsbtToSign } from './types';

const CONTEXT_TTL_MS = 5 * 60 * 1000;
type ContextListing = Pick<MarketplaceListing, 'listing_id' | 'inscription_id' | 'price_sats'>;

export class DreyMarketplaceContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DreyMarketplaceContractError';
  }
}

type PsbtFacts = { selectedInputIndexes: number[]; buyerDebitSats: number };

export function withOrdnetDreyContext(args: {
  item: PurchasePsbtToSign;
  intentId: number;
  listing: ContextListing;
  buyerOrdAddr: string;
  buyerPayAddr: string | null;
  purchaseAnchorUtxoId: string;
  expectedTxids: string[];
  createdAt?: number;
}): PurchasePsbtToSign {
  const facts = inspectBuyerPsbt(args.item, args.buyerOrdAddr, args.buyerPayAddr);
  const expectedTxids = args.expectedTxids.map(assertTxid);
  if (expectedTxids.length < 2) {
    throw new DreyMarketplaceContractError(
      'ORD.NET preflight omitted expected settlement or transfer txids.'
    );
  }
  return {
    ...args.item,
    marketplace_context: commonContext({
      marketplaceId: 'ordnet',
      templateVersion: 'omb-wiki-ordnet-buy-v1',
      action: 'buy',
      intentId: args.intentId,
      listing: args.listing,
      buyerOrdAddr: args.buyerOrdAddr,
      facts,
      step: 1,
      stepCount: 1,
      createdAt: args.createdAt,
      identifiers: {
        purchaseAnchorUtxoId: requireIdentifier(args.purchaseAnchorUtxoId, 'purchase anchor'),
      },
      expectedTxids,
    }),
  };
}

export function withSatflowDreyContexts(args: {
  psbts: PurchasePsbtToSign[];
  intentId: number;
  listing: ContextListing;
  buyerOrdAddr: string;
  buyerPayAddr: string | null;
  stage: 'payment-prep' | 'purchase' | 'bulk';
  preflightJson: string;
  createdAt?: number;
}): PurchasePsbtToSign[] {
  if (args.stage === 'bulk' || args.psbts.length !== 1) {
    throw new DreyMarketplaceContractError(
      'Drey does not support this Satflow transaction shape. Use a single-inscription direct purchase or one payment-preparation step followed by one purchase step.'
    );
  }
  const step =
    args.stage === 'payment-prep' ? 1 : satflowHasPreparation(args.preflightJson) ? 2 : 1;
  const stepCount = args.stage === 'payment-prep' || step === 2 ? 2 : 1;
  const item = args.psbts[0]!;
  const facts = inspectBuyerPsbt(
    item,
    args.buyerOrdAddr,
    args.buyerPayAddr,
    args.stage !== 'payment-prep'
  );
  return [
    {
      ...item,
      marketplace_context: commonContext({
        marketplaceId: 'satflow',
        templateVersion: 'omb-wiki-satflow-secure-buy-v1',
        action: 'secure_buy',
        intentId: args.intentId,
        listing: args.listing,
        buyerOrdAddr: args.buyerOrdAddr,
        facts,
        step,
        stepCount,
        stage: args.stage,
        createdAt: args.createdAt,
        revision: sha256(args.preflightJson),
      }),
    },
  ];
}

export function inspectBuyerPsbt(
  item: PurchasePsbtToSign,
  buyerOrdAddr: string,
  buyerPayAddr: string | null,
  requireDestination = true
): PsbtFacts {
  if (!item.sign_inputs || Object.keys(item.sign_inputs).length === 0) {
    throw new DreyMarketplaceContractError(
      'Drey requires explicit signing indexes from the marketplace preflight.'
    );
  }
  let psbt: Psbt;
  try {
    psbt = Psbt.fromBase64(item.psbt, { network: networks.bitcoin });
  } catch {
    throw new DreyMarketplaceContractError('Marketplace returned a malformed PSBT.');
  }
  const allowed = new Set(
    [buyerOrdAddr, buyerPayAddr].filter((value): value is string => Boolean(value))
  );
  const selected = new Set<number>();
  let selectedTotal = 0;
  const ownerScripts = new Map<string, Buffer>();
  for (const [owner, indexes] of Object.entries(item.sign_inputs)) {
    if (!allowed.has(owner))
      throw new DreyMarketplaceContractError(
        'PSBT signing address does not match the buyer session.'
      );
    let ownerScript: Buffer;
    try {
      ownerScript = address.toOutputScript(owner, networks.bitcoin);
    } catch {
      throw new DreyMarketplaceContractError(
        'Buyer session contains an invalid mainnet signing address.'
      );
    }
    ownerScripts.set(owner, ownerScript);
    for (const index of indexes) {
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= psbt.inputCount ||
        selected.has(index)
      ) {
        throw new DreyMarketplaceContractError(
          'Marketplace returned invalid or duplicate signing indexes.'
        );
      }
      const input = inputUtxo(psbt, index);
      if (!input.script.equals(ownerScript)) {
        throw new DreyMarketplaceContractError(
          'PSBT signing index is not owned by its declared buyer address.'
        );
      }
      selected.add(index);
      selectedTotal += input.value;
    }
  }
  if (selected.size === 0)
    throw new DreyMarketplaceContractError('Marketplace selected no buyer inputs.');

  let destinationScript: Buffer;
  try {
    destinationScript = address.toOutputScript(buyerOrdAddr, networks.bitcoin);
  } catch {
    throw new DreyMarketplaceContractError(
      'Buyer Ordinals destination is not a valid mainnet address.'
    );
  }
  if (
    requireDestination &&
    !psbt.txOutputs.some(output => output.script.equals(destinationScript))
  ) {
    throw new DreyMarketplaceContractError(
      'PSBT does not pay the inscription to the buyer Ordinals address.'
    );
  }
  const signingScripts = Array.from(ownerScripts.values());
  const walletReturns = psbt.txOutputs.reduce(
    (sum, output) =>
      sum + (signingScripts.some(script => output.script.equals(script)) ? output.value : 0),
    0
  );
  const buyerDebitSats = selectedTotal - walletReturns;
  if (!Number.isSafeInteger(buyerDebitSats) || buyerDebitSats <= 0) {
    throw new DreyMarketplaceContractError('PSBT buyer debit is invalid or non-positive.');
  }
  return {
    selectedInputIndexes: Array.from(selected).toSorted((a, b) => a - b),
    buyerDebitSats,
  };
}

function commonContext(args: {
  marketplaceId: 'ordnet' | 'satflow';
  templateVersion: string;
  action: 'buy' | 'secure_buy';
  intentId: number;
  listing: ContextListing;
  buyerOrdAddr: string;
  facts: PsbtFacts;
  step: number;
  stepCount: number;
  stage?: 'payment-prep' | 'purchase';
  createdAt?: number;
  identifiers?: { purchaseAnchorUtxoId: string };
  revision?: string;
  expectedTxids?: string[];
}): MarketplaceContext {
  const now = args.createdAt ?? Date.now();
  return {
    version: 1,
    marketplaceId: args.marketplaceId,
    templateVersion: args.templateVersion,
    action: args.action,
    role: 'buyer',
    assetKind: 'inscription',
    workflowId: `omb-wiki-buy-${args.intentId}`,
    step: args.step,
    stepCount: args.stepCount,
    ...(args.stage ? { stage: args.stage } : {}),
    identifiers: {
      listingId: requireIdentifier(args.listing.listing_id, 'listing id'),
      inscriptionId: requireIdentifier(args.listing.inscription_id, 'inscription id'),
      ...(args.identifiers ?? {}),
    },
    economics: {
      priceSats: String(args.listing.price_sats),
      totalSats: String(args.facts.buyerDebitSats),
      buyerDebitSats: String(args.facts.buyerDebitSats),
      assetDestination: args.buyerOrdAddr,
    },
    selectedInputIndexes: args.facts.selectedInputIndexes,
    ...(args.revision ? { revision: args.revision } : {}),
    ...(args.expectedTxids ? { expectedTxids: args.expectedTxids } : {}),
    expiresAt: now + CONTEXT_TTL_MS,
    broadcaster: 'site',
  };
}

function inputUtxo(psbt: Psbt, index: number): { script: Buffer; value: number } {
  const data = psbt.data.inputs[index];
  if (!data) throw new DreyMarketplaceContractError('PSBT signing index has no input data.');
  if (data.witnessUtxo) return data.witnessUtxo;
  if (!data.nonWitnessUtxo)
    throw new DreyMarketplaceContractError(
      'PSBT buyer input is missing its UTXO value and script.'
    );
  try {
    const prior = Transaction.fromBuffer(data.nonWitnessUtxo);
    const vout = psbt.txInputs[index]?.index;
    const output = vout == null ? undefined : prior.outs[vout];
    if (!output) throw new Error('missing output');
    return output;
  } catch {
    throw new DreyMarketplaceContractError(
      'PSBT buyer input contains an invalid previous transaction.'
    );
  }
}

function satflowHasPreparation(preflightJson: string): boolean {
  try {
    const parsed = JSON.parse(preflightJson) as { signedPaymentPrepPSBTs?: unknown };
    return (
      Array.isArray(parsed.signedPaymentPrepPSBTs) && parsed.signedPaymentPrepPSBTs.length === 1
    );
  } catch {
    return false;
  }
}

function requireIdentifier(value: string, label: string): string {
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > 256) throw new DreyMarketplaceContractError(`Invalid ${label}.`);
  return cleaned;
}

function assertTxid(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value))
    throw new DreyMarketplaceContractError('ORD.NET returned an invalid expected txid.');
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
