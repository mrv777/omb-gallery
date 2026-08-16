const HEX_SIGNATURE = /^(?:[0-9a-fA-F]{2})+$/;
const SIMPLE_SIGNATURE_PREFIX = 'smp';

export function bip322SignatureToHex(signature: string): string {
  if (HEX_SIGNATURE.test(signature)) return signature.toLowerCase();

  const encoded = signature.startsWith(SIMPLE_SIGNATURE_PREFIX)
    ? signature.slice(SIMPLE_SIGNATURE_PREFIX.length)
    : signature;
  if (!encoded) throw invalidSignatureEncoding();

  let raw: string;
  try {
    raw = atob(encoded);
  } catch {
    throw invalidSignatureEncoding();
  }
  if (!raw) throw invalidSignatureEncoding();

  let hex = '';
  for (let index = 0; index < raw.length; index++) {
    hex += raw.charCodeAt(index).toString(16).padStart(2, '0');
  }
  return hex;
}

function invalidSignatureEncoding(): Error {
  return new Error('Wallet returned an invalid BIP-322 signature encoding.');
}
