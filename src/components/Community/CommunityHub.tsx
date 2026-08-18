'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { MarketplaceListing } from '@/lib/marketplace/types';
import {
  COMMUNITY_PURCHASES_PROTOCOL,
  COMMUNITY_PURCHASES_TERMS_VERSION,
  communityMessage,
  newActionNonce,
  type CommunityCampaignView,
  type CommunityEnrollmentV1,
  type CreateCampaignPayloadV1,
} from '@/lib/community-purchases/contracts';
import { useWallet } from '@/components/wallet/WalletProvider';
import { DREY_MIN_COMMUNITY_VERSION, isDreyCommunitySupported } from '@/lib/wallet/satsConnect';
import CommunityCard from './CommunityCard';

export default function CommunityHub({
  initialCampaigns,
  initialCampaignId,
  initialOwnerId,
  listings,
}: {
  initialCampaigns: CommunityCampaignView[];
  initialCampaignId: string;
  initialOwnerId: string;
  listings: MarketplaceListing[];
}) {
  const router = useRouter();
  const { wallet, signMessage } = useWallet();
  const [creating, setCreating] = useState(false);
  const campaignId = initialCampaignId;
  const ownerId = initialOwnerId;
  const [source, setSource] = useState<'listed' | 'creator-fronted'>('listed');
  const [mode, setMode] = useState<'anchored' | 'open'>('anchored');
  const [eligibility, setEligibility] = useState<'anyone' | 'omb-holders-only'>('anyone');
  const [creatorUnits, setCreatorUnits] = useState(33);
  const [listingChoice, setListingChoice] = useState('');
  const [frontedInscriptionNumber, setFrontedInscriptionNumber] = useState('');
  const [frontedIntentId, setFrontedIntentId] = useState('');
  const [maxCost, setMaxCost] = useState('');
  const [payoutAddress, setPayoutAddress] = useState('');
  const [enrollmentText, setEnrollmentText] = useState('');
  const [anchorAccepted, setAnchorAccepted] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedListing = useMemo(
    () =>
      listings
        .flatMap(listing => listing.options.map(option => ({ listing, option })))
        .find(
          item =>
            `${item.listing.inscription_number}:${item.option.marketplace}:${item.option.listing_id}` ===
            listingChoice
        ),
    [listingChoice, listings]
  );
  const dreyReady = wallet ? isDreyCommunitySupported(wallet) : false;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-10 sm:px-6">
      <section className="border-b border-ink-2 pb-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-2xl">
            <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent-green">
              100 fixed units · 69 to move
            </div>
            <h1 className="mt-2 text-3xl text-bone sm:text-4xl">Buy one OMB together.</h1>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-bone-dim">
              Reserve a share without sending BTC. If all 100 units fill, every selected owner
              reviews and signs one exact purchase in Drey.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCreating(value => !value)}
            className="h-10 border border-bone px-4 font-mono text-[10px] uppercase tracking-[0.1em] text-bone hover:bg-bone hover:text-ink-0"
          >
            {creating ? 'close' : 'start a group buy'}
          </button>
        </div>
        <div className="mt-5 grid gap-2 font-mono text-[9px] uppercase tracking-[0.08em] text-bone-dim sm:grid-cols-3">
          <div className="border border-ink-2 p-3">
            <span className="text-bone">01</span> reserve only — no BTC moves
          </div>
          <div className="border border-ink-2 p-3">
            <span className="text-bone">02</span> Drey holds your owner key
          </div>
          <div className="border border-ink-2 p-3">
            <span className="text-bone">03</span> owners are paid directly on sale
          </div>
        </div>
      </section>

      {creating && (
        <section className="mt-6 border border-ink-2 bg-ink-1 p-4 sm:p-6">
          <div className="max-w-3xl">
            <h2 className="font-mono text-lg uppercase tracking-[0.08em] text-bone">
              Start a group buy
            </h2>
            <p className="mt-2 text-xs leading-relaxed text-bone-dim">
              One short setup. Drey creates your independent campaign key; the gallery only receives
              its public enrollment package.
            </p>
            {!wallet ? (
              <p className="mt-5 border border-accent-orange/50 p-3 font-mono text-[10px] uppercase text-accent-orange">
                Connect Drey above to continue.
              </p>
            ) : wallet.providerId !== 'drey' ? (
              <p className="mt-5 border border-accent-orange/50 p-3 font-mono text-[10px] uppercase text-accent-orange">
                Group Buys uses Drey. Reconnect with Drey to create or join.
              </p>
            ) : !dreyReady ? (
              <p className="mt-5 border border-accent-orange/50 p-3 font-mono text-[10px] uppercase text-accent-orange">
                Update to Drey {DREY_MIN_COMMUNITY_VERSION} or newer, then reconnect.
              </p>
            ) : null}

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <Select
                label="purchase path"
                value={source}
                onChange={value => setSource(value as typeof source)}
                options={[
                  ['listed', 'active listing'],
                  ['creator-fronted', 'I already bought it'],
                ]}
              />
              <Select
                label="ownership"
                value={mode}
                onChange={value => {
                  setMode(value as typeof mode);
                  setCreatorUnits(value === 'anchored' ? 33 : 10);
                }}
                options={[
                  ['anchored', 'anchored · creator 33%'],
                  ['open', 'open · creator 1–20%'],
                ]}
              />
              <Select
                label="who can join"
                value={eligibility}
                onChange={value => setEligibility(value as typeof eligibility)}
                options={[
                  ['anyone', 'anyone'],
                  ['omb-holders-only', 'OMB holders only'],
                ]}
              />
              <Field
                label="creator units"
                type="number"
                min={mode === 'anchored' ? 33 : 1}
                max={mode === 'anchored' ? 33 : 20}
                value={String(creatorUnits)}
                disabled={mode === 'anchored'}
                onChange={setCreatorUnitsFromText}
              />
            </div>

            {source === 'listed' ? (
              <label className="mt-4 block font-mono text-[10px] uppercase tracking-[0.08em] text-bone-dim">
                active listing
                <select
                  value={listingChoice}
                  onChange={event => {
                    setListingChoice(event.target.value);
                    const item = listings
                      .flatMap(listing => listing.options.map(option => ({ listing, option })))
                      .find(
                        candidate =>
                          `${candidate.listing.inscription_number}:${candidate.option.marketplace}:${candidate.option.listing_id}` ===
                          event.target.value
                      );
                    if (item) setMaxCost(String(item.option.estimated_buyer_total_sats + 25_000));
                  }}
                  className="mt-1 h-11 w-full border border-ink-2 bg-ink-0 px-3 text-xs text-bone outline-none focus:border-bone"
                >
                  <option value="">choose an OMB</option>
                  {listings.flatMap(listing =>
                    listing.options.map(option => (
                      <option
                        key={`${option.marketplace}:${option.listing_id}`}
                        value={`${listing.inscription_number}:${option.marketplace}:${option.listing_id}`}
                      >
                        OMB {listing.inscription_number} · {option.marketplace} ·{' '}
                        {option.estimated_buyer_total_sats.toLocaleString()} sats before network
                      </option>
                    ))
                  )}
                </select>
              </label>
            ) : (
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field
                  label="OMB inscription number"
                  type="number"
                  value={frontedInscriptionNumber}
                  onChange={setFrontedInscriptionNumber}
                />
                <Field
                  label="confirmed gallery purchase ID"
                  type="number"
                  value={frontedIntentId}
                  onChange={setFrontedIntentId}
                />
              </div>
            )}

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field
                label="maximum total cost · sats"
                inputMode="numeric"
                value={maxCost}
                onChange={setMaxCost}
              />
              <Field
                label="your payout address"
                value={payoutAddress || wallet?.payAddr || ''}
                onChange={setPayoutAddress}
              />
            </div>

            <div className="mt-6 border-l-2 border-accent-blue bg-ink-0 p-4">
              <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-accent-blue">
                Set up in Drey
              </div>
              <ol className="mt-3 space-y-2 text-xs leading-relaxed text-bone-dim">
                <li>1. Drey → Settings → Community Vault → Join campaign.</li>
                <li>
                  2. Campaign ID: <CopyValue value={campaignId} />
                </li>
                <li>
                  3. Owner ID: <CopyValue value={ownerId} />
                </li>
                <li>4. Finish the recovery check, then copy the enrollment package.</li>
              </ol>
              <textarea
                value={enrollmentText}
                onChange={event => setEnrollmentText(event.target.value)}
                rows={5}
                placeholder="paste Drey enrollment package"
                className="mt-4 w-full resize-y border border-ink-2 bg-ink-1 p-3 font-mono text-[10px] text-bone outline-none placeholder:text-bone-dim/50 focus:border-bone"
              />
            </div>

            {mode === 'anchored' && (
              <Check
                checked={anchorAccepted}
                onChange={setAnchorAccepted}
                label="I understand: losing the creator campaign key can freeze this OMB permanently. Drey and the gallery cannot recover it."
              />
            )}
            <Check
              checked={consent}
              onChange={setConsent}
              label="I consent to the campaign publicly showing my wallet, Matrica handle when linked, payout address, units, and clearly labeled inferred-link warnings."
            />
            <p className="mt-3 text-[11px] leading-relaxed text-bone-dim">
              No platform fee. Reservations move no BTC. A valid 69-unit coalition can bypass Drey,
              so minority payout is not guaranteed by Bitcoin consensus.
            </p>
            {error && (
              <p
                role="alert"
                className="mt-4 border border-accent-red/50 p-3 font-mono text-[10px] uppercase text-accent-red"
              >
                {error}
              </p>
            )}
            <button
              type="button"
              disabled={busy || !dreyReady}
              onClick={() => void submit()}
              className="mt-5 h-11 border border-bone bg-bone px-5 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-0 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? 'signing…' : 'review & start group buy'}
            </button>
          </div>
        </section>
      )}

      <section className="mt-8">
        <div className="mb-4 flex items-center justify-between font-mono uppercase tracking-[0.1em]">
          <h2 className="text-sm text-bone">Group buys</h2>
          <span className="text-[9px] text-bone-dim">{initialCampaigns.length} total</span>
        </div>
        {initialCampaigns.length ? (
          <div className="grid gap-3 md:grid-cols-2">
            {initialCampaigns.map(campaign => (
              <CommunityCard key={campaign.id} campaign={campaign} />
            ))}
          </div>
        ) : (
          <div className="border border-dashed border-ink-2 px-4 py-12 text-center font-mono text-[10px] uppercase tracking-[0.08em] text-bone-dim">
            No group buys yet.
          </div>
        )}
      </section>
    </div>
  );

  function setCreatorUnitsFromText(value: string) {
    setCreatorUnits(Number(value.replace(/\D/g, '')) || 0);
  }

  async function submit() {
    setError(null);
    if (!wallet || !isDreyCommunitySupported(wallet))
      return setError(`Drey ${DREY_MIN_COMMUNITY_VERSION} or newer is required.`);
    let enrollment: CommunityEnrollmentV1;
    try {
      enrollment = JSON.parse(enrollmentText) as CommunityEnrollmentV1;
    } catch {
      return setError('Paste the enrollment package copied from Drey.');
    }
    const inscriptionNumber =
      source === 'listed' ? selectedListing?.listing.inscription_number : Number.NaN;
    if (source === 'listed' && !selectedListing) return setError('Choose one active listing.');
    if (source === 'creator-fronted' && (!frontedIntentId || !frontedInscriptionNumber))
      return setError('Enter the OMB number and confirmed gallery purchase ID.');
    if (!maxCost || !/^\d+$/.test(maxCost))
      return setError('Enter the maximum total cost in sats.');
    if (!consent || (mode === 'anchored' && !anchorAccepted))
      return setError('Complete the required confirmations.');
    const now = Math.floor(Date.now() / 1000);
    const payload: CreateCampaignPayloadV1 = {
      protocol: COMMUNITY_PURCHASES_PROTOCOL,
      version: 1,
      network: 'mainnet',
      action: 'create-campaign',
      campaignId,
      creatorOwnerId: ownerId,
      inscriptionNumber:
        source === 'listed' ? inscriptionNumber! : Number(frontedInscriptionNumber),
      source,
      ownershipMode: mode,
      eligibilityMode: eligibility,
      creatorUnits,
      maxLandedCostSats: maxCost,
      listingId: selectedListing?.option.listing_id ?? null,
      marketplace: selectedListing?.option.marketplace ?? null,
      frontedBuyIntentId: source === 'creator-fronted' ? Number(frontedIntentId) : null,
      payoutAddress: payoutAddress || wallet.payAddr || '',
      enrollment,
      recoveryConfirmed: true,
      permanentAnchorAccepted: mode === 'anchored' ? anchorAccepted : false,
      identityDisclosureConsent: true,
      termsVersion: COMMUNITY_PURCHASES_TERMS_VERSION,
      expiresAt: now + (source === 'listed' ? 60 * 60 : 72 * 60 * 60),
      nonce: newActionNonce(),
    };
    setBusy(true);
    try {
      const signature = await signMessage(wallet.ordAddr, communityMessage(payload));
      const response = await fetch('/api/community/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload, signature }),
      });
      const json = (await response.json().catch(() => null)) as {
        campaign?: CommunityCampaignView;
        error?: string;
      } | null;
      if (!response.ok || !json?.campaign)
        throw new Error(json?.error ?? 'Could not create campaign.');
      router.push(`/community/${json.campaign.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create campaign.');
    } finally {
      setBusy(false);
    }
  }
}

function Field({
  label,
  className = '',
  onChange,
  ...props
}: { label: string; className?: string; onChange(value: string): void } & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'onChange'
>) {
  return (
    <label
      className={`block font-mono text-[10px] uppercase tracking-[0.08em] text-bone-dim ${className}`}
    >
      {label}
      <input
        {...props}
        onChange={event => onChange(event.target.value)}
        className="mt-1 h-11 w-full border border-ink-2 bg-ink-0 px-3 text-xs text-bone outline-none focus:border-bone disabled:opacity-60"
      />
    </label>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  options: Array<[string, string]>;
}) {
  return (
    <label className="block font-mono text-[10px] uppercase tracking-[0.08em] text-bone-dim">
      {label}
      <select
        value={value}
        onChange={event => onChange(event.target.value)}
        className="mt-1 h-11 w-full border border-ink-2 bg-ink-0 px-3 text-xs text-bone outline-none focus:border-bone"
      >
        {options.map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>
    </label>
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
    <label className="mt-4 flex cursor-pointer items-start gap-3 text-xs leading-relaxed text-bone-dim">
      <input
        type="checkbox"
        checked={checked}
        onChange={event => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 accent-white"
      />
      <span>{label}</span>
    </label>
  );
}

function CopyValue({ value }: { value: string }) {
  return (
    <button
      type="button"
      onClick={() => void navigator.clipboard.writeText(value)}
      className="break-all text-left text-bone underline decoration-ink-2 underline-offset-4 hover:decoration-bone"
      title="Copy"
    >
      {value}
    </button>
  );
}
