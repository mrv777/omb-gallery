import 'server-only';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export type VerifyResult = { ok: boolean; errors?: string[] };

// Verifies a Turnstile response token with Cloudflare. Fail-closed: any
// network error / missing secret / non-success response rejects the request.
export async function verifyTurnstileToken(
  token: string,
  remoteIp?: string,
): Promise<VerifyResult> {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) {
    console.error('[turnstile] TURNSTILE_SECRET missing — rejecting');
    return { ok: false, errors: ['missing-secret'] };
  }
  if (!token) return { ok: false, errors: ['missing-token'] };

  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp && remoteIp !== 'unknown') body.set('remoteip', remoteIp);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(SITEVERIFY, {
      method: 'POST',
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, errors: [`http-${res.status}`] };
    const json = (await res.json()) as {
      success?: boolean;
      'error-codes'?: string[];
    };
    return { ok: !!json.success, errors: json['error-codes'] };
  } catch (e) {
    console.error('[turnstile] verify failed:', e);
    return { ok: false, errors: ['fetch-error'] };
  } finally {
    clearTimeout(timer);
  }
}
