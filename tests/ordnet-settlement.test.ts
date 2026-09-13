import { describe, expect, it } from 'vitest';
import { detectOrdNetSettlement } from '../scripts/lib/ord-net-settlement';
import { detectMarketplace, type FingerprintTx } from '../src/lib/marketplaceFingerprint';
import fixtures from './chain-fixtures/ordnet-settlements.json';

const txs: Record<string, FingerprintTx> = fixtures.txs;
const offer = fixtures.offers[0];
const bulk = fixtures.bulk[0];

describe('ord.net executed settlement fingerprints', () => {
  it.each(fixtures.offers)('extracts gross offer price for #$inscription_number', event => {
    expect(detectOrdNetSettlement(txs[event.txid], event)).toMatchObject({
      shape: 'offer-v2',
      priceSats: event.priceSats,
      outputIndex: 0,
    });
  });

  it.each(fixtures.bulk)(
    'recognizes bulk item #$inscription_number without inventing a price',
    event => {
      expect(detectOrdNetSettlement(txs[event.txid], event)).toMatchObject({
        shape: 'bulk-listing-acp',
        priceSats: null,
        outputIndex: Number(event.new_satpoint.split(':')[1]),
      });
    }
  );

  it('proves why the old marker-only detector missed the reported offers', () => {
    expect(detectMarketplace(txs[fixtures.offers[0].txid])).toBeNull();
    expect(detectMarketplace(txs[fixtures.offers[1].txid])).toBeNull();
  });

  it.each(fixtures.negatives)('rejects real transfer/loan/delivery counterexample %s', txid => {
    const tx = txs[txid];
    for (let i = 0; i < tx.vout.length; i++) {
      expect(
        detectOrdNetSettlement(tx, {
          txid,
          new_satpoint: `${txid}:${i}`,
          old_owner: tx.vin[0].prevout?.scriptPubKey?.address ?? null,
          new_owner: tx.vout[i].scriptPubKey?.address ?? null,
        })
      ).toBeNull();
    }
  });

  it.each([
    'missing-service-signature',
    'foreign-service-key',
    'changed-metadata',
    'wrong-preimage',
    'wrong-buyer',
    'wrong-funding',
    'no-payout',
    'different-owner',
    'wrong-control-block',
    'overflow-price',
    'trailing-script',
  ])('rejects an offer with %s', change => {
    const tx = structuredClone(txs[offer.txid]);
    const event = { ...offer };
    const witness = tx.vin[1].txinwitness!;
    if (change === 'missing-service-signature') witness[0] = '';
    if (change === 'foreign-service-key')
      witness[5] = witness[5].replace(
        '8efe604eb9dfa01d33404656dafa2aefea83660f01fa04ae0686a6110957b86f',
        '11'.repeat(32)
      );
    if (change === 'changed-metadata') witness[5] = witness[5].replace('6f66666572', '6f66666573');
    if (change === 'wrong-preimage') witness[4] = '00'.repeat(32);
    if (change === 'wrong-buyer') tx.vout[0].scriptPubKey!.hex = '5120' + '00'.repeat(32);
    if (change === 'wrong-funding') tx.vin[1].prevout!.value! += 0.001;
    if (change === 'no-payout') tx.vout[1].value = 0.00000333;
    if (change === 'different-owner') event.old_owner = 'different-seller';
    if (change === 'wrong-control-block') witness[6] = 'c0' + '00'.repeat(32);
    if (change === 'overflow-price')
      witness[5] = witness[5].replace('509e1b0000000000', 'ffffffffffffffff');
    if (change === 'trailing-script') witness[5] += '51';
    expect(detectOrdNetSettlement(tx, event)).toBeNull();
  });

  it.each([
    null,
    'not-an-outpoint',
    `${'0'.repeat(64)}:0`,
    `${offer.txid}:99`,
    `${offer.txid}:0:999`,
  ])('rejects missing or unrelated inscription destination %s', new_satpoint => {
    expect(detectOrdNetSettlement(txs[offer.txid], { ...offer, new_satpoint })).toBeNull();
  });

  it('accepts a sat offset inside the verified inscription output', () => {
    expect(
      detectOrdNetSettlement(txs[offer.txid], {
        ...offer,
        new_satpoint: `${offer.txid}:0:1`,
      })?.priceSats
    ).toBe(1_810_000);
  });

  it.each([
    'wrong-sighash',
    'no-service',
    'ambiguous-input',
    'missing-prevout',
    'no-payment',
    'no-marker',
  ])('rejects a bulk buy with %s', change => {
    const tx = structuredClone(txs[bulk.txid]);
    if (change === 'wrong-sighash') tx.vin[3].txinwitness![1] = '00'.repeat(64) + '01';
    if (change === 'no-service') tx.vin[3].txinwitness![0] = '';
    if (change === 'ambiguous-input') tx.vin[0].prevout!.value! += 0.00000001;
    if (change === 'missing-prevout') delete tx.vin[0].prevout;
    if (change === 'no-payment') tx.vout[3].value = 0.000009;
    if (change === 'no-marker') {
      for (const out of tx.vout)
        if (out.scriptPubKey?.address?.endsWith('rdnet')) out.scriptPubKey.address = 'other';
    }
    expect(detectOrdNetSettlement(tx, bulk)).toBeNull();
  });

  it('does not classify a buyer change or marker output as an inscription sale', () => {
    const tx = txs[bulk.txid];
    for (const i of [0, 7, 10]) {
      expect(
        detectOrdNetSettlement(tx, {
          ...bulk,
          new_satpoint: `${bulk.txid}:${i}`,
          new_owner: tx.vout[i].scriptPubKey!.address!,
        })
      ).toBeNull();
    }
  });
});
