import 'server-only';

import { createHash } from 'node:crypto';
import { verifyOrdnetSaleScriptPath } from '@drey/core/domain/marketplaces/ordnet-script-path';
import { NETWORK, SigHash, Transaction } from '@scure/btc-signer';
import { Psbt } from 'bitcoinjs-lib';
import type { PurchasePsbtToSign } from './types';

export class ListingPsbtValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ListingPsbtValidationError';
  }
}

export type ValidatedListingPreview = {
  postageSats: number;
  sellerProceedsSats: number;
  marketplaceFeeSats: number;
  passthroughOutpoint: string;
};

type ListingStep = PurchasePsbtToSign & {
  public_key?: string;
  publicKey?: string;
};

export function validateOrdnetListingPreflight(args: {
  steps: ListingStep[];
  currentOutpoint: string;
  sellerOrdAddress: string;
  sellerPayAddress: string;
  sellerPublicKey?: string | null;
  priceSats: number;
}): ValidatedListingPreview {
  if (args.steps.length !== 3) {
    throw new ListingPsbtValidationError(
      'ORD.NET preflight must contain escrow, settlement, and recovery PSBTs.'
    );
  }
  if (!Number.isSafeInteger(args.priceSats) || args.priceSats <= 0) {
    throw new ListingPsbtValidationError('Listing price is invalid.');
  }
  const [escrowStep, settlementStep, recoveryStep] = args.steps;
  const escrow = parsePsbt(escrowStep!.psbt);
  const settlement = parsePsbt(settlementStep!.psbt);
  const recovery = parsePsbt(recoveryStep!.psbt);
  const escrowIndexes = selectedIndexes(escrowStep!, escrow, args.sellerOrdAddress);
  const settlementIndexes = selectedIndexes(settlementStep!, settlement, args.sellerOrdAddress);
  const recoveryIndexes = selectedIndexes(recoveryStep!, recovery, args.sellerOrdAddress);
  if (
    escrowIndexes.length !== 1 ||
    settlementIndexes.length !== 1 ||
    recoveryIndexes.length !== 1
  ) {
    throw new ListingPsbtValidationError('Each listing PSBT must select exactly one seller input.');
  }

  const escrowIndex = escrowIndexes[0]!;
  const settlementIndex = settlementIndexes[0]!;
  const recoveryIndex = recoveryIndexes[0]!;
  if (
    escrow.inputsLength !== 1 ||
    settlement.inputsLength !== 1 ||
    recovery.inputsLength !== 1 ||
    escrowIndex !== 0 ||
    settlementIndex !== 0 ||
    recoveryIndex !== 0
  ) {
    throw new ListingPsbtValidationError(
      'Listing preflight contains unexpected inputs or signing positions.'
    );
  }
  assertOutpoint(escrow.getInput(escrowIndex), args.currentOutpoint, 'escrow');
  assertSighash(escrow.getInput(escrowIndex).sighashType, SigHash.DEFAULT, 'escrow');
  assertSighash(
    settlement.getInput(settlementIndex).sighashType,
    SigHash.SINGLE_ANYONECANPAY,
    'settlement'
  );
  assertSighash(recovery.getInput(recoveryIndex).sighashType, SigHash.ALL, 'recovery');

  const escrowTxid = escrow.id;
  const settlementOutpoint = inputOutpoint(settlement.getInput(settlementIndex));
  const recoveryOutpoint = inputOutpoint(recovery.getInput(recoveryIndex));
  if (
    settlementOutpoint.txid !== escrowTxid ||
    recoveryOutpoint.txid !== escrowTxid ||
    settlementOutpoint.vout !== recoveryOutpoint.vout ||
    settlementOutpoint.vout !== 0
  ) {
    throw new ListingPsbtValidationError(
      'Settlement and recovery do not spend the same escrow transaction output.'
    );
  }
  const passthrough = escrow.getOutput(settlementOutpoint.vout);
  const settlementPrevout = settlement.getInput(settlementIndex).witnessUtxo;
  const recoveryPrevout = recovery.getInput(recoveryIndex).witnessUtxo;
  if (
    !passthrough?.script ||
    passthrough.amount === undefined ||
    !settlementPrevout ||
    !recoveryPrevout ||
    passthrough.amount !== settlementPrevout.amount ||
    passthrough.amount !== recoveryPrevout.amount ||
    !bytesEqual(passthrough.script, settlementPrevout.script) ||
    !bytesEqual(passthrough.script, recoveryPrevout.script)
  ) {
    throw new ListingPsbtValidationError(
      'Escrow passthrough output does not match the settlement and recovery inputs.'
    );
  }

  const publicKey = normalizeXOnlyPublicKey(
    args.sellerPublicKey ?? settlementStep!.public_key ?? settlementStep!.publicKey
  );
  try {
    verifyOrdnetSaleScriptPath(settlement, settlementIndex, publicKey);
  } catch {
    throw new ListingPsbtValidationError(
      'ORD.NET settlement does not use the pinned seller/marketplace Taproot script.'
    );
  }

  const settlementOutput = settlement.getOutput(settlementIndex);
  if (!settlementOutput || settlementOutput.amount === undefined) {
    throw new ListingPsbtValidationError(
      'ORD.NET settlement has no output corresponding to its SINGLE input.'
    );
  }
  if (outputAddress(settlement, settlementIndex) !== args.sellerPayAddress) {
    throw new ListingPsbtValidationError('Settlement payout address differs from the session.');
  }
  const sellerProceeds = safeNumber(settlementOutput.amount, 'seller proceeds');
  if (sellerProceeds <= 0 || sellerProceeds > args.priceSats) {
    throw new ListingPsbtValidationError(
      'Settlement seller proceeds are outside the listing price.'
    );
  }

  const recoveryDestination = recovery.getOutput(0);
  if (
    !recoveryDestination ||
    recoveryDestination.amount === undefined ||
    recoveryDestination.amount <= 0n ||
    outputAddress(recovery, 0) !== args.sellerOrdAddress
  ) {
    throw new ListingPsbtValidationError(
      'Recovery does not return the inscription at offset zero to the seller.'
    );
  }
  const postage = safeNumber(settlementPrevout.amount, 'inscription postage');
  return {
    postageSats: postage,
    sellerProceedsSats: sellerProceeds,
    marketplaceFeeSats: args.priceSats - sellerProceeds,
    passthroughOutpoint: `${escrowTxid}:${settlementOutpoint.vout}`,
  };
}

