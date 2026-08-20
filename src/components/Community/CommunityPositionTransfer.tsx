'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useWallet } from '@/components/wallet/WalletProvider';
import {
  DREY_COMMUNITY_UPGRADE_MESSAGE,
  isDreyCommunityPositionTransferSupported,
  openDreyCommunitySetup,
} from '@/lib/wallet/satsConnect';
import {
  COMMUNITY_PURCHASES_PROTOCOL,
  communityMessage,
  newActionNonce,
  type AcceptPositionTransferPayloadV1,
  type CommunityEnrollmentV1,
  type CommunityPositionTransferPrivateView,
} from '@/lib/community-purchases/contracts';
import { parseCommunityEnrollmentFor } from '@/lib/community-purchases/form';
import { formatBtcCompact, formatTimeUntil } from '@/lib/format';

export default function CommunityPositionTransfer({
  token,
  initialOwnerId,
}: {
  token: string;
  initialOwnerId: string;
}) {
  const router = useRouter();
  const { wallet, signMessage, signPsbt } = useWallet();
  const [transfer, setTransfer] = useState<CommunityPositionTransferPrivateView | null>(null);
  const [enrollmentText, setEnrollmentText] = useState('');
  const [qualifying, setQualifying] = useState('');
  const [noAlternate, setNoAlternate] = useState(false);
  const [consent, setConsent] = useState(false);
  const [setupOpened, setSetupOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/community/position-transfers/${encodeURIComponent(token)}`, {
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    const json = (await response.json().catch(() => null)) as {
      transfer?: CommunityPositionTransferPrivateView;
      error?: string;
    } | null;
    if (!response.ok || !json?.transfer)
      throw new Error(json?.error ?? 'This private invitation is unavailable.');
    setTransfer(json.transfer);
  }, [token]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh().catch(reason =>
        setError(reason instanceof Error ? reason.message : 'Invitation unavailable.')
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh, wallet?.ordAddr]);

  useEffect(() => {
    if (!transfer || ['confirmed', 'expired', 'cancelled', 'failed'].includes(transfer.status))
      return;
    const timer = window.setInterval(() => void refresh().catch(() => null), 20_000);
    return () => window.clearInterval(timer);
  }, [refresh, transfer]);

  const dreyReady = wallet ? isDreyCommunityPositionTransferSupported(wallet) : false;
  const enrollment = transfer
    ? parseCommunityEnrollmentFor(enrollmentText, transfer.campaignId, initialOwnerId)
    : null;

  return (
    <div className="mx-auto w-full max-w-xl px-4 pb-12 sm:px-6">
      <button
        type="button"
        onClick={() => router.push(transfer ? `/community/${transfer.campaignId}` : '/community')}
        className="mb-4 font-mono text-[10px] uppercase tracking-[0.1em] text-bone-dim hover:text-bone"
      >
        ← group buy
      </button>
      <section className="border border-ink-2 bg-ink-1 p-5 sm:p-6">
        <div className="font-mono text-[9px] uppercase tracking-[0.1em] text-accent-orange">
          Private invitation
        </div>
        <h1 className="mt-2 font-mono text-2xl uppercase text-bone">
          {transfer
            ? transfer.status === 'invited'
              ? `Buy this ${transfer.transferredUnits.length}% position?`
              : `${transfer.transferredUnits.length}% position transfer`
            : 'Loading invitation…'}
        </h1>
        {transfer && (
          <>
            <dl className="mt-5 grid grid-cols-2 gap-4 border-y border-ink-2 py-4">
              <Summary label="OMB" value={`#${transfer.inscriptionNumber}`} />
              <Summary label="Whole position" value={`${transfer.transferredUnits.length}%`} />
              <Summary
                label="Seller price"
                value={formatBtcCompact(Number(transfer.sellerPriceSats))}
              />
              <Summary
                label="Expires"
                value={formatTimeUntil(Math.floor(Number(transfer.expiresAtMs) / 1_000))}
              />
            </dl>
            <p className="mt-4 text-xs leading-relaxed text-bone-dim">
              The complete position moves at once. The same on-chain transaction pays the seller and
              moves the OMB into a new 69-of-100 vault.
            </p>
          </>
        )}

        {!wallet && transfer?.status === 'invited' && (
          <p className="mt-5 border border-accent-orange/50 p-3 text-xs text-bone-dim">
            Connect Drey above to accept this invitation.
          </p>
        )}

        {wallet && transfer?.status === 'invited' && (
          <div className="mt-5 border-t border-ink-2 pt-5">
            {!dreyReady && (
              <p className="mb-4 border border-accent-orange/50 p-3 font-mono text-[9px] uppercase text-accent-orange">
                {DREY_COMMUNITY_UPGRADE_MESSAGE}
              </p>
            )}
            <div className="font-mono text-sm uppercase tracking-[0.08em] text-bone">
              Set up your owner key
            </div>
            <p className="mt-2 text-xs leading-relaxed text-bone-dim">
              Drey keeps the key and verifies your recovery backup. The gallery receives only the
              public setup package.
            </p>
            {!enrollment ? (
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  disabled={!dreyReady}
                  onClick={() => void openSetup()}
                  className="h-10 border border-bone px-3 font-mono text-[9px] uppercase text-bone disabled:opacity-40"
                >
                  {setupOpened ? 'Open Drey again' : 'Continue in Drey'}
                </button>
                {setupOpened && (
                  <button
                    type="button"
                    onClick={() => void pasteSetup()}
                    className="h-10 border border-accent-orange bg-accent-orange px-3 font-mono text-[9px] uppercase text-ink-0"
                  >
                    Paste setup from Drey
                  </button>
                )}
              </div>
            ) : (
              <p className="mt-3 border border-accent-green/50 p-3 font-mono text-[9px] uppercase text-accent-green">
                Public Drey setup linked
              </p>
            )}
            <details className="mt-3 text-[10px] text-bone-dim">
              <summary className="cursor-pointer font-mono uppercase">Paste manually</summary>
              <textarea
                value={enrollmentText}
                onChange={event => setEnrollmentText(event.target.value)}
                rows={5}
                className="mt-3 w-full border border-ink-2 bg-ink-0 p-3 font-mono text-[10px] text-bone outline-none"
              />
            </details>
            {transfer.eligibilityMode === 'omb-holders-only' && (
              <label className="mt-4 block font-mono text-[9px] uppercase text-bone-dim">
                Qualifying OMB number
                <input
                  value={qualifying}
                  onChange={event => setQualifying(event.target.value)}
                  className="mt-1 h-10 w-full border border-ink-2 bg-ink-0 px-3 text-bone outline-none"
                />
              </label>
            )}
            <Check
              checked={noAlternate}
              onChange={setNoAlternate}
              label="I am not already participating through another identity I control."
            />
            <Check
              checked={consent}
              onChange={setConsent}
              label="I understand my owner identity and payout address will appear on the public cap table after confirmation."
            />
            <button
              type="button"
              disabled={busy || !dreyReady || !enrollment || !noAlternate || !consent}
              onClick={() => void accept(enrollment)}
              className="mt-5 h-11 w-full border border-bone bg-bone font-mono text-[10px] uppercase tracking-[0.1em] text-ink-0 disabled:opacity-40"
            >
              {busy ? 'signing…' : 'Accept complete position'}
            </button>
          </div>
        )}

        {wallet &&
          transfer?.status === 'buyer-accepted' &&
          transfer.buyerWalletAddress === wallet.ordAddr && (
            <Status
              title="Waiting for seller"
              body="The seller must confirm your exact public owner key and price before any BTC can be signed."
            />
          )}
        {transfer?.status === 'buyer-accepted' &&
          (!wallet || transfer.buyerWalletAddress !== wallet.ordAddr) && (
            <Status
              title="Invitation accepted"
              body="This invitation is now reserved for the buyer who accepted it."
            />
          )}
        {wallet &&
          transfer?.status === 'authorized' &&
          transfer.buyerContext &&
          transfer.signingPsbtBase64 && (
            <div className="mt-5 border-t border-ink-2 pt-5">
              <Status
                title="Seller confirmed"
                body="Drey will check clean funds, the exact seller payment, the network fee, and the new vault before signing. Nothing broadcasts here."
              />
              <button
                type="button"
                disabled={busy || !dreyReady}
                onClick={() => void fund()}
                className="mt-4 h-11 w-full border border-accent-orange bg-accent-orange font-mono text-[10px] uppercase tracking-[0.1em] text-ink-0 disabled:opacity-40"
              >
                {busy ? 'opening Drey…' : 'Review and fund in Drey'}
              </button>
            </div>
          )}
        {transfer?.status === 'authorized' && !transfer.buyerContext && (
          <Status
            title="Waiting for buyer funding"
            body="The confirmed buyer must review and fund the exact transfer in Drey."
          />
        )}
        {transfer && ['signing', 'ready', 'broadcast'].includes(transfer.status) && (
          <Status
            title={
              transfer.status === 'signing'
                ? 'Waiting for owner approvals'
                : transfer.status === 'ready'
                  ? 'Ready to broadcast'
                  : 'Waiting for confirmation'
            }
            body={
              transfer.status === 'signing'
                ? 'Your funding is signed. The current owners now need to approve 69 units.'
                : transfer.status === 'ready'
                  ? 'The exact transaction has enough approvals and passed final checks.'
                  : 'The cap table will change only after the transfer is confirmed on-chain.'
            }
          />
        )}
        {transfer?.status === 'confirmed' && (
          <Status
            title="Transfer complete"
            body="The transfer is confirmed on-chain, and the public cap table now shows the new owner."
          />
        )}
        {transfer && ['expired', 'cancelled', 'failed'].includes(transfer.status) && (
          <Status title="Invitation closed" body="No ownership change was made." />
        )}

        {error && (
          <p role="alert" className="mt-4 text-[10px] text-accent-red">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="mt-4 text-[10px] text-accent-green">
            {notice}
          </p>
        )}
      </section>
    </div>
  );

  async function openSetup() {
    if (!wallet || !transfer || !dreyReady) return;
    setError(null);
    try {
      await openDreyCommunitySetup(wallet, {
        campaignId: transfer.campaignId,
        ownerId: initialOwnerId,
        label: `OMB #${transfer.inscriptionNumber}`,
      });
      setSetupOpened(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not open Drey setup.');
    }
  }

  async function pasteSetup() {
    if (!transfer) return;
    try {
      const text = await navigator.clipboard.readText();
      if (!parseCommunityEnrollmentFor(text, transfer.campaignId, initialOwnerId))
        throw new Error('wrong setup');
      setEnrollmentText(text);
      setNotice('Drey setup added.');
    } catch {
      setError(
        'That is not the matching Drey setup. Paste it manually if clipboard access is blocked.'
      );
    }
  }

  async function accept(parsed: CommunityEnrollmentV1 | null) {
    if (!wallet || !wallet.payAddr || !transfer || !parsed) return;
    setBusy(true);
    setError(null);
    try {
      const now = Math.floor(Date.now() / 1_000);
      const payload: AcceptPositionTransferPayloadV1 = {
        protocol: COMMUNITY_PURCHASES_PROTOCOL,
        version: 1,
        network: 'mainnet',
        action: 'accept-position-transfer',
        campaignId: transfer.campaignId,
        transferId: transfer.transferId,
        buyerOwnerId: initialOwnerId,
        payoutAddress: wallet.payAddr,
        qualifyingInscriptionNumber:
          transfer.eligibilityMode === 'omb-holders-only' ? Number(qualifying) : null,
        enrollment: parsed,
        recoveryConfirmed: true,
        noAlternateIdentityAttestation: true,
        identityDisclosureConsent: true,
        expiresAt: now + 10 * 60,
        nonce: newActionNonce(),
      };
      const signature = await signMessage(wallet.ordAddr, communityMessage(payload));
      const response = await fetch(
        `/api/community/position-transfers/${encodeURIComponent(token)}/accept`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ payload, signature }),
          referrerPolicy: 'no-referrer',
        }
      );
      const json = (await response.json().catch(() => null)) as {
        transfer?: CommunityPositionTransferPrivateView;
        error?: string;
      } | null;
      if (!response.ok || !json?.transfer)
        throw new Error(json?.error ?? 'Could not accept the invitation.');
      setTransfer(json.transfer);
      setNotice('Accepted. The seller can now confirm the transfer.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not accept the invitation.');
    } finally {
      setBusy(false);
    }
  }

  async function fund() {
    if (!wallet?.payAddr || !transfer?.buyerContext || !transfer.signingPsbtBase64) return;
    setBusy(true);
    setError(null);
    try {
      const signedPsbt = await signPsbt(
        transfer.signingPsbtBase64,
        { [wallet.payAddr]: transfer.buyerInputIndexes },
        undefined,
        undefined,
        undefined,
        undefined,
        { role: 'buyer', context: transfer.buyerContext }
      );
      const response = await fetch(
        `/api/community/position-transfers/${encodeURIComponent(token)}/fund`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ signed_psbt: signedPsbt }),
          referrerPolicy: 'no-referrer',
        }
      );
      const json = (await response.json().catch(() => null)) as {
        transfer?: CommunityPositionTransferPrivateView;
        error?: string;
      } | null;
      if (!response.ok || !json?.transfer) throw new Error(json?.error ?? 'Buyer funding failed.');
      setTransfer(json.transfer);
      setNotice('Funding approved. Current owners can now review the transfer.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Buyer funding failed.');
    } finally {
      setBusy(false);
    }
  }
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[9px] uppercase text-bone-dim">{label}</dt>
      <dd className="mt-1 font-mono text-sm text-bone">{value}</dd>
    </div>
  );
}

function Status({ title, body }: { title: string; body: string }) {
  return (
    <div className="mt-5 border border-accent-green/50 p-4">
      <div className="font-mono text-[10px] uppercase text-accent-green">{title}</div>
      <p className="mt-2 text-xs leading-relaxed text-bone-dim">{body}</p>
    </div>
  );
}

function Check({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange(value: boolean): void;
  label: string;
}) {
  return (
    <label className="mt-3 flex cursor-pointer items-start gap-2 text-[11px] leading-relaxed text-bone-dim">
      <input
        type="checkbox"
        checked={checked}
        onChange={event => onChange(event.target.checked)}
        className="mt-0.5 accent-white"
      />
      <span>{label}</span>
    </label>
  );
}
