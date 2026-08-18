import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import type {
  CommunityVaultSalePlanV1,
  CommunityVaultSalePreflightV1,
} from '@drey/core/domain/community-vault/sale-contracts';
import type { CommunityVaultPolicyV1 } from '@drey/core/domain/community-vault/contracts';
import {
  confirmCommunitySaleSold,
  getReadyCommunitySale,
  publishCommunitySale,
  recordCommunitySaleBroadcast,
} from '@/lib/community-purchases/saleStore';
import { communityErrorResponse, requireCommunityEnabled } from '@/lib/community-purchases/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Body = {
  action?: unknown;
  campaign_id?: unknown;
  txid?: unknown;
  policy?: unknown;
  plan?: unknown;
  preflight?: unknown;
  buyer_funded_psbt_hex?: unknown;
};

export async function GET(request: NextRequest) {
  const disabled = requireCommunityEnabled();
  if (disabled) return disabled;
  if (!authorized(request)) {
    return NextResponse.json(
      { error: 'unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }
  try {
    const campaignId = request.nextUrl.searchParams.get('campaign_id');
    if (!campaignId) return NextResponse.json({ error: 'campaign_id required' }, { status: 400 });
    return NextResponse.json(
      { sale: getReadyCommunitySale(campaignId) },
      { headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (error) {
    return communityErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const disabled = requireCommunityEnabled();
  if (disabled) return disabled;
  if (!authorized(request)) {
    return NextResponse.json(
      { error: 'unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }
  try {
    const body = (await request.json().catch(() => null)) as Body | null;
    if (body?.action === 'record-broadcast') {
      if (typeof body.campaign_id !== 'string' || typeof body.txid !== 'string') {
        return NextResponse.json({ error: 'campaign_id and txid required' }, { status: 400 });
      }
      return NextResponse.json({
        campaign: recordCommunitySaleBroadcast({ campaignId: body.campaign_id, txid: body.txid }),
      });
    }
    if (body?.action === 'confirm-sold') {
      if (typeof body.campaign_id !== 'string') {
        return NextResponse.json({ error: 'campaign_id required' }, { status: 400 });
      }
      return NextResponse.json({
        campaign: await confirmCommunitySaleSold({ campaignId: body.campaign_id }),
      });
    }
    if (
      !body ||
      typeof body.campaign_id !== 'string' ||
      typeof body.buyer_funded_psbt_hex !== 'string' ||
      !body.policy ||
      !body.plan ||
      !body.preflight
    ) {
      return NextResponse.json({ error: 'invalid funded offer package' }, { status: 400 });
    }
    const campaign = publishCommunitySale({
      campaignId: body.campaign_id,
      policy: body.policy as CommunityVaultPolicyV1,
      plan: body.plan as CommunityVaultSalePlanV1,
      preflight: body.preflight as CommunityVaultSalePreflightV1,
      buyerFundedPsbtHex: body.buyer_funded_psbt_hex,
    });
    return NextResponse.json({ campaign }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return communityErrorResponse(error);
  }
}

function authorized(request: NextRequest): boolean {
  const expected = process.env.INTERNAL_POLL_SECRET;
  const actual = request.headers.get('authorization');
  if (!expected || !actual?.startsWith('Bearer ')) return false;
  const supplied = actual.slice('Bearer '.length);
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}
