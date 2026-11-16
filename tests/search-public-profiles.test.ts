import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import SearchResults from '@/components/Search/SearchResults';
import SearchDropdown from '@/components/Search/SearchDropdown';
import type { SearchResults as Results } from '@/lib/searchTypes';

const results: Results = {
  q: 'collector',
  inscriptions: [],
  holders: [],
  events: [],
  users: [
    {
      user_id: 'ordnet:collector-profile',
      username: 'collector',
      avatar_url: null,
      wallet_count: 1,
      first_wallet: 'bc1ppublicwallet',
    },
  ],
};

describe('public profile search labels', () => {
  it('uses a provider-neutral heading on the full results page', () => {
    const html = renderToStaticMarkup(createElement(SearchResults, { q: results.q, results }));
    expect(html).toContain('>Profiles</h2>');
    expect(html).not.toContain('Matrica users');
    expect(html).toContain('href="/holder/bc1ppublicwallet"');
  });

  it('uses the same heading in keyboard-search suggestions', () => {
    const html = renderToStaticMarkup(
      createElement(SearchDropdown, {
        q: results.q,
        results,
        status: 'ready',
        rows: [
          {
            key: 'user:ordnet:collector-profile',
            href: '/holder/bc1ppublicwallet',
            render: () => null,
          },
        ],
        focusedIndex: 0,
        onHover: () => undefined,
        onClose: () => undefined,
      })
    );
    expect(html).toContain('Profiles');
    expect(html).not.toContain('Matrica users');
    expect(html).toContain('href="/holder/bc1ppublicwallet"');
  });

  it('explains that both Matrica and ORD.NET usernames are searchable', () => {
    const html = renderToStaticMarkup(
      createElement(SearchResults, {
        q: '',
        results: { ...results, q: '', users: [] },
      })
    );
    expect(html).toContain('a Matrica or ORD.NET username');
  });
});
