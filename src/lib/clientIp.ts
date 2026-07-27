import 'server-only';

const V4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function normalizeIpv4(raw: string): string | null {
  if (!V4.test(raw)) return null;
  const octets = raw.split('.').map(Number);
  if (octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return octets.join('.');
}

function normalizeIpv6To64(raw: string): string | null {
  // IPv4-mapped (::ffff:1.2.3.4) → treat as v4
  if (/^::ffff:/i.test(raw)) {
    const mapped = normalizeIpv4(raw.slice(7));
    if (mapped) return mapped;
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
  return (
    parts
      .slice(0, 4)
      .map(p => p.toLowerCase().padStart(4, '0'))
      .join(':') + '::/64'
  );
}

// Build the rate-limit key for this request's client IP.
// IMPORTANT: forwarded headers are trustworthy only while the origin rejects
// direct public traffic and accepts requests solely from the configured proxy.
// DEPLOYMENT.md records that infrastructure requirement; parsing here cannot
// authenticate who supplied a syntactically valid header.
// v4 → full address. v6 → collapse to /64 prefix so an attacker can't cycle
// addresses within one residential v6 block to bypass the per-IP bucket.
export function clientIpKey(headers: Headers): string {
  const cf = headers.get('cf-connecting-ip')?.trim();
  const xff = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const raw = cf || xff || '';
  if (!raw) return 'unknown';
  const v4 = normalizeIpv4(raw);
  if (v4) return v4;
  if (raw.includes(':')) {
    const key = normalizeIpv6To64(raw);
    if (key) return key;
  }
  // Never let malformed attacker-controlled strings create unlimited distinct
  // in-memory buckets. Invalid inputs share the fail-closed unknown bucket.
  return 'unknown';
}
