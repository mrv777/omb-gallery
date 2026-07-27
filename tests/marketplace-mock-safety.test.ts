import { afterEach, describe, expect, it, vi } from 'vitest';
import { marketplaceMockWalletEnabled } from '../src/lib/marketplace/listings';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('marketplaceMockWalletEnabled', () => {
  it('allows the signature-free mock wallet only outside production', () => {
    vi.stubEnv('MARKETPLACE_MOCK_WALLET', 'true');
    vi.stubEnv('NODE_ENV', 'development');
    expect(marketplaceMockWalletEnabled()).toBe(true);

    vi.stubEnv('NODE_ENV', 'production');
    expect(marketplaceMockWalletEnabled()).toBe(false);
  });
});
