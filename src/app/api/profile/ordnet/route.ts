import { NextRequest, NextResponse } from 'next/server';
import {
  BUYER_COOKIE_NAME,
  ORDNET_SESSION_COOKIE_NAME,
  parseBuyerSession,
  parseOrdnetBuyerSession,
  type BuyerSession,
} from '@/lib/buyerSession';
import { getStmts } from '@/lib/db';
import { looksLikeAddress } from '@/lib/format';
import { fetchOrdnetProfile, OrdnetError } from '@/lib/ordnet';
import {
  getOrdnetIdentitySharing,
  removeOrdnetIdentity,
  shareOrdnetIdentity,
} from '@/lib/publicIdentityStore';
import {
  marketplaceRateLimit,
  requireExactOrigin,
  requireMarketplaceEnabled,
} from '@/lib/marketplace/apiGuards';
import { runRolesTick } from '@/lib/rolesStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

function buyerFor(req: NextRequest): BuyerSession | NextResponse {
  const disabled = requireMarketplaceEnabled();
  if (disabled) return disabled;
  const session = parseBuyerSession(req.cookies.get(BUYER_COOKIE_NAME)?.value);
  return session ?? json({ error: 'Connect your wallet first.' }, 401);
}

async function providerFor(req: NextRequest, buyer: BuyerSession) {
  const session = parseOrdnetBuyerSession(req.cookies.get(ORDNET_SESSION_COOKIE_NAME)?.value);
  if (!session || session.ord_addr !== buyer.ord_addr || session.pay_addr !== buyer.pay_addr) {
    return json(
      { code: 'ordnet-auth-required', error: 'Authorize your wallet with ORD.NET.' },
      428
    );
  }
  try {
    const current = await fetchOrdnetProfile(session.session_token);
    const binding = current.walletBindings.find(
      item =>
        item.walletBindingId === session.wallet_binding_id &&
        item.ordinalsAddress === buyer.ord_addr &&
        item.paymentAddress === buyer.pay_addr
    );
    if (!binding) {
      return json(
        {
          code: 'wallet-mismatch',
          error: 'ORD.NET no longer links this wallet to the session. Reconnect your wallet.',
        },
        409
      );
    }
    return { ...current, binding };
  } catch (err) {
    if (err instanceof OrdnetError && err.status === 401) {
      return json(
        { code: 'ordnet-auth-required', error: 'Authorize your wallet with ORD.NET again.' },
        428
      );
    }
    // Provider response bodies can contain account data; do not echo them to clients.
    return json({ error: 'Could not check ORD.NET right now. Try again shortly.' }, 502);
  }
}

export async function GET(req: NextRequest) {
  const buyer = buyerFor(req);
  if (buyer instanceof NextResponse) return buyer;
  const base = sharingState(buyer);
  if (req.nextUrl.searchParams.get('preview') !== 'true') return json(base);
  const limited = marketplaceRateLimit(req, 'profile-ordnet-preview', 10, 100);
  if (limited) return limited;
  const current = await providerFor(req, buyer);
  if (current instanceof NextResponse) return current;
  return json({
    ...base,
    preview: {
      profile_id: current.profile.id,
      username: current.profile.username,
      avatar_url: null,
      is_public: current.binding.isPublic === true,
    },
  });
}

function sharingState(buyer: BuyerSession) {
  const link = getStmts().getWalletLink.get({ wallet_addr: buyer.ord_addr }) as
    | { matrica_user_id: string | null; username: string | null }
    | undefined;
  return {
    wallet_address: buyer.ord_addr,
    sharing: getOrdnetIdentitySharing(buyer.ord_addr),
    matrica_linked: !!link?.matrica_user_id && !looksLikeAddress(link.username ?? ''),
  };
}

export async function POST(req: NextRequest) {
  const origin = requireExactOrigin(req);
  if (origin) return origin;
  const buyer = buyerFor(req);
  if (buyer instanceof NextResponse) return buyer;
  const limited = marketplaceRateLimit(req, 'profile-ordnet-publish', 6, 50);
  if (limited) return limited;
  const body = await req.json().catch(() => null);
  if (
    body?.publish !== true ||
    typeof body?.expected_profile_id !== 'string' ||
    typeof body?.expected_wallet_address !== 'string'
  ) {
    return json({ error: 'Preview your profile, then confirm publication.' }, 400);
  }
  if (body.expected_wallet_address !== buyer.ord_addr) {
    return json(
      {
        code: 'wallet-changed',
        error: 'Your connected wallet changed. Preview it again before publishing.',
      },
      409
    );
  }
  const current = await providerFor(req, buyer);
  if (current instanceof NextResponse) return current;
  if (current.profile.id !== body.expected_profile_id) {
    return json(
      { error: 'Your ORD.NET profile changed. Preview it again before publishing.' },
      409
    );
  }
  if (current.binding.isPublic !== true) {
    return json(
      {
        code: 'private-wallet',
        error: 'This wallet is private on ORD.NET. Make it public there before sharing it here.',
      },
      409
    );
  }
  shareOrdnetIdentity({
    walletAddress: buyer.ord_addr,
    profile: current.profile,
    walletBindings: [current.binding],
  });
  runRolesTick();
  return json(sharingState(buyer));
}

export async function DELETE(req: NextRequest) {
  const origin = requireExactOrigin(req);
  if (origin) return origin;
  const buyer = buyerFor(req);
  if (buyer instanceof NextResponse) return buyer;
  const limited = marketplaceRateLimit(req, 'profile-ordnet-remove', 10, 100);
  if (limited) return limited;
  const body = await req.json().catch(() => null);
  if (typeof body?.expected_wallet_address !== 'string') {
    return json({ error: 'Confirm the wallet whose sharing you want to remove.' }, 400);
  }
  if (body.expected_wallet_address !== buyer.ord_addr) {
    return json(
      { code: 'wallet-changed', error: 'Your connected wallet changed. Reconnect and try again.' },
      409
    );
  }
  // Withdrawal works even when ORD.NET is unavailable or its API token has expired.
  removeOrdnetIdentity(buyer.ord_addr);
  runRolesTick();
  return json(sharingState(buyer));
}
