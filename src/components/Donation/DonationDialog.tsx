'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { QRCodeSVG } from 'qrcode.react';
import { copyText } from '@/lib/copyText';
import {
  DONATION_CONFIG,
  buildDonationUri,
  donationWalletAvailability,
  satsToBtc,
  validateDonationSats,
  type DonationWalletKey,
  type ProviderWindow,
} from '@/lib/donation';
import { DonationWalletError, sendDonation } from '@/lib/donationWallet';

type PaymentState =
  | { kind: 'idle' }
  | { kind: 'submitting'; wallet: DonationWalletKey }
  | { kind: 'error'; message: string }
  | { kind: 'success'; txid: string };

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function DonationDialog({ onClose }: { onClose: () => void }) {
  const [amountInput, setAmountInput] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const [payment, setPayment] = useState<PaymentState>({ kind: 'idle' });
  const [wallets, setWallets] = useState(() =>
    donationWalletAvailability(window as unknown as ProviderWindow)
  );
  const dialogRef = useRef<HTMLDivElement>(null);
  const copyTimerRef = useRef<number | null>(null);
  const paymentInFlightRef = useRef(false);
  const validation = validateDonationSats(amountInput);
  const donationUri = buildDonationUri(validation.sats);
  const selectedSats = validation.sats;

  const refreshWallets = useCallback(() => {
    setWallets(donationWalletAvailability(window as unknown as ProviderWindow));
  }, []);

  useEffect(() => {
    dialogRef.current?.focus();
    window.addEventListener('focus', refreshWallets);
    window.addEventListener('sqrl#initialized', refreshWallets);
    return () => {
      window.removeEventListener('focus', refreshWallets);
      window.removeEventListener('sqrl#initialized', refreshWallets);
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
    };
  }, [refreshWallets]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (payment.kind !== 'submitting') onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [onClose, payment.kind]);

  const copyAddress = useCallback(async () => {
    if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
    try {
      await copyText(DONATION_CONFIG.address);
      setCopyState('copied');
      copyTimerRef.current = window.setTimeout(() => setCopyState('idle'), 1600);
    } catch {
      setCopyState('error');
      copyTimerRef.current = window.setTimeout(() => setCopyState('idle'), 2200);
    }
  }, []);

  const payWithWallet = useCallback(
    async (wallet: DonationWalletKey) => {
      if (selectedSats == null || paymentInFlightRef.current) return;
      paymentInFlightRef.current = true;
      setPayment({ kind: 'submitting', wallet });
      try {
        const result = await sendDonation(wallet, selectedSats);
        setPayment({ kind: 'success', txid: result.txid });
      } catch (error) {
        const message =
          error instanceof DonationWalletError
            ? error.message
            : 'The wallet could not complete the payment.';
        setPayment({ kind: 'error', message });
      } finally {
        paymentInFlightRef.current = false;
      }
    },
    [selectedSats]
  );

  return createPortal(
    <div
      className="fixed inset-0 z-[2100] flex items-start justify-center overflow-y-auto bg-ink-0/85 px-4 py-5 backdrop-blur-sm sm:items-center sm:px-6 sm:py-8"
      onMouseDown={event => {
        if (event.target === event.currentTarget && payment.kind !== 'submitting') onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="donation-title"
        aria-describedby="donation-description"
        tabIndex={-1}
        className="w-full max-w-3xl border border-ink-2 bg-ink-1 p-5 font-mono text-xs uppercase tracking-[0.08em] shadow-[0_20px_60px_rgba(0,0,0,0.85)] outline-none sm:p-7"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="donation-title" className="text-lg text-bone sm:text-xl">
              support the archive
            </h2>
            <p
              id="donation-description"
              className="mt-2 max-w-xl text-[11px] normal-case leading-relaxed tracking-normal text-bone-dim"
            >
              Donations help cover indexing, hosting, and continued development of the OMB Archive.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={payment.kind === 'submitting'}
            className="flex h-8 w-8 shrink-0 items-center justify-center text-bone-dim transition-colors hover:text-bone disabled:opacity-30"
            aria-label="Close donation dialog"
          >
            ✕
          </button>
        </div>

        {payment.kind === 'success' ? (
          <SuccessState txid={payment.txid} onClose={onClose} />
        ) : (
          <div className="mt-6 grid gap-7 md:grid-cols-[minmax(0,1fr)_15rem]">
            <div>
              <fieldset disabled={payment.kind === 'submitting'}>
                <legend className="text-[10px] tracking-[0.12em] text-bone-dim">
                  choose an amount
                </legend>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {DONATION_CONFIG.presetSats.map(preset => {
                    const active = selectedSats === preset && validation.error == null;
                    return (
                      <button
                        key={preset}
                        type="button"
                        aria-pressed={active}
                        onClick={() => {
                          setAmountInput(String(preset));
                          setPayment({ kind: 'idle' });
                        }}
                        className={`h-10 border px-2 text-[10px] transition-colors ${
                          active
                            ? 'border-bone bg-bone text-ink-0'
                            : 'border-ink-2 text-bone hover:border-bone-dim'
                        }`}
                      >
                        {preset.toLocaleString()} sats
                      </button>
                    );
                  })}
                </div>

                <label
                  htmlFor="donation-amount"
                  className="mt-5 block text-[10px] tracking-[0.12em] text-bone-dim"
                >
                  custom amount in sats
                </label>
                <input
                  id="donation-amount"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={amountInput}
                  onChange={event => {
                    setAmountInput(event.target.value);
                    setPayment({ kind: 'idle' });
                  }}
                  placeholder={`minimum ${DONATION_CONFIG.minimumWalletSats.toLocaleString()}`}
                  aria-invalid={validation.error != null}
                  aria-describedby={validation.error ? 'donation-amount-error' : undefined}
                  className="mt-2 h-11 w-full border border-ink-2 bg-ink-0 px-3 text-sm tracking-normal text-bone outline-none placeholder:text-bone-dim focus:border-bone"
                />
                <div className="mt-2 min-h-5 text-[10px] normal-case tracking-normal">
                  {validation.error ? (
                    <p id="donation-amount-error" className="text-accent-red">
                      {validation.error}
                    </p>
                  ) : selectedSats != null ? (
                    <p className="text-bone-dim">
                      {satsToBtc(selectedSats)} BTC before network fee
                    </p>
                  ) : (
                    <p className="text-bone-dim">
                      Choose an amount for a browser wallet. QR and copy work without one.
                    </p>
                  )}
                </div>
              </fieldset>

              <div className="mt-5 grid gap-2 sm:grid-cols-2 md:grid-cols-1 lg:grid-cols-2">
                {(Object.keys(DONATION_CONFIG.wallets) as DonationWalletKey[]).map(wallet => (
                  <WalletAction
                    key={wallet}
                    wallet={wallet}
                    installed={wallets[wallet]}
                    disabled={selectedSats == null || payment.kind === 'submitting'}
                    submitting={payment.kind === 'submitting' && payment.wallet === wallet}
                    onPay={payWithWallet}
                  />
                ))}
              </div>

              <div aria-live="polite" role="status" className="mt-3 min-h-5">
                {payment.kind === 'error' ? (
                  <p className="text-[10px] normal-case tracking-normal text-accent-red">
                    {payment.message}
                  </p>
                ) : payment.kind === 'submitting' ? (
                  <p className="text-[10px] normal-case tracking-normal text-bone-dim">
                    Review the address, amount, and network fee in{' '}
                    {DONATION_CONFIG.wallets[payment.wallet].name}.
                  </p>
                ) : null}
              </div>
            </div>

            <div className="min-w-0">
              <div className="mx-auto w-full max-w-60 bg-white p-1">
                <QRCodeSVG
                  value={donationUri}
                  size={240}
                  level="M"
                  marginSize={4}
                  bgColor="#ffffff"
                  fgColor="#000000"
                  title={
                    selectedSats == null
                      ? 'Scan to donate bitcoin to OMB Archive'
                      : `Scan to donate ${selectedSats.toLocaleString()} sats to OMB Archive`
                  }
                  className="h-auto w-full"
                />
              </div>
              <p className="mt-3 break-all text-center text-[9px] normal-case leading-relaxed tracking-normal text-bone">
                {DONATION_CONFIG.address}
              </p>
              <button
                type="button"
                onClick={copyAddress}
                className={`mt-3 h-9 w-full border text-[10px] transition-colors ${
                  copyState === 'copied'
                    ? 'border-accent-green text-accent-green'
                    : copyState === 'error'
                      ? 'border-accent-red text-accent-red'
                      : 'border-ink-2 text-bone hover:border-bone-dim'
                }`}
              >
                {copyState === 'copied'
                  ? 'address copied'
                  : copyState === 'error'
                    ? 'copy failed'
                    : 'copy address'}
              </button>
              <span className="sr-only" aria-live="polite">
                {copyState === 'copied'
                  ? 'Donation address copied'
                  : copyState === 'error'
                    ? 'Donation address copy failed'
                    : ''}
              </span>
            </div>
          </div>
        )}

        <p className="mt-6 border-t border-ink-2 pt-4 text-[10px] normal-case leading-relaxed tracking-normal text-bone-dim">
          Bitcoin payments are irreversible. Confirm the complete address, amount, and network fee
          in your wallet before approving.
        </p>
      </div>
    </div>,
    document.body
  );
}

function WalletAction({
  wallet,
  installed,
  disabled,
  submitting,
  onPay,
}: {
  wallet: DonationWalletKey;
  installed: boolean;
  disabled: boolean;
  submitting: boolean;
  onPay: (wallet: DonationWalletKey) => void;
}) {
  const config = DONATION_CONFIG.wallets[wallet];
  if (!installed) {
    return (
      <a
        href={config.installUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex h-11 items-center justify-center border border-ink-2 text-[10px] text-bone-dim transition-colors hover:border-bone-dim hover:text-bone"
      >
        install {config.name}
      </a>
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onPay(wallet)}
      className="h-11 border border-bone text-[10px] text-bone transition-colors hover:bg-bone hover:text-ink-0 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-bone"
    >
      {submitting ? `opening ${config.name}…` : `pay with ${config.name}`}
    </button>
  );
}

function SuccessState({ txid, onClose }: { txid: string; onClose: () => void }) {
  const txUrl = `https://mempool.space/tx/${txid}`;
  return (
    <div className="mt-8 border border-accent-green/50 bg-accent-green/5 p-5">
      <h3 className="text-accent-green">thank you for supporting the archive</h3>
      <p className="mt-3 text-[10px] normal-case tracking-normal text-bone-dim">
        Your wallet broadcast the transaction.
      </p>
      <p className="mt-3 break-all text-[10px] normal-case tracking-normal text-bone">{txid}</p>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <a
          href={txUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-10 items-center border border-ink-2 px-3 text-[10px] text-bone transition-colors hover:border-bone-dim"
        >
          view on mempool.space ↗
        </a>
        <button
          type="button"
          onClick={onClose}
          className="h-10 border border-bone px-4 text-[10px] text-bone transition-colors hover:bg-bone hover:text-ink-0"
        >
          done
        </button>
      </div>
    </div>
  );
}
