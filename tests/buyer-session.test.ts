import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCipheriv, createHash, createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { Signer } from 'bip322-js';
import { NETWORK, WIF, p2wpkh } from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1';

import {
  BUYER_COOKIE_NAME,
  createBuyerNonce,
  mintBuyerSession,
  mintOrdnetBuyerSession,
  parseBuyerNonce,
  parseBuyerSession,
  parseOrdnetBuyerSession,
  verifyBuyerSignature,
} from '../src/lib/buyerSession';
import { mintSession, parseSession } from '../src/lib/subscriberSession';
import { GET, PATCH, POST } from '../src/app/api/marketplace/session/route';

const DREY_TAPROOT_VECTOR = {
  address: 'bc1pcquvhrqv0q68t4m0hfq6tpn006qrskyc7yrqnp2uyrf2emg3wynsdjyk38',
  message: 'PURVOQ544B6HUATVBJZN5EZJUU',
  signature:
    'smpAUB6B2Rbupzua8LTQIF06516wzl+cwKy1be8RgoiW0riyXdKwe6GTz/5Hnb37m67pJwIKCh+D5jDueG6KpvYpmu8',
};

describe('buyer signature verification', () => {
  it('accepts Drey simple BIP-322 signatures for Taproot addresses', () => {
    expect(verifyBuyerSignature(DREY_TAPROOT_VECTOR)).toBe(true);
  });

  it('rejects a Drey signature for a different message', () => {
    expect(
      verifyBuyerSignature({
        ...DREY_TAPROOT_VECTOR,
        message: `${DREY_TAPROOT_VECTOR.message}-tampered`,
      })
    ).toBe(false);
  });

  it('rejects a malformed Drey signature without throwing', () => {
    expect(
      verifyBuyerSignature({
        ...DREY_TAPROOT_VECTOR,
        signature: `${DREY_TAPROOT_VECTOR.signature.slice(0, -1)}A`,
      })
    ).toBe(false);
  });
});

const TEST_SECRET = 'wallet-session-test-secret-not-a-real-credential';
// Public, disposable test key; never fund this wallet.
const TEST_KEY = Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 1 : 0));
const TEST_PUBKEY = secp256k1.getPublicKey(TEST_KEY, true);
const TEST_ADDRESS = p2wpkh(TEST_PUBKEY, NETWORK).address!;
const sessionFields = {
  ord_addr: TEST_ADDRESS,
  pay_addr: TEST_ADDRESS,
  ord_pubkey: Buffer.from(TEST_PUBKEY).toString('hex'),
  pay_pubkey: Buffer.from(TEST_PUBKEY).toString('hex'),
  accepted_terms_at: null,
};

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('BUYER_SESSION_SECRET', TEST_SECRET);
  vi.stubEnv('SUBSCRIBER_SESSION_SECRET', TEST_SECRET);
  vi.stubEnv('NEXT_PUBLIC_MARKETPLACE_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function signJson(payload: object, key: string | Buffer = TEST_SECRET): string {
  const bytes = Buffer.from(JSON.stringify(payload));
  return `${bytes.toString('base64url')}.${createHmac('sha256', key).update(bytes).digest('base64url')}`;
}

function purposeKey(purpose: string): Buffer {
  return createHmac('sha256', TEST_SECRET).update(`omb-wallet-cookie:v2:${purpose}`).digest();
}

function encryptedJson(payload: object, key: Buffer): string {
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return [
    'enc',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    bytes.toString('base64url'),
  ].join('.');
}

