import { NextRequest, NextResponse } from 'next/server';
import { clientIpKey } from '@/lib/clientIp';
import { checkAndConsumePerIp, checkAndConsumeGlobal } from '@/lib/rateLimit';
import { verifyTurnstileToken } from '@/lib/turnstile';
import { createSlideshow } from '@/lib/slideshowStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_IDS = 1500;
const MAX_TITLE = 60;
const PER_MIN = 5;
const PER_DAY = 50;
const GLOBAL_WINDOW_MS = 3_600_000;
const GLOBAL_LIMIT = 1000;
const ID_RE = /^\d{1,7}$/;

type Body = { ids?: unknown; title?: unknown; turnstileToken?: unknown };

function bad(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return bad(400, 'invalid-json');
  }

  // 1. Payload validation (cheapest first; does not consume rate budget).
  if (!Array.isArray(body.ids)) return bad(400, 'ids-required');
  if (body.ids.length === 0) return bad(400, 'ids-empty');
  if (body.ids.length > MAX_IDS) return bad(413, 'ids-too-many');
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of body.ids) {
    if (typeof raw !== 'string' || !ID_RE.test(raw)) return bad(400, 'ids-invalid');
    if (seen.has(raw)) continue;
    seen.add(raw);
    ids.push(raw);
  }

  let title: string | null = null;
  if (body.title !== undefined && body.title !== null && body.title !== '') {
    if (typeof body.title !== 'string') return bad(400, 'title-invalid');
    const trimmed = body.title.normalize('NFC').trim().replace(/\s+/g, ' ');
    if (trimmed.length > MAX_TITLE) return bad(400, 'title-too-long');
    if (trimmed) title = trimmed;
  }

  const token = typeof body.turnstileToken === 'string' ? body.turnstileToken : '';
  if (!token) return bad(403, 'turnstile-missing');

  // 2 & 3. Rate limits (reject before spending a Turnstile verify call).
  const ip = clientIpKey(req.headers);
  const perIp = checkAndConsumePerIp(ip, PER_MIN, PER_DAY);
  if (!perIp.ok) {
    return new NextResponse(JSON.stringify({ error: 'rate-limited' }), {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': String(perIp.retryAfterSec),
      },
    });
  }
  const global = checkAndConsumeGlobal(GLOBAL_WINDOW_MS, GLOBAL_LIMIT);
  if (!global.ok) {
    return new NextResponse(JSON.stringify({ error: 'busy' }), {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': String(global.retryAfterSec),
      },
    });
  }

  // 4. Turnstile verification.
  const verify = await verifyTurnstileToken(token, ip !== 'unknown' ? ip : undefined);
  if (!verify.ok) {
    return NextResponse.json(
      { error: 'turnstile-failed', codes: verify.errors },
      { status: 403 },
    );
  }

  // 5. DB write.
  try {
    const slug = createSlideshow({ ids, title, creatorIp: ip });
    return NextResponse.json({ slug });
  } catch (e) {
    console.error('[slideshow] create failed:', e);
    return bad(500, 'create-failed');
  }
}