export function unsignedPsbtHash(psbtBase64: string): string {
  const tx = parsePsbt(psbtBase64);
  return createHash('sha256').update(tx.unsignedTx).digest('hex');
}

export function assertSignedPsbtPreservesPreflight(args: {
  unsignedPsbt: string;
  signedPsbt: string;
  selectedInputIndexes: number[];
}): void {
  const original = parseBitcoinJsPsbt(args.unsignedPsbt);
  const signed = parseBitcoinJsPsbt(args.signedPsbt);
  if (unsignedPsbtHash(args.unsignedPsbt) !== unsignedPsbtHash(args.signedPsbt)) {
    throw new ListingPsbtValidationError('Wallet changed the unsigned transaction.');
  }
  if (
    stable(original.data.globalMap) !== stable(signed.data.globalMap) ||
    stable(original.data.outputs) !== stable(signed.data.outputs) ||
    original.data.inputs.length !== signed.data.inputs.length
  ) {
    throw new ListingPsbtValidationError('Wallet changed immutable PSBT metadata.');
  }
  const selected = new Set(args.selectedInputIndexes);
  let addedSignature = false;
  for (let index = 0; index < original.data.inputs.length; index += 1) {
    const before = original.data.inputs[index]!;
    const after = signed.data.inputs[index]!;
    if (stable(withoutSignatures(before)) !== stable(withoutSignatures(after))) {
      throw new ListingPsbtValidationError('Wallet changed immutable PSBT input metadata.');
    }
    const changed = stable(signatureFields(before)) !== stable(signatureFields(after));
    if (changed && !selected.has(index)) {
      throw new ListingPsbtValidationError('Wallet signed an input that was not authorized.');
    }
    if (changed) addedSignature = true;
  }
  if (!addedSignature) {
    throw new ListingPsbtValidationError('Wallet did not add the expected listing signature.');
  }
}

