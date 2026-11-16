import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const walletState = vi.hoisted(() => ({
  wallet: null as null | { ordAddr: string; payAddr: string },
  signMessage: vi.fn(),
}));

vi.mock('@/components/wallet/WalletProvider', () => ({ useWallet: () => walletState }));
vi.mock('@/components/wallet/ConnectWalletButton', () => ({
  default: () => createElement('button', { type: 'button' }, 'Connect wallet'),
}));

import PublicProfileSettings from '@/components/Profile/PublicProfileSettings';

beforeEach(() => {
  walletState.wallet = null;
  walletState.signMessage.mockClear();
});

describe('public profile settings first render', () => {
  it('explains optional sharing before asking a disconnected visitor to connect', () => {
    const html = renderToStaticMarkup(createElement(PublicProfileSettings));
    expect(html).toContain('Sharing is optional');
    expect(html).toContain('Connecting alone does not publish');
    expect(html).toContain('Connect wallet');
    expect(html).not.toContain('Publish for this wallet');
    expect(walletState.signMessage).not.toHaveBeenCalled();
  });

  it('does not equate Archive profile sharing with Discord verification', () => {
    const html = renderToStaticMarkup(createElement(PublicProfileSettings));
    expect(html).toContain('participating Discord servers');
    expect(html).toContain('it does not assign Discord roles');
    expect(html).toContain('https://docs.ord.net/guides/nexus-discord-verification/');
  });

  it('shows only the selected ordinals wallet while checking its publication state', () => {
    walletState.wallet = {
      ordAddr: 'bc1pconnected-ordinals-wallet',
      payAddr: 'bc1qprivate-payment-wallet',
    };
    const html = renderToStaticMarkup(createElement(PublicProfileSettings));
    expect(html).toContain(walletState.wallet.ordAddr);
    expect(html).not.toContain(walletState.wallet.payAddr);
    expect(html).toContain('Your payment address and other ORD.NET wallets are not');
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Preview ORD.NET profile/);
    expect(html).not.toContain('Publish for this wallet');
    expect(walletState.signMessage).not.toHaveBeenCalled();
  });

  it('discloses the API funding requirement without presenting it as a fee', () => {
    walletState.wallet = { ordAddr: 'bc1pwallet', payAddr: 'bc1qpayment' };
    const html = renderToStaticMarkup(createElement(PublicProfileSettings));
    expect(html).toContain('100,000 sats (0.001 BTC)');
    expect(html).toContain('not a payment to the Archive');
    expect(html).toContain('Before you connect ORD.NET');
  });
});
