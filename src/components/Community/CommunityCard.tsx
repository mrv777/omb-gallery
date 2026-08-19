import Link from 'next/link';
import type { CommunityCampaignView } from '@/lib/community-purchases/contracts';
import { formatBtcCompact, formatTimeUntil } from '@/lib/format';
import { lookupInscription } from '@/lib/inscriptionLookup';
import SafeImg from '@/components/SafeImg';

export default function CommunityCard({ campaign }: { campaign: CommunityCampaignView }) {
  const image = lookupInscription(campaign.inscriptionNumber);
  const percent = Math.max(0, Math.min(100, campaign.allocatedUnitCount));
  return (
    <Link
      href={`/community/${campaign.id}`}
      className="group grid grid-cols-[88px_minmax(0,1fr)] gap-4 border border-ink-2 bg-ink-1 p-3 transition-colors hover:border-bone-dim"
    >
      <div className="aspect-square overflow-hidden bg-ink-2">
        {image ? (
          <SafeImg
            src={image.thumbnail}
            alt={`OMB ${campaign.inscriptionNumber}`}
            className="h-full w-full object-cover"
          />
        ) : null}
      </div>
      <div className="min-w-0 font-mono uppercase tracking-[0.08em]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm text-bone">OMB {campaign.inscriptionNumber}</div>
            <div className="mt-1 text-[9px] text-bone-dim">
              {campaign.ownershipMode} ·{' '}
              {campaign.eligibilityMode === 'anyone' ? 'anyone' : 'holders only'}
            </div>
          </div>
          <span className="border border-ink-2 px-1.5 py-0.5 text-[9px] text-bone-dim">
            {campaign.status}
          </span>
        </div>
        <div
          className="mt-4 h-1.5 overflow-hidden bg-ink-2"
          aria-label={`${percent} units assigned`}
        >
          <div
            className="h-full bg-accent-green transition-[width]"
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="mt-2 flex justify-between text-[9px] text-bone-dim">
          <span>{campaign.allocatedUnitCount}/100 units</span>
          <span>{formatBtcCompact(Number(campaign.maxLandedCostSats))} max</span>
        </div>
        {['open', 'readiness'].includes(campaign.status) && (
          <div className="mt-1 text-[9px] text-bone-dim">
            closes {formatTimeUntil(campaign.expiresAt)}
          </div>
        )}
      </div>
    </Link>
  );
}
