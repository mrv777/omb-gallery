import {
  isCommunityEnrollmentFor,
  type CommunityCampaignSource,
  type CommunityEnrollmentV1,
  type CommunityOwnershipMode,
} from './contracts';

export function parseCommunityEnrollmentFor(
  value: string,
  campaignId: string,
  ownerId: string
): CommunityEnrollmentV1 | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isCommunityEnrollmentFor(parsed, campaignId, ownerId) ? parsed : null;
  } catch {
    return null;
  }
}

function isPositiveSafeInteger(value: string): boolean {
  if (!/^[1-9][0-9]*$/u.test(value)) return false;
  return Number.isSafeInteger(Number(value));
}

export function isGroupBuyFormReady(input: {
  dreyReady: boolean;
  payoutAddress: string;
  source: CommunityCampaignSource;
  hasSelectedListing: boolean;
  frontedInscriptionNumber: string;
  frontedIntentId: string;
  maxCost: string;
  enrollmentText: string;
  campaignId: string;
  ownerId: string;
  mode: CommunityOwnershipMode;
  creatorUnits: number;
  anchorAccepted: boolean;
  consent: boolean;
}): boolean {
  const sourceReady =
    input.source === 'listed'
      ? input.hasSelectedListing
      : isPositiveSafeInteger(input.frontedInscriptionNumber) &&
        isPositiveSafeInteger(input.frontedIntentId);
  const unitsReady =
    input.mode === 'anchored'
      ? input.creatorUnits === 33
      : Number.isInteger(input.creatorUnits) && input.creatorUnits >= 1 && input.creatorUnits <= 20;
  return (
    input.dreyReady &&
    input.payoutAddress.trim().length > 0 &&
    sourceReady &&
    unitsReady &&
    isPositiveSafeInteger(input.maxCost) &&
    parseCommunityEnrollmentFor(input.enrollmentText, input.campaignId, input.ownerId) !== null &&
    input.consent &&
    (input.mode !== 'anchored' || input.anchorAccepted)
  );
}
