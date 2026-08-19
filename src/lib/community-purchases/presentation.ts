import type { CommunityCampaignStatus, CommunityParticipantView } from './contracts';

export function communityProgressLabel(status: CommunityCampaignStatus): 'reserved' | 'assigned' {
  return status === 'open' ? 'reserved' : 'assigned';
}

export function communityParticipantState(
  status: CommunityCampaignStatus,
  participant: Pick<CommunityParticipantView, 'allocatedUnits' | 'readiness'>
): string {
  if (participant.allocatedUnits.length === 0) return 'waitlisted';
  if (status === 'open') return 'reserved';
  if (status === 'readiness') {
    if (participant.readiness === 'ready') return 'ready';
    if (participant.readiness === 'timed-out') return 'timed out';
    return 'action needed';
  }
  if (['frozen', 'signing', 'broadcast', 'held', 'sold'].includes(status)) return 'owner';
  return participant.readiness;
}
