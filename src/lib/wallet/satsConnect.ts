'use client';

import { AddressPurpose, MessageSigningProtocols, request } from 'sats-connect';

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

export async function connectSatsWallet(): Promise<ConnectedWallet> {
  const response = await request('getAddresses', {
    purposes: [AddressPurpose.Ordinals, AddressPurpose.Payment],
    message: 'Connect to OMB Wiki marketplace.',
  });
  if (response.status === 'error') throw new Error(response.error.message);
  const addresses = response.result.addresses as SatsAddress[];
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
  const response = await request('signMessage', {
    address,
    message,
    protocol: MessageSigningProtocols.BIP322,
  });
  if (response.status === 'error') throw new Error(response.error.message);
  return response.result.signature;
}

export async function signPurchasePsbt(args: {
  psbt: string;
  signInputs?: Record<string, number[]>;
}): Promise<{ signedPsbt: string; txid?: string }> {
  if (process.env.NEXT_PUBLIC_MARKETPLACE_MOCK === 'true') {
    return { signedPsbt: `mock-signed:${args.psbt}` };
  }
  const response = await request('signPsbt', {
    psbt: args.psbt,
    signInputs: args.signInputs,
    broadcast: false,
  });
  if (response.status === 'error') throw new Error(response.error.message);
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
