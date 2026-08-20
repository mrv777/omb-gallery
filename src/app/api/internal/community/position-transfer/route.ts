import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { communityErrorResponse, requireCommunityEnabled } from '@/lib/community-purchases/api';
import {
  confirmPositionTransfer,
  getReadyCommunityPositionTransfer,
  recordPositionTransferBroadcast,
} from '@/lib/community-purchases/positionTransferStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const disabled = requireCommunityEnabled();
  if (disabled) return disabled;
  if (!authorized(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const transferId = request.nextUrl.searchParams.get('transfer_id');
    if (!transferId) return NextResponse.json({ error: 'transfer_id required' }, { status: 400 });
    return NextResponse.json(
      { transfer: getReadyCommunityPositionTransfer(transferId) },
      { headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (error) {
    return communityErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const disabled = requireCommunityEnabled();
  if (disabled) return disabled;
  if (!authorized(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const body = (await request.json().catch(() => null)) as {
      action?: unknown;
      transfer_id?: unknown;
      txid?: unknown;
    } | null;
    if (!body || typeof body.transfer_id !== 'string') {
      return NextResponse.json({ error: 'transfer_id required' }, { status: 400 });
    }
    if (body.action === 'record-broadcast' && typeof body.txid === 'string') {
      return NextResponse.json({
        campaign: recordPositionTransferBroadcast({
          transferId: body.transfer_id,
          txid: body.txid,
        }),
      });
    }
    if (body.action === 'confirm-transfer') {
      return NextResponse.json({
        campaign: await confirmPositionTransfer({ transferId: body.transfer_id }),
      });
    }
    return NextResponse.json({ error: 'invalid action' }, { status: 400 });
  } catch (error) {
    return communityErrorResponse(error);
  }
}

function authorized(request: NextRequest): boolean {
  const expected = process.env.INTERNAL_POLL_SECRET;
  const actual = request.headers.get('authorization');
  if (!expected || !actual?.startsWith('Bearer ')) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual.slice('Bearer '.length));
  return left.length === right.length && timingSafeEqual(left, right);
}
