import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const harness = vi.hoisted(() => ({ loading: false }));
vi.mock('../src/components/Activity/useActivityFeed', () => ({
  useActivityFeed: () => ({
    events: [],
    totals: null,
    poll: null,
    matrica: {},
    loading: harness.loading,
    refreshing: false,
    error: 'HTTP 503',
    reachedEnd: false,
    loadMore: vi.fn(),
  }),
}));
vi.mock('../src/lib/useColorFilter', () => ({ useColorFilter: () => ({ color: 'all' }) }));
vi.mock('../src/components/Activity/ActivityRow', () => ({ default: () => null }));
vi.mock('../src/components/Charts/TransferActivitySparkline', () => ({ default: () => null }));
import ActivityFeed from '../src/components/Activity/ActivityFeed';

describe('activity first-page recovery', () => {
  it('offers an immediate retry when the first page fails', () => {
    harness.loading = false;
    const html = renderToStaticMarkup(createElement(ActivityFeed));
    expect(html).toContain('failed to load: HTTP 503');
    expect(html).toMatch(/<button[^>]*>Retry<\/button>/);
  });
  it('disables the retry while a recovery request is pending', () => {
    harness.loading = true;
    const html = renderToStaticMarkup(createElement(ActivityFeed));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Retrying…<\/button>/);
  });
});