function parsePsbt(psbtBase64: string): Transaction {
  try {
    return Transaction.fromPSBT(Buffer.from(psbtBase64, 'base64'), { lowR: true });
  } catch {
    throw new ListingPsbtValidationError('ORD.NET returned a malformed PSBT.');
  }
}

function parseBitcoinJsPsbt(psbtBase64: string): Psbt {
  try {
    return Psbt.fromBase64(psbtBase64);
  } catch {
    throw new ListingPsbtValidationError('Wallet returned a malformed PSBT.');
  }
}

function selectedIndexes(item: PurchasePsbtToSign, tx: Transaction, seller: string): number[] {
  if (!item.sign_inputs || Object.keys(item.sign_inputs).length !== 1) {
    throw new ListingPsbtValidationError('Listing step has no unambiguous signing instruction.');
  }
  const [owner, indexes] = Object.entries(item.sign_inputs)[0]!;
  if (owner !== seller) {
    throw new ListingPsbtValidationError(
      'Listing signing address differs from the seller session.'
    );
  }
  const unique = [...new Set(indexes)].toSorted((a, b) => a - b);
  if (
    unique.length !== indexes.length ||
    unique.some(index => !Number.isInteger(index) || index < 0 || index >= tx.inputsLength)
  ) {
    throw new ListingPsbtValidationError('Listing signing indexes are invalid or duplicated.');
  }
  return unique;
}

function assertOutpoint(
  input: ReturnType<Transaction['getInput']>,
  expected: string,
  label: string
): void {
  const actual = inputOutpoint(input);
  if (`${actual.txid}:${actual.vout}` !== expected.toLowerCase()) {
    throw new ListingPsbtValidationError(`${label} PSBT spends a stale inscription outpoint.`);
  }
}

function inputOutpoint(input: ReturnType<Transaction['getInput']>): { txid: string; vout: number } {
  if (!input.txid || input.index === undefined) {
    throw new ListingPsbtValidationError('Listing PSBT input has no outpoint.');
  }
  return {
    txid: Buffer.from(input.txid).reverse().toString('hex'),
    vout: input.index,
  };
}

function assertSighash(actual: number | undefined, expected: number, label: string): void {
  const normalized = actual ?? SigHash.DEFAULT;
  if (normalized !== expected) {
    throw new ListingPsbtValidationError(`${label} PSBT has an unsafe sighash.`);
  }
}

function normalizeXOnlyPublicKey(value: string | undefined | null): string {
  const key = value?.trim().toLowerCase() ?? '';
  if (/^[0-9a-f]{64}$/u.test(key)) return key;
  if (/^(02|03)[0-9a-f]{64}$/u.test(key)) return key.slice(2);
  throw new ListingPsbtValidationError('ORD.NET omitted the seller Taproot public key.');
}

function outputAddress(tx: Transaction, index: number): string | null {
  try {
    return tx.getOutputAddress(index, NETWORK) ?? null;
  } catch {
    return null;
  }
}

function safeNumber(value: bigint, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new ListingPsbtValidationError(`Invalid ${label}.`);
  }
  return number;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

const SIGNATURE_KEYS = new Set([
  'partialSig',
  'tapKeySig',
  'tapScriptSig',
  'finalScriptSig',
  'finalScriptWitness',
]);

function withoutSignatures(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SIGNATURE_KEYS.has(key)));
}

function signatureFields(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => SIGNATURE_KEYS.has(key)));
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (Buffer.isBuffer(item)) return { bytes: item.toString('hex') };
    if (item instanceof Uint8Array) return { bytes: Buffer.from(item).toString('hex') };
    if (typeof item === 'bigint') return { bigint: item.toString() };
    return item;
  });
}
