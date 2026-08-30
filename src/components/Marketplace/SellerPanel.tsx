'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import ConnectWalletButton from '@/components/wallet/ConnectWalletButton';
import { useWallet } from '@/components/wallet/WalletProvider';
import { formatBtc, truncateAddr } from '@/lib/format';
import { retryAfterOrdnetAuthorization } from '@/lib/marketplace/ordnetAuthorization';
import {
  LISTING_DURATIONS,
  marketplaceApiError,
  normalizeListingPreflight,
  normalizeSellerOmbsPage,
  parseBtcPriceToSats,
  signListingSteps,
  type ListingDuration,
  type ListingPreflight,
  type SellerOmb,
} from '@/lib/marketplace/sellerClient';
import TermsCheckbox from './TermsCheckbox';

type Props = { open: boolean; onClose: () => void; onListingsChanged: () => void };
type SellerPhase = 'idle' | 'loading' | 'preparing' | 'signing' | 'submitting' | 'delisting';
type ApiResult = { ok: boolean; code: string | null; body: unknown };

export default function SellerPanel({ open, onClose, onListingsChanged }: Props) {
  const { wallet, signMessage, signPsbt } = useWallet();
  const [items, setItems] = useState<SellerOmb[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<SellerPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<SellerOmb | null>(null);
  const [price, setPrice] = useState('');
  const [duration, setDuration] = useState<ListingDuration>(90);
  const [preflight, setPreflight] = useState<ListingPreflight | null>(null);
  const [confirmDelistId, setConfirmDelistId] = useState<string | null>(null);
  const busy = phase !== 'idle' && phase !== 'loading';

  const load = useCallback(
    async (cursor?: string, signal?: AbortSignal) => {
      if (!wallet) {
        setItems([]);
        setNextCursor(null);
        return;
      }
      setPhase('loading');
      setError(null);
      try {
        const query = new URLSearchParams({ limit: '100' });
        if (cursor) query.set('cursor', cursor);
        const res = await fetch(`/api/marketplace/seller/ombs?${query}`, { signal });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw marketplaceApiError(body, 'Could not load your OMBs.');
        const page = normalizeSellerOmbsPage(body);
        setItems(current => (cursor ? [...current, ...page.items] : page.items));
        setNextCursor(page.next_cursor);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPhase(current => (current === 'loading' ? 'idle' : current));
      }
    },
    [wallet]
  );

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    // The controlled panel has no mount boundary, so opening it is the fetch trigger.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(undefined, controller.signal);
    return () => controller.abort();
  }, [load, open]);

  if (!open) return null;

  function closePanel() {
    if (busy) return;
    resetDraft();
    setError(null);
    setNotice(null);
    setConfirmDelistId(null);
    onClose();
  }

  async function prepareListing() {
    if (!wallet || !selected) return;
    setPhase('preparing');
    setError(null);
    setNotice(null);
    try {
      const { ordnetSellerProviderId } = await import('@/lib/wallet/satsConnect');
      const providerId = ordnetSellerProviderId(wallet);
      if (!providerId) {
        throw new Error(
          wallet.providerId === 'drey'
            ? 'Update Drey to a build with ord.net listing support, then reconnect.'
            : 'This wallet has not been verified for safe ord.net listing signatures.'
        );
      }
      const priceSats = parseBtcPriceToSats(price);
      const request = () =>
        postJson('/api/marketplace/listing/preflight', {
          inscription_number: selected.inscription_number,
          price_sats: priceSats,
          duration_days: duration,
          provider_id: providerId,
        });
      const result = await retryAfterOrdnetAuthorization(
        request,
        value =>
          !value.ok && (value.code === 'auth-required' || value.code === 'ordnet-auth-required'),
        signMessage
      );
      if (!result.ok) throw marketplaceApiError(result.body, 'Listing preflight failed.');
      setPreflight(normalizeListingPreflight(result.body));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPhase('idle');
    }
  }

  async function signAndSubmit() {
    if (!wallet || !preflight) return;
    setError(null);
    setNotice(null);
    try {
      const { ordnetSellerProviderId } = await import('@/lib/wallet/satsConnect');
      const providerId = ordnetSellerProviderId(wallet);
      if (!providerId) throw new Error('This wallet cannot safely create listings.');
      setPhase('signing');
      const signedPsbts = await signListingSteps(preflight.signing_steps, step =>
        signPsbt(step.psbt, step.sign_inputs, step.marketplace_context)
      );
      setPhase('submitting');
      const result = await postJson('/api/marketplace/listing/submit', {
        intent_id: preflight.intent_id,
        signed_psbts: signedPsbts,
        provider_id: providerId,
      });
      if (!result.ok) throw marketplaceApiError(result.body, 'Listing submission failed.');
      const response = asObject(result.body);
      const status = response.status === 'active' ? 'active' : 'pending indexing';
      setNotice(`OMB #${preflight.preview.inscription_number} listing is ${status}.`);
      resetDraft();
      await load();
      onListingsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPhase('idle');
    }
  }

  async function delist(item: SellerOmb) {
    if (!wallet || !item.active_listing) return;
    setPhase('delisting');
    setError(null);
    setNotice(null);
    try {
      const request = () =>
        postJson('/api/marketplace/listing/delist', {
          inscription_id: item.inscription_id,
          listing_id: item.active_listing!.listing_id,
        });
      const result = await retryAfterOrdnetAuthorization(
        request,
        value =>
          !value.ok && (value.code === 'auth-required' || value.code === 'ordnet-auth-required'),
        signMessage
      );
      if (!result.ok) throw marketplaceApiError(result.body, 'Delist failed.');
      const response = asObject(result.body);
      const status = response.status === 'absent' ? 'removed' : 'pending removal';
      setNotice(`OMB #${item.inscription_number} listing is ${status}.`);
      setConfirmDelistId(null);
      await load();
      onListingsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPhase('idle');
    }
  }

  function resetDraft() {
    setSelected(null);
    setPreflight(null);
    setPrice('');
    setDuration(90);
  }

  return (
    <div
      className="fixed inset-0 z-[1600] flex justify-end bg-ink-0/80 backdrop-blur-sm"
      onClick={closePanel}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="List an OMB"
        className="flex h-full w-full max-w-2xl flex-col border-l border-ink-2 bg-ink-0 font-mono uppercase tracking-[0.08em]"
        onClick={event => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-ink-2 px-4 py-3 sm:px-6">
          <div>
            <h2 className="text-lg text-bone">list OMB / my listings</h2>
            <p className="mt-1 text-[9px] text-bone-dim">powered by ord.net</p>
          </div>
          <button
            type="button"
            onClick={closePanel}
            disabled={busy}
            className="h-9 w-9 text-bone-dim hover:text-bone disabled:opacity-40"
            aria-label="Close seller panel"
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          {!wallet ? (
            <div className="border border-ink-2 p-5 text-center">
              <p className="mb-4 text-[11px] text-bone-dim">
                connect the wallet that controls your OMBs
              </p>
              <ConnectWalletButton />
            </div>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-ink-2 pb-4 text-[10px] text-bone-dim">
                <span>
                  seller <span className="text-bone">{truncateAddr(wallet.ordAddr, 9, 7)}</span>
                </span>
                <TermsCheckbox />
              </div>

              {error ? <SellerAlert tone="error">{error}</SellerAlert> : null}
              {notice ? <SellerAlert tone="notice">{notice}</SellerAlert> : null}

              {preflight ? (
                <ListingReview
                  preflight={preflight}
                  phase={phase}
                  onBack={() => setPreflight(null)}
                  onSubmit={() => void signAndSubmit()}
                />
              ) : selected ? (
                <ListingDraft
                  item={selected}
                  price={price}
                  duration={duration}
                  disabled={busy || !wallet.acceptedTermsAt}
                  onPriceChange={setPrice}
                  onDurationChange={setDuration}
                  onBack={resetDraft}
                  onPrepare={() => void prepareListing()}
                  phase={phase}
                />
              ) : (
                <OmbList
                  items={items}
                  phase={phase}
                  nextCursor={nextCursor}
                  confirmDelistId={confirmDelistId}
                  onList={item => {
                    setError(null);
                    setNotice(null);
                    setSelected(item);
                  }}
                  onConfirmDelist={setConfirmDelistId}
                  onDelist={item => void delist(item)}
                  onLoadMore={() => void load(nextCursor ?? undefined)}
                />
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function OmbList({
  items,
  phase,
  nextCursor,
  confirmDelistId,
  onList,
  onConfirmDelist,
  onDelist,
  onLoadMore,
}: {
  items: SellerOmb[];
  phase: SellerPhase;
  nextCursor: string | null;
  confirmDelistId: string | null;
  onList: (item: SellerOmb) => void;
  onConfirmDelist: (id: string | null) => void;
  onDelist: (item: SellerOmb) => void;
  onLoadMore: () => void;
}) {
  if (phase === 'loading' && items.length === 0) {
    return <div className="py-12 text-center text-[11px] text-bone-dim">loading your OMBs...</div>;
  }
  if (items.length === 0) {
    return (
      <div className="border border-ink-2 py-12 text-center text-[11px] text-bone-dim">
        no OMBs found for this ordinals address
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-[10px] leading-relaxed text-bone-dim">
        one OMB per listing. repricing requires delisting first.
      </p>
      {items.map(item => {
        const listing = item.active_listing;
        const confirming = listing?.listing_id === confirmDelistId;
        return (
          <article
            key={item.inscription_id}
            className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3 border border-ink-2 p-2 sm:grid-cols-[6rem_minmax(0,1fr)]"
          >
            <Link href={`/inscription/${item.inscription_number}`} target="_blank">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={item.thumbnail || item.full}
                alt={`OMB #${item.inscription_number}`}
                className="aspect-square w-full bg-ink-2 object-contain"
              />
            </Link>
            <div className="flex min-w-0 flex-col justify-between gap-2 py-1">
              <div>
                <div className="flex items-center justify-between gap-2 text-sm text-bone">
                  <span>#{item.inscription_number}</span>
                  {listing ? (
                    <span className="text-[9px] text-accent-green">{listing.status}</span>
                  ) : null}
                </div>
                {listing ? (
                  <div className="mt-2 text-[10px] text-bone-dim">
                    <span className="text-bone">{formatBtc(listing.price_sats)}</span> on ord.net
                    {listing.expires_at ? (
                      <span className="mt-1 block">expires {formatDate(listing.expires_at)}</span>
                    ) : null}
                  </div>
                ) : (
                  <p className="mt-2 text-[9px] leading-relaxed text-bone-dim">
                    {item.listable
                      ? 'available to list'
                      : item.listability_reasons.join(' · ') || 'not currently listable'}
                  </p>
                )}
              </div>
              {listing?.marketplace === 'ordnet' && listing.status === 'active' ? (
                confirming ? (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => onConfirmDelist(null)}
                      className="h-8 flex-1 border border-ink-2 text-[9px] text-bone-dim"
                    >
                      keep
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelist(item)}
                      disabled={phase === 'delisting'}
                      className="h-8 flex-1 border border-accent-red text-[9px] text-accent-red disabled:opacity-40"
                    >
                      confirm delist
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => onConfirmDelist(listing.listing_id)}
                    className="h-8 border border-ink-2 text-[9px] text-bone-dim hover:border-bone-dim hover:text-bone"
                  >
                    delist
                  </button>
                )
              ) : listing ? (
                <div className="border border-ink-2 px-2 py-2 text-center text-[9px] text-bone-dim">
                  {listing.status.replaceAll('_', ' ')}
                </div>
              ) : (
                <button
                  type="button"
                  disabled={!item.listable}
                  onClick={() => onList(item)}
                  className="h-8 border border-bone text-[9px] text-bone disabled:cursor-not-allowed disabled:border-ink-2 disabled:text-bone-dim"
                >
                  list OMB
                </button>
              )}
            </div>
          </article>
        );
      })}
      {nextCursor ? (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={phase === 'loading'}
          className="h-10 w-full border border-ink-2 text-[10px] text-bone-dim hover:border-bone-dim hover:text-bone disabled:opacity-40"
        >
          {phase === 'loading' ? 'loading...' : 'load more'}
        </button>
      ) : null}
    </div>
  );
}

function ListingDraft({
  item,
  price,
  duration,
  disabled,
  phase,
  onPriceChange,
  onDurationChange,
  onBack,
  onPrepare,
}: {
  item: SellerOmb;
  price: string;
  duration: ListingDuration;
  disabled: boolean;
  phase: SellerPhase;
  onPriceChange: (value: string) => void;
  onDurationChange: (value: ListingDuration) => void;
  onBack: () => void;
  onPrepare: () => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-4 text-[10px] text-bone-dim hover:text-bone"
      >
        ← my OMBs
      </button>
      <div className="flex items-center gap-3 border-b border-ink-2 pb-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.thumbnail || item.full}
          alt={`OMB #${item.inscription_number}`}
          className="h-20 w-20 bg-ink-2 object-contain"
        />
        <div>
          <h3 className="text-lg text-bone">OMB #{item.inscription_number}</h3>
          <p className="mt-1 break-all text-[9px] normal-case tracking-normal text-bone-dim">
            {item.current_output}
          </p>
        </div>
      </div>
      <label className="mt-5 block text-[10px] text-bone-dim">
        price in BTC
        <input
          type="text"
          inputMode="decimal"
          placeholder="0.10000000"
          value={price}
          onChange={event => onPriceChange(event.target.value)}
          className="mt-2 h-11 w-full border border-ink-2 bg-ink-0 px-3 text-sm text-bone outline-none focus:border-bone"
        />
      </label>
      <fieldset className="mt-5">
        <legend className="text-[10px] text-bone-dim">duration</legend>
        <div className="mt-2 grid grid-cols-5 gap-1">
          {LISTING_DURATIONS.map(days => (
            <button
              key={days}
              type="button"
              onClick={() => onDurationChange(days)}
              className={`h-10 border text-[10px] ${
                duration === days ? 'border-bone text-bone' : 'border-ink-2 text-bone-dim'
              }`}
            >
              {days}d
            </button>
          ))}
        </div>
      </fieldset>
      {!disabled ? null : (
        <p className="mt-4 text-[9px] leading-relaxed text-bone-dim">
          accept the marketplace terms before preparing a listing.
        </p>
      )}
      <div className="mt-6 flex gap-2 border-t border-ink-2 pt-4">
        <button
          type="button"
          onClick={onBack}
          className="h-10 flex-1 border border-ink-2 text-[10px] text-bone-dim"
        >
          cancel
        </button>
        <button
          type="button"
          disabled={disabled || !price.trim()}
          onClick={onPrepare}
          className="h-10 flex-1 border border-bone text-[10px] text-bone disabled:cursor-not-allowed disabled:border-ink-2 disabled:text-bone-dim"
        >
          {phase === 'preparing' ? 'preparing...' : 'review listing'}
        </button>
      </div>
    </div>
  );
}

function ListingReview({
  preflight,
  phase,
  onBack,
  onSubmit,
}: {
  preflight: ListingPreflight;
  phase: SellerPhase;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const { preview } = preflight;
  const busy = phase === 'signing' || phase === 'submitting';
  return (
    <div>
      <h3 className="text-lg text-bone">review OMB #{preview.inscription_number}</h3>
      <p className="mt-2 text-[10px] leading-relaxed text-accent-orange">
        your wallet will request 3 signatures: escrow transfer, settlement authorization, and
        recovery.
      </p>
      <dl className="mt-5 divide-y divide-ink-2 border-y border-ink-2 text-[10px]">
        <ReviewRow label="inscription" value={preview.inscription_id} wrap />
        <ReviewRow label="current output" value={preview.current_output} wrap />
        <ReviewRow label="postage" value={`${preview.postage_sats.toLocaleString()} sats`} />
        <ReviewRow label="payout" value={preview.payout_address} wrap />
        <ReviewRow label="asking price" value={formatBtc(preview.price_sats)} />
        <ReviewRow label="ord.net fee" value={formatBtc(preview.marketplace_fee_sats)} />
        <ReviewRow label="locked proceeds" value={formatBtc(preview.seller_proceeds_sats)} />
        <ReviewRow label="duration" value={`${preview.duration_days} days`} />
        <ReviewRow label="expires" value={formatDate(preview.expires_at)} />
      </dl>
      <p className="mt-4 text-[9px] normal-case leading-relaxed tracking-normal text-bone-dim">
        Check every wallet prompt. Bitcoin transactions are irreversible. A recovery transaction is
        prepared so the inscription can return to your wallet if needed.
      </p>
      <div className="mt-6 flex gap-2 border-t border-ink-2 pt-4">
        <button
          type="button"
          disabled={busy}
          onClick={onBack}
          className="h-10 flex-1 border border-ink-2 text-[10px] text-bone-dim disabled:opacity-40"
        >
          edit
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onSubmit}
          className="h-10 flex-1 border border-bone text-[10px] text-bone disabled:opacity-40"
        >
          {phase === 'signing'
            ? 'signing...'
            : phase === 'submitting'
              ? 'submitting...'
              : 'sign & list'}
        </button>
      </div>
    </div>
  );
}

function ReviewRow({
  label,
  value,
  wrap = false,
}: {
  label: string;
  value: string;
  wrap?: boolean;
}) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3 py-3">
      <dt className="text-bone-dim">{label}</dt>
      <dd
        className={`text-right text-bone ${wrap ? 'break-all normal-case tracking-normal' : 'tabular-nums'}`}
      >
        {value}
      </dd>
    </div>
  );
}

function SellerAlert({ children, tone }: { children: string; tone: 'error' | 'notice' }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`mb-4 border p-3 text-[10px] normal-case leading-relaxed tracking-normal ${
        tone === 'error'
          ? 'border-accent-red/50 bg-accent-red/10 text-accent-red'
          : 'border-accent-green/50 bg-accent-green/10 text-accent-green'
      }`}
    >
      {children}
    </div>
  );
}

async function postJson(url: string, body: unknown): Promise<ApiResult> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const responseBody = await res.json().catch(() => null);
  const data = asObject(responseBody);
  return { ok: res.ok, code: typeof data.code === 'string' ? data.code : null, body: responseBody };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function formatDate(timestamp: number): string {
  const milliseconds = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
    milliseconds
  );
}
