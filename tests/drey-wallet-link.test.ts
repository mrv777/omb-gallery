import { describe, expect, it } from 'vitest';
import { dreyMobileBrowserUrl } from '@/lib/wallet/satsConnect';

describe('Drey mobile browser link', () => {
  it('encodes only the current marketplace URL', () => {
    const current = 'https://ordinalmaxibiz.wiki/marketplace?color=blue&sort=price-asc';
    const link = new URL(dreyMobileBrowserUrl(current));
    expect(link.origin).toBe('https://squirrelsystems.net');
    expect(link.pathname).toBe('/browser');
    expect(link.searchParams.get('url')).toBe(current);
    expect(Array.from(link.searchParams.keys())).toEqual(['url']);
  });
});
