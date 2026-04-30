import { NextRequest, NextResponse } from 'next/server';
import {
  findBinding,
  parseSessionV2,
  readCookieRaw,
} from '@/lib/subscriberSession';
import {
  deleteSubscriptionById,
  MASK_LISTED,
  MASK_SOLD,
  MASK_TRANSFERRED,
  resetTargetFailCount,
  setEventMask,
  setStatus,
  type SubStatus,
} from '@/lib/subscriptionStore';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ALL_MASK_BITS = MASK_TRANSFERRED | MASK_SOLD | MASK_LISTED;

type SubRow = {
  id: number;
  channel: 'telegram' | 'discord';
  channel_target: string;
  status: SubStatus;
  kind: 'inscription' | 'color' | 'collection';
};

function loadAndAuthorize(req: NextRequest, idParam: string): {
  ok: true;
  row: SubRow;
} | {
  ok: false;
  res: NextResponse;
} {
  const id = parseInt(idParam, 10);
  if (!Number.isFinite(id)) {
    return { ok: false, res: NextResponse.json({ error: 'invalid-id' }, { status: 400 }) };
  }
  const cookieRaw = readCookieRaw(req.headers.get('cookie'));
  const sessionV2 = parseSessionV2(cookieRaw);
  if (!sessionV2) {
    return { ok: false, res: NextResponse.json({ error: 'no-session' }, { status: 401 }) };
  }
  const row = getDb()
    .prepare(`SELECT id, channel, channel_target, status, kind FROM subscriptions WHERE id = ?`)
    .get(id) as SubRow | undefined;
  if (!row) {
    return { ok: false, res: NextResponse.json({ error: 'not-found' }, { status: 404 }) };
  }
  // Auth: cookie must contain a binding matching the row's exact (channel,
  // channel_target). Owning EITHER binding alone isn't enough — a user with
  // only Telegram in their cookie can't flip a Discord row.
  const binding = findBinding(sessionV2, row.channel, row.channel_target);
  if (!binding) {
    return { ok: false, res: NextResponse.json({ error: 'forbidden' }, { status: 403 }) };
  }
  return { ok: true, row };
}

// PATCH-style endpoint for /notifications. Accepts:
//   { status: 'active'|'muted'|'failed' }   → flip status
//   { eventMask: number }                    → update event_mask (bits 1|2|4)
// Either or both fields can be present in the same request.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: idParam } = await params;
  const auth = loadAndAuthorize(req, idParam);
  if (!auth.ok) return auth.res;
  const row = auth.row;

  const body = (await req.json().catch(() => ({}))) as {
    status?: unknown;
    eventMask?: unknown;
  };
  const newStatus = body.status;
  const newMask = body.eventMask;

  // Validate ALL fields before mutating ANY of them. With the previous
  // "validate-then-write per field" shape, a request carrying both a valid
  // status and an invalid mask would write the status, return 400, and
  // leave the row in a half-applied state.
  let validatedStatus: SubStatus | null = null;
  let validatedMask: number | null = null;

  if (newStatus !== undefined) {
    if (newStatus !== 'muted' && newStatus !== 'active' && newStatus !== 'failed') {
      return NextResponse.json({ error: 'invalid-status' }, { status: 400 });
    }
    validatedStatus = newStatus as SubStatus;
  }

  if (newMask !== undefined) {
    if (typeof newMask !== 'number' || !Number.isInteger(newMask)) {
      return NextResponse.json({ error: 'invalid-mask' }, { status: 400 });
    }
    const masked = newMask & ALL_MASK_BITS;
    if (masked === 0) {
      return NextResponse.json({ error: 'invalid-mask' }, { status: 400 });
    }
    validatedMask = masked;
  }

  if (validatedStatus === null && validatedMask === null) {
    return NextResponse.json({ error: 'no-fields' }, { status: 400 });
  }

  // All inputs valid; apply atomically. Both writers are simple UPDATEs by
  // PK (no triggers), so wrapping in a transaction is cheap insurance against
  // a future caller relying on observability (e.g., a webhook reading the
  // row mid-write).
  const db = getDb();
  db.transaction(() => {
    if (validatedStatus !== null) {
      setStatus(row.id, validatedStatus);
      if (validatedStatus === 'active' && row.status === 'failed') {
        // Reactivating from `failed`: reset per-target fail_count so a
        // single transient delivery hiccup doesn't immediately re-fail.
        resetTargetFailCount(row.channel, row.channel_target);
      }
    }
    if (validatedMask !== null) {
      setEventMask(row.id, validatedMask);
    }
  })();

  return NextResponse.json({ ok: true });
}

// Permanent removal. Reversible only by re-subscribing from scratch (which is
// fine — the unsub_token route already does the same destructive thing via
// ?burn=1; this is just a per-row peer for the manage UI).
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: idParam } = await params;
  const auth = loadAndAuthorize(req, idParam);
  if (!auth.ok) return auth.res;
  deleteSubscriptionById(auth.row.id);
  return NextResponse.json({ ok: true });
}
