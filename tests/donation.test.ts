import { describe, expect, it } from 'vitest';
import { getAddressInfo, validate } from 'bitcoin-address-validation';
import {
  DONATION_CONFIG,
  buildDonationUri,
  donationWalletAvailability,
  donationWalletInstalled,
  satsToBtc,
  validateDonationSats,
} from '@/lib/donation';

describe('donation configuration', () => {
  it('commits a valid mainnet native-SegWit payment address', () => {
    expect(validate(DONATION_CONFIG.address)).toBe(true);
    expect(getAddressInfo(DONATION_CONFIG.address)).toMatchObject({
      network: 'mainnet',
      type: 'p2wpkh',
    });
  });

  it('keeps the selected presets and minimum stable', () => {
    expect(DONATION_CONFIG.presetSats).toEqual([10_000, 50_000, 100_000]);
    expect(DONATION_CONFIG.minimumWalletSats).toBe(1_000);
  });

  it('uses Drey as the donation provider with the current store listing', () => {
    expect(DONATION_CONFIG.wallets.drey).toEqual({
      id: 'drey',
      name: 'Drey',
      installUrl: 'https://chromewebstore.google.com/detail/drey/kngidlmmbfmnoeimngkajdlbdenlhgof',
    });
    expect('sqrl' in DONATION_CONFIG.wallets).toBe(false);
  });
});

describe('donation amount and BIP21 helpers', () => {
  it('keeps an empty amount valid for address-only QR payments', () => {
    expect(validateDonationSats('')).toEqual({ sats: null, error: null });
    expect(buildDonationUri(null)).toBe(`bitcoin:${DONATION_CONFIG.address}`);
  });

  it('renders amount-bearing BIP21 URIs with exact BTC precision and encoded metadata', () => {
    const uri = buildDonationUri(10_000);
    expect(uri).toBe(
      `bitcoin:${DONATION_CONFIG.address}?amount=0.00010000&label=OMB+Archive&message=Support+the+site`
    );
    expect(satsToBtc(100_000_000)).toBe('1.00000000');
    expect(satsToBtc(2_100_000_000_000_000)).toBe('21000000.00000000');
  });

  it('accepts whole sats at the minimum and rejects malformed or unsafe values', () => {
    expect(validateDonationSats('1000')).toEqual({ sats: 1_000, error: null });
    expect(validateDonationSats(' 50000 ')).toEqual({ sats: 50_000, error: null });
    for (const raw of ['999', '-1000', '1.5', '1,000', 'abc']) {
      expect(validateDonationSats(raw).error).toBeTruthy();
    }
    expect(validateDonationSats('2100000000000001').error).toMatch(/too large/i);
  });
});

describe('donation wallet detection', () => {
  it('detects the two supported provider objects', () => {
    const providerWindow = {
      XverseProviders: { BitcoinProvider: { request() {} } },
      drey: { request() {} },
    };
    expect(donationWalletAvailability(providerWindow)).toEqual({
      xverse: true,
      drey: true,
    });
  });

  it('does not trust discovery metadata without the matching provider object', () => {
    expect(
      donationWalletInstalled('drey', {
        btc_providers: [{ id: 'drey', name: 'Drey' }],
      })
    ).toBe(false);
    expect(donationWalletAvailability({})).toEqual({
      xverse: false,
      drey: false,
    });
  });
});
