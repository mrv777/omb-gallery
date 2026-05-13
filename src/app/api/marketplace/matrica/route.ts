import { NextRequest, NextResponse } from 'next/server';
import { fetchWalletProfile, MatricaError } from '@/lib/matrica';
import { looksLikeAddress } from '@/lib/format';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const addr = new URL(req.url).searchParams.get('addr');
  if (!addr) return NextResponse.json({ error: 'addr required' }, { status: 400 });

  const apiKey = process.env.MATRICA_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ status: 'unknown', reason: 'matrica api not configured' });
  }

  try {
    const profile = await fetchWalletProfile(addr, apiKey);
    if (!profile) return NextResponse.json({ status: 'none' });
    return NextResponse.json({
      status: 'linked',
      profile: {
        username: profile.username,
        avatar_url: profile.avatar_url,
        placeholder: looksLikeAddress(profile.username),
      },
    });
  } catch (err) {
    const message = err instanceof MatricaError ? err.message : 'matrica lookup failed';
    return NextResponse.json({ status: 'unknown', reason: message }, { status: 200 });
  }
}
