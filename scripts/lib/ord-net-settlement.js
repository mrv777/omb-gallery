// Shared by the live tick and historical repair. Chain fixtures and extraction
// rules: ONCHAIN_TAGGING.md §2.11.1. Never infer a sale from the royalty address.
const { createHash } = require('node:crypto');

const SERVICE_KEY = 'd2dc3222298e2a5f4e1c7d702fae2bcf7821cc0a095a478b95c62195b0df7398';
const OFFER_SIGNER_1 = '8efe604eb9dfa01d33404656dafa2aefea83660f01fa04ae0686a6110957b86f';
const OFFER_SIGNER_2 = '3e4cb29671c3b25fa0b23d902cd46102d1c158420e8e00daac552d23b013a7d7';
const FEE_ADDRESS = 'bc1pgkfga880836f5kp3m9vvya4m0whva80ddm58r7fyltzp9q8t08rs0rdnet';
const HEX32 = '[0-9a-f]{64}';
// OP_FALSE OP_IF "ordnet-offer/v2" <price LE64> <expiry LE64>
// <buyer script> <commitments> OP_ENDIF, followed by the executed acceptance
// leaf. The two mandatory service signatures distinguish this from a marker
// copied into an unrelated spend, funding transaction, or cancellation leaf.
const OFFER_LEAF = new RegExp(
  `^00630f6f72646e65742d6f666665722f763208([0-9a-f]{16})08[0-9a-f]{16}` +
    `(?:22(5120${HEX32})|16(0014[0-9a-f]{40}))20${HEX32}20${HEX32}` +
    `68a820(${HEX32})8820(${HEX32})ac20${SERVICE_KEY}ba519d` +
    `20${OFFER_SIGNER_1}ad20${OFFER_SIGNER_2}ac$`
);
const LISTING_LEAF = new RegExp(`^20(${HEX32})ac20${SERVICE_KEY}ba529c$`);
const SIG_DEFAULT = /^[0-9a-f]{128}$/;
const SIG_SINGLE_ACP = /^[0-9a-f]{128}83$/;

