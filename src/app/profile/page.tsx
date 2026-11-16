import type { Metadata } from 'next';
import SubpageShell from '@/components/SubpageShell';
import ConnectWalletButton from '@/components/wallet/ConnectWalletButton';
import PublicProfileSettings from '@/components/Profile/PublicProfileSettings';

// Shared navigation reads search params; match the other dynamic subpages.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Profile & verification',
  description: 'Choose how your connected wallet appears in the OMB Archive.',
  robots: { index: false, follow: false },
};

export default function ProfilePage() {
  return (
    <SubpageShell headerControls={<ConnectWalletButton compact />}>
      <PublicProfileSettings />
    </SubpageShell>
  );
}
