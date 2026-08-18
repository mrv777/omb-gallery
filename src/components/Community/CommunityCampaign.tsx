'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import SafeImg from '@/components/SafeImg';
import { useWallet } from '@/components/wallet/WalletProvider';
import { DREY_MIN_COMMUNITY_VERSION, isDreyCommunitySupported } from '@/lib/wallet/satsConnect';
import {
  COMMUNITY_PURCHASES_PROTOCOL,
  COMMUNITY_PURCHASES_TERMS_VERSION,
  communityMessage,
  newActionNonce,
  type CommunityCampaignView,
  type CommunityEnrollmentV1,
  type ConfirmReadinessPayloadV1,
  type ReserveUnitsPayloadV1,
} from '@/lib/community-purchases/contracts';
import { formatBtcCompact, formatTimeUntil, truncateAddr } from '@/lib/format';
import { lookupInscription } from '@/lib/inscriptionLookup';

export default function CommunityCampaign({
  initial,
  initialOwnerId,
}: {
  initial: CommunityCampaignView;
  initialOwnerId: string;
}) {
  const router = useRouter();
  const { wallet, signMessage } = useWallet();
  const [campaign, setCampaign] = useState(initial);
  const ownerId = initialOwnerId;
  const [units, setUnits] = useState('1');
  const [maxContribution, setMaxContribution] = useState(() =>
    String(Math.ceil(Number(initial.maxLandedCostSats) / 100))
  );
  const [qualifying, setQualifying] = useState('');
  const [payout, setPayout] = useState('');
  const [enrollmentText, setEnrollmentText] = useState('');
  const [noAlt, setNoAlt] = useState(false);
  const [consent, setConsent] = useState(false);
  const [funding, setFunding] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const image = lookupInscription(campaign.inscriptionNumber);
  const me = wallet
    ? campaign.participants.find(item => item.walletAddress === wallet.ordAddr)
    : null;
  const canJoin = campaign.status === 'open' && !me;
  const canReady =
    campaign.status === 'readiness' &&
    !!me &&
    me.allocatedUnits.length > 0 &&
    me.readiness !== 'ready';
  const dreyReady = wallet ? isDreyCommunitySupported(wallet) : false;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-10 sm:px-6">
      <button
        type="button"
        onClick={() => router.push('/community')}
        className="mb-4 font-mono text-[10px] uppercase tracking-[0.1em] text-bone-dim hover:text-bone"
      >
        ← all campaigns
      </button>
      <section className="grid gap-6 border-b border-ink-2 pb-7 md:grid-cols-[220px_minmax(0,1fr)]">
        <div className="aspect-square overflow-hidden bg-ink-1">
          {image ? (
            <SafeImg
              src={image.full}
              alt={`OMB ${campaign.inscriptionNumber}`}
              className="h-full w-full object-cover"
            />
          ) : null}
        </div>
        <div>
          <div className="flex flex-wrap items-center gap-2 font-mono text-[9px] uppercase tracking-[0.1em] text-bone-dim">
            <span className="border border-ink-2 px-2 py-1 text-bone">{campaign.status}</span>
            <span>{campaign.source}</span>
            <span>·</span>
            <span>{campaign.ownershipMode}</span>
            <span>·</span>
            <span>{campaign.eligibilityMode === 'anyone' ? 'anyone' : 'holders only'}</span>
          </div>
          <h1 className="mt-3 text-3xl text-bone sm:text-4xl">OMB {campaign.inscriptionNumber}</h1>
          <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.08em] text-bone-dim">
            {formatBtcCompact(Number(campaign.maxLandedCostSats))} maximum · no platform fee
          </p>
          <div
            className="mt-6 h-2 overflow-hidden bg-ink-2"
            aria-label={`${campaign.allocatedUnitCount} of 100 units assigned`}
          >
            <div
              className="h-full bg-accent-green"
              style={{ width: `${campaign.allocatedUnitCount}%` }}
            />
          </div>
          <div className="mt-2 flex flex-wrap justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.08em] text-bone-dim">
            <span>
              {campaign.allocatedUnitCount}/100 assigned
              {campaign.waitlistedUnitCount ? ` · ${campaign.waitlistedUnitCount} waitlisted` : ''}
            </span>
            {['open', 'readiness'].includes(campaign.status) && (
              <span>{formatTimeUntil(campaign.readinessDeadline ?? campaign.expiresAt)}</span>
            )}
          </div>
          {campaign.ownershipMode === 'anchored' && (
            <p className="mt-5 border-l-2 border-accent-orange pl-3 text-xs leading-relaxed text-bone-dim">
              The creator permanently holds 33 units. The other 67 units cannot move this OMB
              without at least two creator signatures.
            </p>
          )}
        </div>
      </section>

      <section className="mt-7 grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 className="font-mono text-sm uppercase tracking-[0.1em] text-bone">
                Public cap table
              </h2>
              <p className="mt-1 text-xs text-bone-dim">
                Confirmed Matrica siblings count together. On-chain links are warnings only.
              </p>
            </div>
            <span className="font-mono text-[9px] uppercase text-bone-dim">
              v{campaign.capTableVersion}
            </span>
          </div>
          <div className="mt-4 overflow-x-auto border border-ink-2">
            <table className="w-full min-w-[620px] border-collapse text-left font-mono text-[10px] uppercase tracking-[0.06em]">
              <thead className="bg-ink-1 text-bone-dim">
                <tr>
                  <th className="p-3 font-normal">owner</th>
                  <th className="p-3 font-normal">wallet / payout</th>
                  <th className="p-3 font-normal">units</th>
                  <th className="p-3 font-normal">state</th>
                </tr>
              </thead>
              <tbody>
                {campaign.participants.map(participant => (
                  <tr key={participant.ownerId} className="border-t border-ink-2 align-top">
                    <td className="p-3 text-bone">
                      <div>{participant.identityLabel}</div>
                      <div className="mt-1 text-[8px] text-bone-dim">
                        {participant.isCreator ? 'creator' : 'contributor'}
                        {participant.inferredLinks.length ? ' · inferred links ⚠' : ''}
                      </div>
                    </td>
                    <td className="p-3 text-bone-dim">
                      <div title={participant.walletAddress}>
                        {truncateAddr(participant.walletAddress, 8, 6)}
                      </div>
                      <div className="mt-1" title={participant.payoutAddress}>
                        pays {truncateAddr(participant.payoutAddress, 8, 6)}
                      </div>
                    </td>
                    <td className="p-3 text-bone">
                      <div>{participant.allocatedUnits.length}%</div>
                      {participant.waitlistedUnits > 0 && (
                        <div className="mt-1 text-[8px] text-bone-dim">
                          +{participant.waitlistedUnits} waitlist
                        </div>
                      )}
                    </td>
                    <td className="p-3 text-bone-dim">
                      {participant.allocatedUnits.length ? participant.readiness : 'waitlisted'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {campaign.participants.some(item => item.inferredLinks.length > 0) && (
            <div className="mt-3 border border-accent-orange/40 p-3 text-[11px] leading-relaxed text-bone-dim">
              <span className="font-mono uppercase text-accent-orange">Probabilistic warning:</span>{' '}
              one or more wallets have strong on-chain links to other wallets. These links do not
              merge identities, block participation, or prove common control.
            </div>
          )}

          {campaign.policyId && (
            <div className="mt-6 border border-ink-2 bg-ink-1 p-4">
              <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-accent-green">
                Cap table frozen
              </div>
              <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
                <KeyValue label="vault address" value={campaign.vaultAddress ?? ''} />
                <KeyValue label="policy ID" value={campaign.policyId} />
                <KeyValue label="cap-table hash" value={campaign.capTableHash ?? ''} />
                <KeyValue
                  label="policy"
                  value="69-of-100 · one Taproot script path · no key path"
                />
              </dl>
              <button
                type="button"
                onClick={() =>
                  void navigator.clipboard.writeText(JSON.stringify(campaign.policy, null, 2))
                }
                className="mt-4 h-9 border border-bone-dim px-3 font-mono text-[9px] uppercase tracking-[0.08em] text-bone hover:border-bone"
              >
                copy Drey policy package
              </button>
            </div>
          )}
        </div>

        <aside>
          {canJoin && <JoinPanel />}
          {canReady && <ReadinessPanel />}
          {me && !canReady && (
            <div className="border border-ink-2 bg-ink-1 p-4">
              <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-accent-green">
                You joined
              </div>
              <p className="mt-2 text-xs leading-relaxed text-bone-dim">
                {me.allocatedUnits.length
                  ? `${me.allocatedUnits.length} units assigned.`
                  : 'Your reservation is waitlisted.'}{' '}
                {me.readiness === 'ready' ? 'Readiness confirmed.' : ''}
              </p>
            </div>
          )}
          {!wallet && (
            <div className="border border-ink-2 bg-ink-1 p-4 font-mono text-[10px] uppercase leading-relaxed text-bone-dim">
              Connect Drey above to join or confirm readiness.
            </div>
          )}
          <div className="mt-4 border border-ink-2 p-4 text-[11px] leading-relaxed text-bone-dim">
            <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-bone">
              Plain rules
            </div>
            <ul className="mt-3 space-y-2">
              <li>• one unit = 1% of sale proceeds</li>
              <li>• units cannot be sold or redeemed separately</li>
              <li>• reservations never move BTC</li>
              <li>• 69 units can authorize the whole OMB</li>
              <li>• Drey and the gallery have no vault key</li>
            </ul>
            <p className="mt-3 border-t border-ink-2 pt-3">
              Bitcoin does not guarantee minority payout against a malicious 69-unit coalition.
            </p>
          </div>
        </aside>
      </section>
    </div>
  );

  function JoinPanel() {
    const unitCount = Math.max(1, Math.min(20, Number(units) || 1));
    return (
      <div className="border border-ink-2 bg-ink-1 p-4">
        <div className="font-mono text-sm uppercase tracking-[0.1em] text-bone">Reserve units</div>
        {!dreyReady && (
          <p className="mt-3 border border-accent-orange/50 p-3 font-mono text-[9px] uppercase leading-relaxed text-accent-orange">
            {wallet?.providerId === 'drey'
              ? `Update to Drey ${DREY_MIN_COMMUNITY_VERSION} or newer, then reconnect.`
              : 'Reconnect with Drey to join.'}
          </p>
        )}
        <div className="mt-4 grid grid-cols-2 gap-3">
          <Field
            label="units · max 20"
            value={units}
            onChange={value => {
              setUnits(value);
              const count = Math.max(1, Math.min(20, Number(value) || 1));
              setMaxContribution(
                String(Math.ceil((Number(campaign.maxLandedCostSats) * count) / 100))
              );
            }}
          />
          <Field label="max sats" value={maxContribution} onChange={setMaxContribution} />
        </div>
        {campaign.eligibilityMode === 'omb-holders-only' && (
          <Field
            className="mt-3"
            label="qualifying OMB number"
            value={qualifying}
            onChange={setQualifying}
          />
        )}
        <Field
          className="mt-3"
          label="payout address"
          value={payout || wallet?.payAddr || ''}
          onChange={setPayout}
        />
        <div className="mt-4 border-l-2 border-accent-blue bg-ink-0 p-3 text-[11px] leading-relaxed text-bone-dim">
          In Drey, create a Community Vault owner with:
          <br />
          campaign <CopyValue value={campaign.id} />
          <br />
          owner <CopyValue value={ownerId} />
          <br />
          Finish recovery, then paste the enrollment package.
        </div>
        <textarea
          value={enrollmentText}
          onChange={event => setEnrollmentText(event.target.value)}
          rows={5}
          placeholder="paste Drey enrollment package"
          className="mt-3 w-full resize-y border border-ink-2 bg-ink-0 p-3 font-mono text-[9px] text-bone outline-none placeholder:text-bone-dim/50 focus:border-bone"
        />
        <Check
          checked={noAlt}
          onChange={setNoAlt}
          label="I am not participating through another identity I control in this campaign."
        />
        <Check
          checked={consent}
          onChange={setConsent}
          label="I consent to the public identity and wallet display described above."
        />
        <Feedback />
        <button
          type="button"
          disabled={busy || !dreyReady}
          onClick={() => void join(unitCount)}
          className="mt-4 h-10 w-full border border-bone bg-bone font-mono text-[10px] uppercase tracking-[0.1em] text-ink-0 disabled:opacity-40"
        >
          {busy ? 'signing…' : 'sign reservation'}
        </button>
      </div>
    );
  }

  function ReadinessPanel() {
    return (
      <div className="border border-accent-green/50 bg-ink-1 p-4">
        <div className="font-mono text-sm uppercase tracking-[0.1em] text-accent-green">
          Confirm readiness
        </div>
        <p className="mt-2 text-xs leading-relaxed text-bone-dim">
          In Drey, select clean cardinal funding inputs for this purchase. Paste only their
          outpoints here; BTC still does not move.
        </p>
        <textarea
          value={funding}
          onChange={event => setFunding(event.target.value)}
          rows={4}
          placeholder="txid:vout · one per line"
          className="mt-3 w-full border border-ink-2 bg-ink-0 p-3 font-mono text-[9px] text-bone outline-none focus:border-bone"
        />
        <Feedback />
        <button
          type="button"
          disabled={busy || !dreyReady}
          onClick={() => void ready()}
          className="mt-4 h-10 w-full border border-accent-green bg-accent-green font-mono text-[10px] uppercase tracking-[0.1em] text-ink-0 disabled:opacity-40"
        >
          {busy ? 'signing…' : 'confirm ready'}
        </button>
      </div>
    );
  }

  function Feedback() {
    return (
      <>
        {error && (
          <p role="alert" className="mt-3 text-[10px] text-accent-red">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="mt-3 text-[10px] text-accent-green">
            {notice}
          </p>
        )}
      </>
    );
  }

  async function join(requestedUnits: number) {
    setError(null);
    setNotice(null);
    if (!wallet || !isDreyCommunitySupported(wallet))
      return setError(`Drey ${DREY_MIN_COMMUNITY_VERSION} or newer is required.`);
    if (!noAlt || !consent) return setError('Complete both confirmations.');
    let enrollment: CommunityEnrollmentV1;
    try {
      enrollment = JSON.parse(enrollmentText) as CommunityEnrollmentV1;
    } catch {
      return setError('Paste the enrollment package copied from Drey.');
    }
    const now = Math.floor(Date.now() / 1000);
    const payload: ReserveUnitsPayloadV1 = {
      protocol: COMMUNITY_PURCHASES_PROTOCOL,
      version: 1,
      network: 'mainnet',
      action: 'reserve-units',
      campaignId: campaign.id,
      ownerId,
      requestedUnits,
      maxContributionSats: maxContribution,
      qualifyingInscriptionNumber:
        campaign.eligibilityMode === 'omb-holders-only' ? Number(qualifying) : null,
      payoutAddress: payout || wallet.payAddr || '',
      enrollment,
      recoveryConfirmed: true,
      noAlternateIdentityAttestation: true,
      identityDisclosureConsent: true,
      termsVersion: COMMUNITY_PURCHASES_TERMS_VERSION,
      capTableVersion: campaign.capTableVersion,
      expiresAt: now + 10 * 60,
      nonce: newActionNonce(),
    };
    await sendAction(`/api/community/campaigns/${campaign.id}/reservations`, payload);
  }

  async function ready() {
    setError(null);
    setNotice(null);
    if (!wallet || !me || !isDreyCommunitySupported(wallet))
      return setError(`Drey ${DREY_MIN_COMMUNITY_VERSION} or newer is required.`);
    const fundingOutpoints = funding
      .split(/[\s,]+/u)
      .map(value => value.trim())
      .filter(Boolean);
    const now = Math.floor(Date.now() / 1000);
    const payload: ConfirmReadinessPayloadV1 = {
      protocol: COMMUNITY_PURCHASES_PROTOCOL,
      version: 1,
      network: 'mainnet',
      action: 'confirm-readiness',
      campaignId: campaign.id,
      ownerId: me.ownerId,
      capTableVersion: campaign.capTableVersion,
      fundingOutpoints,
      confirmedAt: now,
      expiresAt: now + 10 * 60,
      nonce: newActionNonce(),
    };
    await sendAction(`/api/community/campaigns/${campaign.id}/readiness`, payload);
  }

  async function sendAction(
    url: string,
    payload: ReserveUnitsPayloadV1 | ConfirmReadinessPayloadV1
  ) {
    if (!wallet) return;
    setBusy(true);
    try {
      const signature = await signMessage(wallet.ordAddr, communityMessage(payload));
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload, signature }),
      });
      const json = (await response.json().catch(() => null)) as {
        campaign?: CommunityCampaignView;
        error?: string;
      } | null;
      if (!response.ok || !json?.campaign) throw new Error(json?.error ?? 'Request failed.');
      setCampaign(json.campaign);
      setNotice('Saved.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Request failed.');
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
      className={`block font-mono text-[9px] uppercase tracking-[0.08em] text-bone-dim ${className}`}
    >
      {label}
      <input
        {...props}
        onChange={event => onChange(event.target.value)}
        className="mt-1 h-10 w-full border border-ink-2 bg-ink-0 px-3 text-[11px] text-bone outline-none focus:border-bone"
      />
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
function CopyValue({ value }: { value: string }) {
  return (
    <button
      type="button"
      onClick={() => void navigator.clipboard.writeText(value)}
      className="break-all text-left font-mono text-[9px] text-bone underline decoration-ink-2 underline-offset-2"
    >
      {value}
    </button>
  );
}
function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[9px] uppercase tracking-[0.08em] text-bone-dim">{label}</dt>
      <dd className="mt-1 break-all font-mono text-[10px] text-bone">{value}</dd>
    </div>
  );
}
