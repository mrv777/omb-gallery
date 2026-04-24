// Compact URL encoding for a list of inscription numbers.
// Sort-then-delta-then-varint-then-base64url. Keeps 500 ids well under 2KB.

function toBytes(nums: number[]): Uint8Array {
  const sorted = [...nums].sort((a, b) => a - b);
  const deduped: number[] = [];
  for (const n of sorted) {
    if (deduped.length === 0 || deduped[deduped.length - 1] !== n) deduped.push(n);
  }
  const out: number[] = [];
  let prev = 0;
  for (const n of deduped) {
    let v = n - prev;
    prev = n;
    while (v >= 128) {
      out.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    out.push(v & 0x7f);
  }
  return new Uint8Array(out);
}

function fromBytes(bytes: Uint8Array): number[] {
  const nums: number[] = [];
  let i = 0;
  let prev = 0;
  while (i < bytes.length) {
    let v = 0;
    let shift = 0;
    for (;;) {
      if (i >= bytes.length) throw new Error('truncated varint');
      const b = bytes[i++];
      v |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 28) throw new Error('varint too large');
    }
    prev += v;
    nums.push(prev);
  }
  return nums;
}

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str: string): Uint8Array {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

export function encodeIds(ids: string[]): string {
  const nums: number[] = [];
  for (const s of ids) {
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0 || n > 9_999_999) {
      throw new Error(`invalid id: ${s}`);
    }
    nums.push(n);
  }
  return b64urlEncode(toBytes(nums));
}

export function decodeIds(encoded: string): string[] {
  if (!encoded) return [];
  const bytes = b64urlDecode(encoded);
  return fromBytes(bytes).map(String);
}
