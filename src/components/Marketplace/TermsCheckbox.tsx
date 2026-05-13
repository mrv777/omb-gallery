'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useWallet } from '@/components/wallet/WalletProvider';

export default function TermsCheckbox() {
  const { wallet, acceptTerms } = useWallet();
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (wallet?.acceptedTermsAt) {
    return (
      <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-bone-dim">
        terms accepted
      </div>
    );
  }

  return (
    <label className="flex items-start gap-2 font-mono text-[10px] uppercase tracking-[0.08em] text-bone-dim">
      <input
        type="checkbox"
        checked={checked}
        disabled={saving || !wallet}
        onChange={async e => {
          const next = e.currentTarget.checked;
          setChecked(next);
          setError(null);
          if (!next || !wallet) return;
          setSaving(true);
          try {
            await acceptTerms();
          } catch (err) {
            setChecked(false);
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setSaving(false);
          }
        }}
        className="mt-0.5 h-3 w-3 accent-bone"
      />
      <span>
        I understand this is a non-custodial Bitcoin transaction and accept the{' '}
        <Link href="/terms" className="text-bone underline underline-offset-4" target="_blank">
          terms
        </Link>
        .{error && <span className="mt-1 block text-accent-red">{error}</span>}
      </span>
    </label>
  );
}
