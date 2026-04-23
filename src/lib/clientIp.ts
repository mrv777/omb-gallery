import 'server-only';

const V4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function normalizeIpv6To64(raw: string): string | null {
  // IPv4-mapped (::ffff:1.2.3.4) → treat as v4
  if (/^::ffff:/i.test(raw)) {
    const tail = raw.slice(7);
    if (V4.test(tail)) return tail;
  }
  const zone = raw.indexOf('%');
  const v6 = zone === -1 ? raw : raw.slice(0, zone);
  const halves = v6.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (halves.length === 1 && head.length !== 8) return null;
  if (missing < 0) return null;
  const parts = [...head, ...Array(missing).fill('0'), ...tail];
  if (parts.length !== 8) return null;
  for (const p of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
  }
  return parts.slice(0, 4).map((p) => p.toLowerCase().padStart(4, '0')).join(':') + '::/64';
}

// Build the rate-limit key for this request's client IP.
// Hetzner origin sits behind Cloudflare; CF-Connecting-IP is trustworthy there.
// v4 → full address. v6 → collapse to /64 prefix so an attacker can't cycle
// addresses within one residential v6 block to bypass the per-IP bucket.
export function clientIpKey(headers: Headers): string {
  const cf = headers.get('cf-connecting-ip')?.trim();
  const xff = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const raw = cf || xff || '';
  if (!raw) return 'unknown';
  if (V4.test(raw)) return raw;
  if (raw.includes(':')) {
    const key = normalizeIpv6To64(raw);
    if (key) return key;
  }
  return raw;
}