/** @param {number | undefined} btc @returns {number | null} */
function sats(btc) {
  if (typeof btc !== 'number' || !Number.isFinite(btc) || btc < 0) return null;
  const n = Math.round(btc * 1e8);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * @typedef {import('../../src/lib/marketplaceFingerprint').FingerprintTx} Tx
 * @typedef {{ txid: string, new_satpoint: string | null,
 *   old_owner: string | null, new_owner: string | null }} Event
 * @typedef {{ shape: 'offer-v2' | 'bulk-listing-acp', priceSats: number | null,
 *   inputIndex: number, outputIndex: number }} Settlement
 */

/**
 * Only classify the inscription's actual destination, not every event that
 * happens to share a transaction. new_satpoint may be an outpoint or satpoint.
 * @param {Tx} tx @param {Event} event @returns {Settlement | null}
 */
function detectOrdNetSettlement(tx, event) {
  if (!tx?.vin?.length || !tx?.vout?.length || !event.new_satpoint) return null;
  const point = /^([0-9a-f]{64}):(0|[1-9][0-9]*)(?::(0|[1-9][0-9]*))?$/.exec(event.new_satpoint);
  if (!point || point[1] !== event.txid) return null;
  const outputIndex = Number(point[2]);
  const output = tx.vout[outputIndex];
  const postage = sats(output?.value);
  if (
    postage == null ||
    postage <= 0 ||
    postage > 12_000 ||
    !event.new_owner ||
    output?.scriptPubKey?.address !== event.new_owner ||
    !event.old_owner ||
    event.old_owner === event.new_owner ||
    (point[3] != null && Number(point[3]) >= postage)
  )
    return null;

  if (tx.vin.length === 3 && tx.vout.length === 5 && outputIndex === 0) {
    const funding = tx.vin[1];
    const w = funding.txinwitness ?? funding.witness ?? [];
    const leaf = w.length === 7 ? OFFER_LEAF.exec(w[5]) : null;
    if (leaf && w.slice(0, 3).every(sig => SIG_DEFAULT.test(sig)) && w[3] === '') {
      const priceBig = Buffer.from(leaf[1], 'hex').readBigUInt64LE();
      const price = priceBig <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(priceBig) : null;
      const sellerPayment = sats(tx.vout[1].value);
      if (
        price != null &&
        price >= 50_000 &&
        price === sats(funding.prevout?.value) &&
        /^[0-9a-f]{64}$/.test(w[4]) &&
        createHash('sha256').update(Buffer.from(w[4], 'hex')).digest('hex') === leaf[4] &&
        new RegExp(`^c[01]${leaf[5]}$`).test(w[6]) &&
        output.scriptPubKey?.hex === (leaf[2] ?? leaf[3]) &&
        tx.vin[0].prevout?.scriptPubKey?.address === event.old_owner &&
        sats(tx.vin[0].prevout?.value) === postage &&
        // Sellers commonly receive BTC at a payment address distinct from
        // their ordinals address. Their DEFAULT signature commits the payout.
        SIG_DEFAULT.test((tx.vin[0].txinwitness ?? tx.vin[0].witness ?? [])[0] ?? '') &&
        !!tx.vout[1].scriptPubKey?.address &&
        tx.vout[1].scriptPubKey.address !== event.new_owner &&
        sellerPayment != null &&
        sellerPayment >= 50_000 &&
        sellerPayment <= price &&
        !!tx.vin[2].prevout?.scriptPubKey?.address &&
        tx.vout[4].scriptPubKey?.address === tx.vin[2].prevout.scriptPubKey.address &&
        sats(tx.vin[2].prevout?.value) === 333 &&
        sats(tx.vout[4].value) === 333
      )
        return { shape: 'offer-v2', priceSats: price, inputIndex: 0, outputIndex };
    }
  }

  // Modern listing settlements have a seller SINGLE|ANYONECANPAY signature
  // in witness slot 1 (slot 0 is the service's signature). Output N is the
  // committed seller payment for input N. Require the entire postage output
  // to map to exactly one input; this remains unambiguous for repeated sellers
  // and rows split across ticks. Gross asking prices aren't in this leaf.
  if (!tx.vout.some(v => v.scriptPubKey?.address === FEE_ADDRESS)) return null;
  const listingInputs = tx.vin.flatMap((v, i) => {
    const w = v.txinwitness ?? v.witness ?? [];
    const leaf = w.length === 4 ? LISTING_LEAF.exec(w[2]) : null;
    const payment = sats(tx.vout[i]?.value);
    return leaf &&
      SIG_DEFAULT.test(w[0]) &&
      SIG_SINGLE_ACP.test(w[1]) &&
      new RegExp(`^c[01]${leaf[1]}$`).test(w[3]) &&
      payment != null &&
      payment >= 50_000
      ? [i]
      : [];
  });
  if (listingInputs.length < 2) return null;
  const inputValues = tx.vin.map(v => sats(v.prevout?.value));
  const outputValues = tx.vout.slice(0, outputIndex).map(v => sats(v.value));
  if (inputValues.some(v => v == null) || outputValues.some(v => v == null)) return null;
  const start = outputValues.reduce((sum, v) => sum + BigInt(v ?? 0), 0n);
  let inputStart = 0n;
  for (let i = 0; i < inputValues.length; i++) {
    const value = inputValues[i];
    if (inputStart === start && value === postage && listingInputs.includes(i)) {
      // A signed payout proves a sale, but doesn't prove the gross price
      // before platform fees. Null is deliberate: don't invent per-item BTC.
      return { shape: 'bulk-listing-acp', priceSats: null, inputIndex: i, outputIndex };
    }
    inputStart += BigInt(value ?? 0);
  }
  return null;
}

module.exports = { detectOrdNetSettlement };
