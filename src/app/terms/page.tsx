import type { Metadata } from 'next';
import SubpageShell from '@/components/SubpageShell';

export const metadata: Metadata = {
  title: 'Terms',
  description: 'OMB Wiki marketplace terms.',
};

export const dynamic = 'force-dynamic';

export default function TermsPage() {
  return (
    <SubpageShell active="marketplace">
      <section className="mx-auto max-w-3xl px-4 pb-16 font-mono uppercase tracking-[0.08em] sm:px-6">
        <h1 className="mb-6 text-2xl text-bone">terms</h1>
        <div className="space-y-5 text-[11px] leading-relaxed text-bone-dim">
          <p>
            OMB Wiki is an informational interface for discovering, buying, and listing ordinal
            inscriptions through third-party marketplace infrastructure, including ord.net.
          </p>
          <p>
            Purchases are Bitcoin transactions. They are irreversible once broadcast. You are
            responsible for checking the inscription, price, fees, recipient address, and wallet
            approval prompt before signing.
          </p>
          <p>
            The site is non-custodial. It does not hold your Bitcoin, inscriptions, keys, seed
            phrase, or signed wallet approvals. Wallet signing happens in your wallet.
          </p>
          <p>
            Creating an ord.net listing requires separate wallet approvals for the inscription
            transfer, settlement, and recovery transactions. Review the inscription outpoint, payout
            address, price, seller proceeds, marketplace fee, expiration, sighash policy, and
            recovery destination shown by your wallet before signing.
          </p>
          <p>
            A listing may remain pending while ord.net indexes it. Delisting or expiration does not
            undo a completed Bitcoin transaction, and repricing requires removing the old listing
            before creating a new one. Never sign again after an uncertain submission until the
            listing state has been checked.
          </p>
          <p>
            Listings, prices, ownership state, and marketplace availability can change at any time.
            A buy or listing may fail if ownership changes, a listing is pulled, filled, repriced,
            expires, or is rejected by ord.net, Satflow, a wallet, or the Bitcoin network.
          </p>
          <p>
            Nothing here is financial, tax, legal, or investment advice. Use the marketplace only if
            you understand ordinal transactions and the risks of using Bitcoin mainnet.
          </p>
        </div>
      </section>
    </SubpageShell>
  );
}
