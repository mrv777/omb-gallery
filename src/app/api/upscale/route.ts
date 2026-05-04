import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
import path from 'node:path';
import fs from 'node:fs/promises';
import { lookupInscription } from '@/lib/inscriptionLookup';
import { log } from '@/lib/log';
import { clientIpKey } from '@/lib/clientIp';
import { checkAndConsumeGlobal, checkAndConsumePerIp } from '@/lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Single output size — 4x of the 336px source. Both methods produce
// 1344px PNGs.
const TARGET_W = 1344;

const METHODS = ['mitchell', 'waifu2x'] as const;
type Method = (typeof METHODS)[number];

class UpscalerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: string | null,
    message: string
  ) {
    super(message);
  }
}

const CACHE_DIR = process.env.UPSCALE_CACHE_DIR ?? '/data/upscaled';
const CACHE_VERSION = sanitizeCachePart(process.env.UPSCALE_CACHE_VERSION ?? 'v2');
const UPSCALER_URL = process.env.UPSCALER_URL ?? 'http://localhost:8001/upscale';
const UPSCALER_TIMEOUT_MS = 30_000;

// Rate limits — applied only on cache miss. Cache hits are basically free
// (single fs.readFile), so re-downloading the same image is unthrottled;
// only generation of new (id, method) pairs counts.
//
// Per-IP: 10/min. Generous for a human clicking around the gallery.
// Global: 20 / 10min backstop so concurrent abuse from many IPs can't
// queue more work than the CPU sidecar can clear. The sidecar serializes
// internally too, so the global cap mostly bounds queue depth.
const PER_IP_PER_MIN = 10;
const GLOBAL_LIMIT = 20;
const GLOBAL_WINDOW_MS = 10 * 60 * 1000;
// Effectively unbounded — the per-IP helper requires a daily figure but
// we don't want a daily ceiling here.
const PER_IP_PER_DAY_UNBOUNDED = 100_000;

function isMethod(m: string | null): m is Method {
  return !!m && (METHODS as readonly string[]).includes(m);
}

function sanitizeCachePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64) || 'v';
}

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const id = parseInt(sp.get('id') ?? '', 10);
  const methodRaw = sp.get('method');

  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  if (!isMethod(methodRaw)) {
    return NextResponse.json({ error: 'invalid method', allowed: METHODS }, { status: 400 });
  }
  const method: Method = methodRaw;

  const hit = lookupInscription(id);
  if (!hit || hit.kind !== 'omb' || hit.external) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const srcPath = path.join(process.cwd(), 'public', hit.full.replace(/^\//, ''));
  const cachePath = path.join(CACHE_DIR, `${id}-${method}-${CACHE_VERSION}.png`);
  const filename = `omb-${id}-${method}-${TARGET_W}.png`;

  try {
    const cached = await fs.readFile(cachePath);
    return pngResponse(cached, filename);
  } catch {
    // miss — rate-limit then generate
  }

  const ipKey = clientIpKey(req.headers);
  const ipCheck = checkAndConsumePerIp(ipKey, PER_IP_PER_MIN, PER_IP_PER_DAY_UNBOUNDED);
  if (!ipCheck.ok) {
    return rateLimitResponse(ipCheck.retryAfterSec, 'per-ip');
  }
  const globalCheck = checkAndConsumeGlobal(GLOBAL_WINDOW_MS, GLOBAL_LIMIT);
  if (!globalCheck.ok) {
    return rateLimitResponse(globalCheck.retryAfterSec, 'global');
  }

  const start = Date.now();
  let buf: Buffer;
  try {
    buf = method === 'mitchell' ? await runMitchell(srcPath) : await runWaifu2x(srcPath);
  } catch (e) {
    log.error('upscale', 'generate failed', { id, method, err: String(e) });
    const status = e instanceof UpscalerHttpError ? e.status : method === 'waifu2x' ? 502 : 500;
    const headers =
      e instanceof UpscalerHttpError && e.retryAfter ? { 'retry-after': e.retryAfter } : undefined;
    return NextResponse.json({ error: 'upscale failed', detail: String(e) }, { status, headers });
  }
  log.info('upscale', 'generated', {
    id,
    method,
    bytes: buf.length,
    ms: Date.now() - start,
  });

  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(cachePath, buf);
  } catch (e) {
    log.warn('upscale', 'cache write failed', { cachePath, err: String(e) });
  }

  return pngResponse(buf, filename);
}

async function runMitchell(srcPath: string): Promise<Buffer> {
  return sharp(srcPath)
    .resize(TARGET_W, TARGET_W, { kernel: 'mitchell', fit: 'inside' })
    .png()
    .toBuffer();
}

async function runWaifu2x(srcPath: string): Promise<Buffer> {
  const srcBytes = await fs.readFile(srcPath);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSCALER_TIMEOUT_MS);
  try {
    const r = await fetch(UPSCALER_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(srcBytes),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const text = await r.text();
      throw new UpscalerHttpError(
        r.status,
        r.headers.get('retry-after'),
        `upscaler HTTP ${r.status}: ${text.slice(0, 200)}`
      );
    }
    return Buffer.from(await r.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function rateLimitResponse(retryAfterSec: number, scope: 'per-ip' | 'global'): NextResponse {
  return NextResponse.json(
    { error: 'rate limited', scope, retry_after_sec: retryAfterSec },
    { status: 429, headers: { 'retry-after': String(retryAfterSec) } }
  );
}

function pngResponse(buf: Buffer, filename: string): NextResponse {
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=31536000, immutable',
      'content-disposition': `attachment; filename="${filename}"`,
    },
  });
}
