import { describe, expect, it } from 'vitest';
import { describeOrdPollStatus } from '../src/lib/pollStatus';

describe('describeOrdPollStatus', () => {
  it('omits healthy statuses', () => {
    expect(describeOrdPollStatus(null)).toBeNull();
    expect(describeOrdPollStatus('ok')).toBeNull();
    expect(describeOrdPollStatus('ok: 3 changes')).toBeNull();
  });

  it('presents maintenance connectivity failures as a delayed warning', () => {
    expect(describeOrdPollStatus('Network error: fetch failed')).toEqual({
      message: 'indexer reconnecting — recent activity may be delayed',
      tone: 'warning',
    });
    expect(describeOrdPollStatus('connect ECONNREFUSED 10.0.1.1:4000')).toEqual({
      message: 'indexer reconnecting — recent activity may be delayed',
      tone: 'warning',
    });
  });

  it('keeps IBD delays distinct and preserves unexpected poll failures', () => {
    expect(describeOrdPollStatus('404 from ord :: inscription 123')).toEqual({
      message: 'ord catching up — recent events may be delayed',
      tone: 'warning',
    });
    expect(describeOrdPollStatus('unexpected response shape')).toEqual({
      message: 'poll error: unexpected response shape',
      tone: 'error',
    });
  });
});
