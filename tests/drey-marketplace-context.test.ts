import { describe, expect, it } from 'vitest';
import { Psbt, networks, payments } from 'bitcoinjs-lib';
import {
  DreyMarketplaceContractError,
  inspectBuyerPsbt,
  withOrdnetDreyContext,
  withSatflowDreyContexts,
} from '@/lib/marketplace/dreyContext';

const pay = payments.p2wpkh({ hash: Buffer.alloc(20, 1), network: networks.bitcoin });
const ord = payments.p2wpkh({ hash: Buffer.alloc(20, 2), network: networks.bitcoin });
const seller = payments.p2wpkh({ hash: Buffer.alloc(20, 3), network: networks.bitcoin });
const external = payments.p2wpkh({ hash: Buffer.alloc(20, 4), network: networks.bitcoin });

if (
  !pay.address ||
  !pay.output ||
  !ord.address ||
  !ord.output ||
  !seller.output ||
  !external.output
) {
  throw new Error('test addresses unavailable');
}

const listing = {
  listing_id: 'omb-listing-1',
  inscription_id: `${'a'.repeat(64)}i0`,
  price_sats: 100_000,
};

function purchasePsbt() {
  const psbt = new Psbt({ network: networks.bitcoin });
  psbt.addInput({
    hash: '11'.repeat(32),
    index: 0,
    witnessUtxo: { script: external.output!, value: 10_000 },
  });
  psbt.addInput({
    hash: '22'.repeat(32),
    index: 1,
    witnessUtxo: { script: pay.output!, value: 110_000 },
  });
  psbt.addOutput({ script: ord.output!, value: 10_000 });
  psbt.addOutput({ script: seller.output!, value: 100_000 });
  psbt.addOutput({ script: pay.output!, value: 9_000 });
  return psbt.toBase64();
}

describe('Drey OMB marketplace context', () => {
  it('derives exact buyer indexes and debit from the PSBT', () => {
    const facts = inspectBuyerPsbt(
      { psbt: purchasePsbt(), sign_inputs: { [pay.address!]: [1] } },
      ord.address!,
      pay.address!
    );
    expect(facts).toEqual({ selectedInputIndexes: [1], buyerDebitSats: 101_000 });
  });

  it('builds an ORD.NET site-broadcast context from validated facts', () => {
    const result = withOrdnetDreyContext({
      item: { psbt: purchasePsbt(), sign_inputs: { [pay.address!]: [1] } },
      intentId: 42,
      listing,
      buyerOrdAddr: ord.address!,
      buyerPayAddr: pay.address!,
      purchaseAnchorUtxoId: `${'9'.repeat(64)}:0`,
      expectedTxids: ['a'.repeat(64), 'b'.repeat(64)],
      createdAt: 1_000,
    });
    expect(result.marketplace_context).toMatchObject({
      marketplaceId: 'ordnet',
      templateVersion: 'omb-wiki-ordnet-buy-v1',
      workflowId: 'omb-wiki-buy-42',
      selectedInputIndexes: [1],
      economics: {
        priceSats: '100000',
        totalSats: '101000',
        buyerDebitSats: '101000',
        assetDestination: ord.address,
      },
      expiresAt: 301_000,
      broadcaster: 'site',
    });
  });

  it('rejects a sign index whose script belongs to another address', () => {
    expect(() =>
      inspectBuyerPsbt(
        { psbt: purchasePsbt(), sign_inputs: { [pay.address!]: [0] } },
        ord.address!,
        pay.address!
      )
    ).toThrow(DreyMarketplaceContractError);
  });

  it('uses one reviewed Satflow template across preparation and purchase steps', () => {
    const [result] = withSatflowDreyContexts({
      psbts: [{ psbt: purchasePsbt(), sign_inputs: { [pay.address!]: [1] } }],
      intentId: 7,
      listing,
      buyerOrdAddr: ord.address!,
      buyerPayAddr: pay.address!,
      stage: 'purchase',
      preflightJson: '{}',
      createdAt: 1_000,
    });
    expect(result?.marketplace_context).toMatchObject({
      marketplaceId: 'satflow',
      templateVersion: 'omb-wiki-satflow-secure-buy-v1',
      stage: 'purchase',
    });
  });

  it('rejects missing buyer destination and unsupported Satflow arrays', () => {
    const missingDestination = new Psbt({ network: networks.bitcoin })
      .addInput({
        hash: '33'.repeat(32),
        index: 0,
        witnessUtxo: { script: pay.output!, value: 20_000 },
      })
      .addOutput({ script: seller.output!, value: 19_000 })
      .toBase64();
    expect(() =>
      inspectBuyerPsbt(
        { psbt: missingDestination, sign_inputs: { [pay.address!]: [0] } },
        ord.address!,
        pay.address!
      )
    ).toThrow(/Ordinals address/);
    expect(() =>
      withSatflowDreyContexts({
        psbts: [
          { psbt: purchasePsbt(), sign_inputs: { [pay.address!]: [1] } },
          { psbt: purchasePsbt(), sign_inputs: { [pay.address!]: [1] } },
        ],
        intentId: 7,
        listing,
        buyerOrdAddr: ord.address!,
        buyerPayAddr: pay.address!,
        stage: 'purchase',
        preflightJson: '{}',
      })
    ).toThrow(/does not support this Satflow transaction shape/);
  });
});