function request(method: string, cookie?: string, body?: object): NextRequest {
  return new NextRequest('https://ordinalmaxibiz.wiki/api/marketplace/session', {
    method,
    headers: {
      ...(cookie ? { cookie: `${BUYER_COOKIE_NAME}=${cookie}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe('wallet cookie purpose separation', () => {
  it('accepts each signed cookie only for its own purpose, including alternate base64 encoding', () => {
    const nonce = createBuyerNonce(TEST_ADDRESS, TEST_ADDRESS);
    const session = mintBuyerSession(sessionFields)!;
    expect(parseBuyerNonce(nonce.cookieValue)).toEqual(nonce.nonce);
    expect(parseBuyerSession(session)).toMatchObject(sessionFields);
    expect(parseBuyerSession(nonce.cookieValue)).toBeNull();
    expect(parseBuyerNonce(session)).toBeNull();
    expect(parseOrdnetBuyerSession(nonce.cookieValue)).toBeNull();
    expect(parseOrdnetBuyerSession(session)).toBeNull();
    const alternate = nonce
      .cookieValue!.split('.')
      .map(part => Buffer.from(part, 'base64url').toString('base64'))
      .join('.');
    expect(parseBuyerSession(alternate)).toBeNull();
  });

  it('rejects valid legacy challenges and sessions, including previously laundered sessions', () => {
    const issued_at = Math.floor(Date.now() / 1000);
    const nonce = {
      v: 1,
      nonce: 'legacy-challenge',
      ord_addr: TEST_ADDRESS,
      pay_addr: TEST_ADDRESS,
      issued_at,
    };
    const session = { v: 1, ...sessionFields, issued_at };
    expect(parseBuyerNonce(signJson(nonce))).toBeNull();
    expect(parseBuyerSession(signJson(nonce))).toBeNull();
    expect(parseBuyerSession(signJson(session))).toBeNull();
    expect(parseBuyerSession(signJson({ ...session, accepted_terms_at: issued_at }))).toBeNull();
  });

  it('requires the authenticated purpose even when the MAC is otherwise valid', () => {
    const payload = { v: 1, ...sessionFields, issued_at: Math.floor(Date.now() / 1000) };
    expect(parseBuyerSession(signJson(payload, purposeKey('buyer-session')))).toBeNull();
    expect(
      parseBuyerSession(
        signJson({ ...payload, purpose: 'buyer-nonce' }, purposeKey('buyer-session'))
      )
    ).toBeNull();
    const token = mintBuyerSession(sessionFields)!;
    const [encoded, mac] = token.split('.');
    const changed = {
      ...JSON.parse(Buffer.from(encoded!, 'base64url').toString()),
      ord_addr: 'changed',
    };
    expect(
      parseBuyerSession(`${Buffer.from(JSON.stringify(changed)).toString('base64url')}.${mac}`)
    ).toBeNull();
  });

  it('keeps ORD.NET tokens encrypted, purpose-bound and separate from signed cookies', () => {
    const issued_at = Math.floor(Date.now() / 1000);
    const payload = {
      v: 1 as const,
      ord_addr: TEST_ADDRESS,
      pay_addr: TEST_ADDRESS,
      session_token: 'dummy-ordnet-bearer',
      expires_at: issued_at + 3600,
      wallet_binding_id: 'test-binding',
      provider: 'drey',
      issued_at,
    };
    const token = mintOrdnetBuyerSession(payload)!;
    expect(parseOrdnetBuyerSession(token)).toEqual(payload);
    expect(token).not.toContain(payload.session_token);
    expect(parseBuyerSession(token)).toBeNull();
    expect(parseBuyerNonce(token)).toBeNull();
    expect(
      parseOrdnetBuyerSession(
        encryptedJson(payload, createHash('sha256').update(TEST_SECRET).digest())
      )
    ).toBeNull();
    expect(
      parseOrdnetBuyerSession(encryptedJson(payload, purposeKey('ordnet-session')))
    ).toBeNull();
    expect(
      parseOrdnetBuyerSession(
        encryptedJson({ ...payload, purpose: 'buyer-session' }, purposeKey('ordnet-session'))
      )
    ).toBeNull();
    const parts = token.split('.');
    const bytes = Buffer.from(parts[3]!, 'base64url');
    bytes[0] ^= 1;
    parts[3] = bytes.toString('base64url');
    expect(parseOrdnetBuyerSession(parts.join('.'))).toBeNull();
  });

  it('preserves subscriber-secret fallback without sharing subscriber cookie authority', () => {
    vi.stubEnv('BUYER_SESSION_SECRET', '');
    const subscriber = mintSession('telegram', '123456789')!;
    const buyer = mintBuyerSession(sessionFields)!;
    expect(parseSession(subscriber)?.channelTarget).toBe('123456789');
    expect(parseBuyerSession(subscriber)).toBeNull();
    expect(parseBuyerNonce(subscriber)).toBeNull();
    expect(parseBuyerSession(buyer)).toMatchObject(sessionFields);
    expect(parseSession(buyer)).toBeNull();
  });

  it('fails closed without a production secret and still expires new challenges', () => {
    const nonce = createBuyerNonce(TEST_ADDRESS, TEST_ADDRESS);
    const expired = {
      ...nonce.nonce,
      issued_at: Math.floor(Date.now() / 1000) - 601,
      purpose: 'buyer-nonce',
    };
    expect(parseBuyerNonce(signJson(expired, purposeKey('buyer-nonce')))).toBeNull();
    vi.stubEnv('BUYER_SESSION_SECRET', '');
    vi.stubEnv('SUBSCRIBER_SESSION_SECRET', '');
    expect(createBuyerNonce(TEST_ADDRESS, null).cookieValue).toBeNull();
    expect(mintBuyerSession(sessionFields)).toBeNull();
    expect(parseBuyerSession(nonce.cookieValue)).toBeNull();
  });
});

describe('wallet session route regression', () => {
  it('rejects a public challenge renamed as a session on reads and terms acceptance', async () => {
    const challenge = await GET(
      new NextRequest(
        `https://ordinalmaxibiz.wiki/api/marketplace/session?ord_addr=${TEST_ADDRESS}`
      )
    );
    expect(challenge.status).toBe(200);
    const nonce = challenge.headers.get('set-cookie')!.match(/omb_buyer_nonce=([^;]+)/)![1]!;
    const read = await GET(request('GET', nonce));
    expect(await read.json()).toEqual({ session: null });
    const patch = await PATCH(request('PATCH', nonce, { accept_terms: true }));
    expect(patch.status).toBe(401);
    expect(patch.headers.get('set-cookie')).toBeNull();
  });

  it('preserves genuine signed login and terms acceptance with original issuance', async () => {
    const challenge = createBuyerNonce(TEST_ADDRESS, TEST_ADDRESS);
    const signature = Signer.sign(WIF(NETWORK).encode(TEST_KEY), TEST_ADDRESS, challenge.message);
    const login = new NextRequest('https://ordinalmaxibiz.wiki/api/marketplace/session', {
      method: 'POST',
      headers: {
        cookie: `omb_buyer_nonce=${challenge.cookieValue}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...sessionFields, message: challenge.message, signature }),
    });
    expect((await POST(login)).status).toBe(200);
    const issued_at = Math.floor(Date.now() / 1000) - 100;
    const session = mintBuyerSession({ ...sessionFields, issued_at })!;
    const patch = await PATCH(request('PATCH', session, { accept_terms: true }));
    expect(patch.status).toBe(200);
    const json = await patch.json();
    expect(json.session).toMatchObject({
      ...sessionFields,
      issued_at,
      accepted_terms_at: expect.any(Number),
    });
  });

  it('rejects forged legacy sessions and a production mock-wallet bypass', async () => {
    const legacy = signJson({ v: 1, ...sessionFields, issued_at: Math.floor(Date.now() / 1000) });
    expect((await PATCH(request('PATCH', legacy, { accept_terms: true }))).status).toBe(401);
    vi.stubEnv('MARKETPLACE_MOCK_WALLET', 'true');
    expect((await POST(request('POST', undefined, { ...sessionFields, mock: true }))).status).toBe(
      401
    );
    vi.stubEnv('NODE_ENV', 'development');
    expect((await POST(request('POST', undefined, { ...sessionFields, mock: true }))).status).toBe(
      200
    );
  });
});
