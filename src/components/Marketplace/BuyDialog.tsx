'use client';

import { useState } from 'react';
import Link from 'next/link';
import { formatBtc, marketplaceLabel, truncateAddr } from '@/lib/format';
import type {
  BroadcastResponse,
  CreateIntentResponse,
  MarketplaceListing,
  PurchasePsbtToSign,
} from '@/lib/marketplace/types';
import { useWallet } from '@/components/wallet/WalletProvider';
import ConnectWalletButton from '@/components/wallet/ConnectWalletButton';
import MarketplacePip from './MarketplacePip';
import TermsCheckbox from './TermsCheckbox';

type Props = {
  listing: MarketplaceListing | null;
  open: boolean;
  onClose: () => void;
  onSuccess: (args: { listing: MarketplaceListing; txid: string; intentId: number }) => void;
};

export default function BuyDialog({ listing, open, onClose, onSuccess }: Props) {
  const { wallet, signMessage, signPsbt } = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open || !listing) return null;

  const canBuy = !!wallet?.acceptedTermsAt && !busy;

  async function submit() {
    if (!listing) return;
    setBusy(true);
    setError(null);
    try {
      const intentJson = await createIntentWithOrdnetRetry(listing);
      const broadcastJson = await completeSigningFlow(intentJson);
      onSuccess({
        listing: intentJson.listing,
        txid: broadcastJson.txid,
        intentId: intentJson.intent_id,
      });
      onClose();
    } catch (err) {
      setError(`Purchase failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function completeSigningFlow(
    intentJson: CreateIntentResponse
  ): Promise<BroadcastResponse & { txid: string }> {
    let step: SigningStep = intentJson;
    for (let round = 0; round < 4; round++) {
      const signedPsbts = await signStepPsbts(step);
      const broadcastRes = await fetch('/api/marketplace/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent_id: intentJson.intent_id,
          signed_psbt: signedPsbts[0],
          signed_psbts: signedPsbts,
        }),
      });
      const broadcastJson = (await broadcastRes.json().catch(() => null)) as
        | (BroadcastResponse & { error?: string })
        | null;
      if (!broadcastRes.ok || !broadcastJson) {
        throw new Error(broadcastJson?.error ?? 'Broadcast failed');
      }
      if (broadcastJson.txid) return { ...broadcastJson, txid: broadcastJson.txid };
      if (broadcastJson.psbt || broadcastJson.psbts?.length) {
        step = {
          intent_id: intentJson.intent_id,
          psbt: broadcastJson.psbt ?? broadcastJson.psbts?.[0]?.psbt ?? '',
          sign_inputs: broadcastJson.sign_inputs ?? broadcastJson.psbts?.[0]?.sign_inputs,
          psbts: broadcastJson.psbts,
          step: broadcastJson.step,
        };
        continue;
      }
      throw new Error('Broadcast did not return a transaction or another signing step');
    }
    throw new Error('Purchase required too many signing rounds');
  }

  async function signStepPsbts(step: SigningStep): Promise<string[]> {
    const psbts = normalizeStepPsbts(step);
    const signed: string[] = [];
    for (const item of psbts) {
      signed.push(await signPsbt(item.psbt, item.sign_inputs));
    }
    return signed;
  }

  async function createIntentWithOrdnetRetry(
    listing: MarketplaceListing
  ): Promise<CreateIntentResponse> {
    let intent = await requestIntent(listing.inscription_number);
    if (!intent.ok && intent.code === 'ordnet-auth-required') {
      await authorizeOrdnet();
      intent = await requestIntent(listing.inscription_number);
    }
    if (!intent.ok || !intent.body?.psbt) {
      throw new Error(intent.body?.error ?? 'Purchase failed');
    }
    return intent.body;
  }

  async function requestIntent(inscriptionNumber: number): Promise<{
    ok: boolean;
    code?: string;
    body: (CreateIntentResponse & { error?: string; code?: string }) | null;
  }> {
    const res = await fetch('/api/marketplace/intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inscription_number: inscriptionNumber }),
    });
    const body = (await res.json().catch(() => null)) as
      | (CreateIntentResponse & { error?: string; code?: string })
      | null;
    return { ok: res.ok, code: body?.code, body };
  }

  async function authorizeOrdnet(): Promise<void> {
    const challengeRes = await fetch('/api/marketplace/ordnet/session');
    const challengeJson = (await challengeRes.json().catch(() => null)) as OrdnetChallenge | null;
    if (!challengeRes.ok || !challengeJson?.auth_request_id || !challengeJson.challenges) {
      throw new Error(challengeJson?.error ?? 'ORD.NET wallet authorization failed');
    }
    const verifications = [];
    for (const challenge of challengeJson.challenges) {
      const signature = await signMessage(challenge.address, challenge.message);
      verifications.push({
        challenge_id: challenge.challenge_id,
        address: challenge.address,
        signature: signatureToHex(signature),
      });
    }
    const verifyRes = await fetch('/api/marketplace/ordnet/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auth_request_id: challengeJson.auth_request_id,
        verifications,
      }),
    });
    const verifyJson = (await verifyRes.json().catch(() => null)) as { error?: string } | null;
    if (!verifyRes.ok) {
      throw new Error(verifyJson?.error ?? 'ORD.NET wallet authorization failed');
    }
  }

  return (
    <div className="fixed inset-0 z-[1600] bg-ink-0/80 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Buy OMB #${listing.inscription_number}`}
        className="absolute left-1/2 top-1/2 grid w-[min(92vw,860px)] -translate-x-1/2 -translate-y-1/2 grid-cols-1 border border-ink-2 bg-ink-0 md:grid-cols-[24rem_1fr]"
        onClick={e => e.stopPropagation()}
      >
        <Link
          href={`/inscription/${listing.inscription_number}`}
          className="aspect-square self-start bg-ink-2"
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open OMB #${listing.inscription_number} details page`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={listing.full}
            alt={`OMB #${listing.inscription_number}`}
            className="h-full w-full object-contain"
          />
        </Link>
        <div className="flex min-h-0 flex-col p-4 font-mono uppercase tracking-[0.08em] sm:p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-xl text-bone">
                <span>#{listing.inscription_number}</span>
                <Link
                  href={`/inscription/${listing.inscription_number}`}
                  className="inline-flex h-7 w-7 items-center justify-center border border-ink-2 text-[13px] text-bone-dim transition-colors hover:border-bone-dim hover:text-bone"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open OMB #${listing.inscription_number} details page`}
                >
                  ↗
                </Link>
              </div>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-bone-dim">
                <MarketplacePip marketplace={listing.marketplace} />
                <span>{marketplaceLabel(listing.marketplace)}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="h-9 w-9 text-bone-dim hover:text-bone"
              aria-label="Close buy dialog"
            >
              ✕
            </button>
          </div>

          <div className="mt-5 border-t border-ink-2 pt-4">
            {listing.description && (
              <p className="text-xs italic normal-case tracking-normal text-bone-dim">
                {listing.description}
              </p>
            )}
          </div>

          <div className="mt-4 border-y border-ink-2 py-4">
            <div className="text-[10px] text-bone-dim">price</div>
            <div className="mt-1 text-2xl text-bone tabular-nums">
              {formatBtc(listing.price_sats)}
            </div>
          </div>

          <div className="mt-4 text-[11px] text-bone-dim">
            {wallet ? (
              <>
                receives to <span className="text-bone">{truncateAddr(wallet.ordAddr, 8, 6)}</span>
              </>
            ) : (
              'connect an ordinals wallet to buy'
            )}
          </div>

          <div className="mt-5 space-y-3">
            {!wallet ? <ConnectWalletButton /> : <TermsCheckbox />}
            {error && (
              <div className="break-words text-[11px] leading-relaxed text-accent-red">{error}</div>
            )}
          </div>

          <div className="mt-auto flex items-center justify-end gap-2 pt-6">
            <button
              type="button"
              onClick={onClose}
              className="h-9 border border-ink-2 px-3 text-[11px] text-bone-dim hover:border-bone-dim hover:text-bone"
            >
              cancel
            </button>
            <button
              type="button"
              disabled={!canBuy}
              onClick={() => void submit()}
              className="h-9 border border-bone px-3 text-[11px] text-bone disabled:cursor-not-allowed disabled:border-ink-2 disabled:text-bone-dim"
            >
              {busy ? 'signing' : 'confirm buy'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

type OrdnetChallenge = {
  auth_request_id?: string;
  challenges?: Array<{
    challenge_id: string;
    message: string;
    address: string;
    role: 'ordinals' | 'payment';
  }>;
  error?: string;
};

type SigningStep = {
  intent_id: number;
  psbt: string;
  sign_inputs?: Record<string, number[]>;
  psbts?: PurchasePsbtToSign[];
  step?: string;
};

function normalizeStepPsbts(step: SigningStep): PurchasePsbtToSign[] {
  if (step.psbts?.length) return step.psbts;
  return [{ psbt: step.psbt, sign_inputs: step.sign_inputs, label: step.step }];
}

function signatureToHex(signature: string): string {
  if (/^(?:[0-9a-fA-F]{2})+$/.test(signature)) return signature;
  const raw = atob(signature);
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    out += raw.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return out;
}
