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
            OMB Wiki is an informational interface for discovering and buying listed ordinal
            inscriptions through third-party marketplace infrastructure.
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
            Listings, prices, ownership state, and marketplace availability can change at any time.
            A buy may fail if a listing is pulled, filled, repriced, or rejected by Satflow or the
            Bitcoin network.
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
