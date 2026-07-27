import { describe, expect, it } from 'vitest';
import { clientIpKey } from '../src/lib/clientIp';

describe('clientIpKey', () => {
  it('normalizes valid IPv4 and collapses IPv6 to /64', () => {
    expect(clientIpKey(new Headers({ 'cf-connecting-ip': '192.168.001.010' }))).toBe(
      '192.168.1.10'
    );
    expect(clientIpKey(new Headers({ 'cf-connecting-ip': '2001:db8:abcd:12::99' }))).toBe(
      '2001:0db8:abcd:0012::/64'
    );
    expect(clientIpKey(new Headers({ 'cf-connecting-ip': '::ffff:192.0.2.4' }))).toBe('192.0.2.4');
  });

  it('uses only the first forwarded address when Cloudflare did not supply one', () => {
    expect(clientIpKey(new Headers({ 'x-forwarded-for': '198.51.100.7, 203.0.113.9' }))).toBe(
      '198.51.100.7'
    );
  });

  it('collapses missing and malformed values into the unknown bucket', () => {
    expect(clientIpKey(new Headers())).toBe('unknown');
    expect(clientIpKey(new Headers({ 'cf-connecting-ip': '999.2.3.4' }))).toBe('unknown');
    expect(clientIpKey(new Headers({ 'cf-connecting-ip': 'attacker-bucket-123' }))).toBe('unknown');
  });
});
