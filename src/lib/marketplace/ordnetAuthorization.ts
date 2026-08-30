import { bip322SignatureToHex } from '@/lib/wallet/bip322Signature';

type OrdnetChallenge = {
  auth_request_id?: string;
  challenges?: Array<{
    challenge_id: string;
    message: string;
    address: string;
    role: 'ordinals' | 'payment';
  }>;
  error?: string;
};

export async function authorizeOrdnet(
  signMessage: (address: string, message: string) => Promise<string>,
  fetcher: typeof fetch = fetch
): Promise<void> {
  const challengeRes = await fetcher('/api/marketplace/ordnet/session');
  const challengeJson = (await challengeRes.json().catch(() => null)) as OrdnetChallenge | null;
  if (!challengeRes.ok || !challengeJson?.auth_request_id || !challengeJson.challenges?.length) {
    throw new Error(challengeJson?.error ?? 'ORD.NET wallet authorization failed');
  }

  const verifications = [];
  for (const challenge of challengeJson.challenges) {
    const signature = await signMessage(challenge.address, challenge.message);
    verifications.push({
      challenge_id: challenge.challenge_id,
      address: challenge.address,
      signature: bip322SignatureToHex(signature),
    });
  }

  const verifyRes = await fetcher('/api/marketplace/ordnet/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_request_id: challengeJson.auth_request_id,
      verifications,
    }),
  });
  const verifyJson = (await verifyRes.json().catch(() => null)) as { error?: string } | null;
  if (!verifyRes.ok) {
    throw new Error(verifyJson?.error ?? 'ORD.NET wallet authorization failed');
  }
}

export async function retryAfterOrdnetAuthorization<T>(
  request: () => Promise<T>,
  needsAuthorization: (result: T) => boolean,
  signMessage: (address: string, message: string) => Promise<string>,
  fetcher: typeof fetch = fetch
): Promise<T> {
  let result = await request();
  if (!needsAuthorization(result)) return result;
  await authorizeOrdnet(signMessage, fetcher);
  result = await request();
  return result;
}
