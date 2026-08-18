import { DREY_CHROME_STORE_URL, DREY_PROVIDER_ID } from '@/lib/wallet/dreyProvider';

export const DONATION_CONFIG = Object.freeze({
  address: 'bc1qfrt77mfrcrvjxcq7ahcgtm7w4czl6eftk4jk2c',
  label: 'OMB Archive',
  message: 'Support the site',
  presetSats: [10_000, 50_000, 100_000] as const,
  minimumWalletSats: 1_000,
  wallets: {
    xverse: {
      id: 'XverseProviders.BitcoinProvider',
      name: 'Xverse',
      installUrl:
        'https://chromewebstore.google.com/detail/xverse-wallet/idnnbdplmphpflfnlkomgpfbpcgelopg',
    },
    drey: {
      id: DREY_PROVIDER_ID,
      name: 'Drey',
      installUrl: DREY_CHROME_STORE_URL,
    },
  },
});

export type DonationWalletKey = keyof typeof DONATION_CONFIG.wallets;

export type DonationAmountValidation =
  | { sats: null; error: null }
  | { sats: null; error: string }
  | { sats: number; error: null };

const WHOLE_SATS = /^(0|[1-9][0-9]*)$/;
const SATS_PER_BTC = 100_000_000;
const MAX_BITCOIN_SATS = 21_000_000 * SATS_PER_BTC;

export function validateDonationSats(raw: string): DonationAmountValidation {
  const value = raw.trim();
  if (value === '') return { sats: null, error: null };
  if (!WHOLE_SATS.test(value)) {
    return { sats: null, error: 'Enter a whole number of sats.' };
  }

  const sats = Number(value);
  if (!Number.isSafeInteger(sats) || sats > MAX_BITCOIN_SATS) {
    return { sats: null, error: 'That amount is too large.' };
  }
  if (sats < DONATION_CONFIG.minimumWalletSats) {
    return {
      sats: null,
      error: `Wallet payments must be at least ${DONATION_CONFIG.minimumWalletSats.toLocaleString()} sats.`,
    };
  }
  return { sats, error: null };
}

export function satsToBtc(sats: number): string {
  if (!Number.isSafeInteger(sats) || sats < 0 || sats > MAX_BITCOIN_SATS) {
    throw new Error('Invalid satoshi amount');
  }
  const whole = Math.floor(sats / SATS_PER_BTC);
  const fraction = String(sats % SATS_PER_BTC).padStart(8, '0');
  return `${whole}.${fraction}`;
}

export function buildDonationUri(sats: number | null): string {
  const base = `bitcoin:${DONATION_CONFIG.address}`;
  if (sats == null) return base;
  const params = new URLSearchParams({
    amount: satsToBtc(sats),
    label: DONATION_CONFIG.label,
    message: DONATION_CONFIG.message,
  });
  return `${base}?${params.toString()}`;
}

export type ProviderWindow = {
  XverseProviders?: { BitcoinProvider?: { request?: unknown } };
  drey?: { request?: unknown };
  btc_providers?: unknown[];
  wbip_providers?: unknown[];
};

export function donationWalletInstalled(
  wallet: DonationWalletKey,
  providerWindow: ProviderWindow
): boolean {
  if (wallet === 'xverse') {
    return typeof providerWindow.XverseProviders?.BitcoinProvider?.request === 'function';
  }
  if (typeof providerWindow.drey?.request === 'function') return true;

  const discovered = [
    ...(Array.isArray(providerWindow.btc_providers) ? providerWindow.btc_providers : []),
    ...(Array.isArray(providerWindow.wbip_providers) ? providerWindow.wbip_providers : []),
  ];
  const registered = discovered.some(provider => {
    if (!provider || typeof provider !== 'object') return false;
    const candidate = provider as { id?: unknown };
    return candidate.id === DONATION_CONFIG.wallets.drey.id;
  });
  return registered && typeof providerWindow.drey?.request === 'function';
}

export function donationWalletAvailability(
  providerWindow: ProviderWindow
): Record<DonationWalletKey, boolean> {
  return {
    xverse: donationWalletInstalled('xverse', providerWindow),
    drey: donationWalletInstalled('drey', providerWindow),
  };
}
