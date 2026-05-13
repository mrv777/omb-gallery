'use client';

import Wallet, { AddressPurpose, MessageSigningProtocols } from 'sats-connect';

export type ConnectedWallet = {
  ordAddr: string;
  payAddr: string | null;
  ordPubkey: string | null;
  payPubkey: string | null;
};

type SatsAddress = {
  address: string;
  publicKey: string;
  purpose: AddressPurpose;
};

type WalletRpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

const CONNECT_MESSAGE = 'Connect to OMB Wiki marketplace.';
const ADDRESS_PURPOSES = [AddressPurpose.Ordinals, AddressPurpose.Payment];

export async function connectSatsWallet(): Promise<ConnectedWallet> {
  const response = await Wallet.request('getAccounts', {
    purposes: ADDRESS_PURPOSES,
    message: CONNECT_MESSAGE,
  });
  if (response.status === 'error') throw walletResponseError(response.error);
  return walletFromAddresses(response.result as SatsAddress[]);
}

function walletFromAddresses(addresses: SatsAddress[]): ConnectedWallet {
  const ord = addresses.find(addr => addr.purpose === AddressPurpose.Ordinals);
  const pay = addresses.find(addr => addr.purpose === AddressPurpose.Payment);
  if (!ord?.address) throw new Error('Wallet did not return an ordinals address');
  return {
    ordAddr: ord.address,
    payAddr: pay?.address ?? null,
    ordPubkey: ord.publicKey ?? null,
    payPubkey: pay?.publicKey ?? null,
  };
}

export async function signBuyerMessage(address: string, message: string): Promise<string> {
  const response = await Wallet.request('signMessage', {
    address,
    message,
    protocol: MessageSigningProtocols.BIP322,
  });
  if (response.status === 'error') throw walletResponseError(response.error);
  return response.result.signature;
}

export async function signPurchasePsbt(args: {
  psbt: string;
  signInputs?: Record<string, number[]>;
}): Promise<{ signedPsbt: string; txid?: string }> {
  if (process.env.NEXT_PUBLIC_MARKETPLACE_MOCK === 'true') {
    return { signedPsbt: `mock-signed:${args.psbt}` };
  }
  const response = await Wallet.request('signPsbt', {
    psbt: args.psbt,
    signInputs: args.signInputs,
    broadcast: false,
  });
  if (response.status === 'error') throw walletResponseError(response.error);
  return { signedPsbt: response.result.psbt, txid: response.result.txid };
}

export function mockConnectedWallet(): ConnectedWallet {
  return {
    ordAddr: 'bc1pombmockordinalsbuyer0000000000000000000000000000000qqq',
    payAddr: 'bc1qombmockpaymentbuyer00000000000000000000000000x0k',
    ordPubkey: null,
    payPubkey: null,
  };
}

function walletResponseError(error: WalletRpcError): Error {
  return new Error(error.message || 'Wallet request failed');
}
