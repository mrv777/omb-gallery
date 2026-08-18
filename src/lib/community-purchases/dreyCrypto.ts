import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { setCryptoProvider, type CryptoProvider } from '@drey/core/domain/vault/crypto-provider';

const unsupported = (): never => {
  throw new Error('The gallery Community policy adapter does not perform secret-key cryptography.');
};

/**
 * Community policy construction needs only SHA-256. Supplying explicit
 * throwing implementations for secret-key operations makes the gallery's
 * keyless boundary executable: an accidental future call cannot silently
 * turn this adapter into a wallet.
 */
const PUBLIC_POLICY_CRYPTO: CryptoProvider = {
  async argon2id() {
    return unsupported();
  },
  xchaEncrypt: unsupported,
  xchaDecrypt: unsupported,
  sha256(data) {
    return new Uint8Array(createHash('sha256').update(data).digest());
  },
  ed25519Verify: unsupported,
  randomBytes(byteLength) {
    return new Uint8Array(randomBytes(byteLength));
  },
};

export function installPublicPolicyCrypto(): void {
  setCryptoProvider(PUBLIC_POLICY_CRYPTO);
}
