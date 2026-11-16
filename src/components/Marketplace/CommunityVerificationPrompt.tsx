import Link from 'next/link';
import type { ReactNode } from 'react';

export type MatricaState =
  | { status: 'loading' }
  | { status: 'linked'; username: string; placeholder: boolean }
  | { status: 'none' | 'unknown'; reason?: string };

type Props = {
  state: MatricaState;
  matricaUrl: string;
  discordInviteUrl: string;
  nexusVerificationEnabled: boolean;
};

export default function CommunityVerificationPrompt({
  state,
  matricaUrl,
  discordInviteUrl,
  nexusVerificationEnabled,
}: Props) {
  const discord = safeExternalUrl(discordInviteUrl);
  const matrica = safeExternalUrl(matricaUrl) ?? 'https://matrica.io/settings';
  const linked = state.status === 'linked' && !state.placeholder;

  return (
    <div className="space-y-4 text-[11px] leading-relaxed text-bone-dim">
      <div>
        <h2 className="mb-1 text-xs text-bone">meet the community</h2>
        <p>Join the Discord for collection news and holder channels.</p>
        {discord && (
          <div className="mt-3">
            <ExternalButton href={discord} primary>
              join Discord
            </ExternalButton>
          </div>
        )}
      </div>

      <div className="border-t border-ink-2 pt-4">
        <h3 className="mb-1 text-[10px] text-bone">holder verification</h3>
        <p>
          {nexusVerificationEnabled
            ? 'Verify through Matrica or Nexus to access holder roles. Link your wallet and Discord on your chosen service.'
            : 'Use the verification instructions in Discord to access holder roles.'}
        </p>
        <p className="mt-2" role="status" aria-live="polite">
          {linked ? (
            <>
              Matrica profile found: <span className="break-all text-bone">@{state.username}</span>.{' '}
              Discord verification is managed separately.
            </>
          ) : state.status === 'loading' ? (
            'Checking for a Matrica profile…'
          ) : state.status === 'unknown' ? (
            'We could not check your Matrica profile. You can still join Discord.'
          ) : (
            'No completed Matrica profile found for this wallet.'
          )}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <ExternalButton href={matrica}>
            {linked ? 'manage Matrica' : 'set up Matrica'}
          </ExternalButton>
          {nexusVerificationEnabled && (
            <ExternalButton href="https://ord.net/">set up Nexus on ORD.NET</ExternalButton>
          )}
        </div>
      </div>

      <p className="text-[10px]">
        Have an ORD.NET / Nexus profile?{' '}
        <Link
          href="/profile"
          className="text-bone underline underline-offset-2 hover:text-accent-orange"
        >
          Share it with the Archive
        </Link>
        . Public profile sharing is optional and separate from Discord verification.
      </p>
    </div>
  );
}

function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function ExternalButton({
  href,
  primary = false,
  children,
}: {
  href: string;
  primary?: boolean;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex min-h-10 items-center justify-center border px-3 text-center text-[10px] transition-colors ${
        primary
          ? 'border-bone text-bone hover:border-accent-orange hover:text-accent-orange'
          : 'border-ink-2 text-bone-dim hover:border-bone-dim hover:text-bone'
      }`}
    >
      {children}
    </a>
  );
}
