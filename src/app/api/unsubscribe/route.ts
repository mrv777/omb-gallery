import { NextRequest, NextResponse } from 'next/server';
import { findByUnsubToken, muteAllForTarget, setStatus } from '@/lib/subscriptionStore';
import { log } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function htmlPage(title: string, body: string): NextResponse {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  body { font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; max-width: 480px; margin: 4rem auto; padding: 0 1.5rem; color: #1a1a1a; background: #f5f0e8; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  p { margin: 0 0 0.75rem; }
  a { color: #c33; }
  button { appearance: none; border: 1px solid #1a1a1a; background: #1a1a1a; color: #f5f0e8; padding: 0.65rem 0.9rem; font: inherit; cursor: pointer; }
  .ok { color: #2a7; }
  .err { color: #c33; }
</style>
</head>
<body>${body}</body>
</html>`;
  return new NextResponse(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => {
    const escaped: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return escaped[character]!;
  });
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  const burn = url.searchParams.get('burn') === '1';
  if (!token)
    return htmlPage(
      'Missing token',
      '<h1 class="err">Missing token</h1><p>This link is malformed.</p>'
    );

  const row = findByUnsubToken(token);
  if (!row) {
    return htmlPage(
      'Not found',
      '<h1 class="err">Not found</h1><p>This subscription token is no longer valid.</p>'
    );
  }

  const scope = burn
    ? `all notifications for this ${row.channel === 'telegram' ? 'Telegram chat' : 'Discord channel'}`
    : 'this watch';
  return htmlPage(
    'Confirm unsubscribe',
    `<h1>Stop ${escapeHtml(scope)}?</h1>
     <p>This link has not changed anything yet.</p>
     <form method="post" action="/api/unsubscribe">
       <input type="hidden" name="token" value="${escapeHtml(token)}">
       <input type="hidden" name="burn" value="${burn ? '1' : '0'}">
       <button type="submit">Confirm unsubscribe</button>
     </form>
     <p style="margin-top:1rem"><a href="/notifications">Keep notifications</a></p>`
  );
}

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const token = form?.get('token');
  const burn = form?.get('burn') === '1';
  if (typeof token !== 'string' || !token) {
    return htmlPage(
      'Missing token',
      '<h1 class="err">Missing token</h1><p>Try the link again.</p>'
    );
  }
  const row = findByUnsubToken(token);
  if (!row) {
    return htmlPage(
      'Not found',
      '<h1 class="err">Not found</h1><p>This subscription token is no longer valid.</p>'
    );
  }

  if (burn) {
    const n = muteAllForTarget(row.channel, row.channel_target);
    log.info('subscribe', 'burned target', { channel: row.channel, count: n });
    return htmlPage(
      'All subscriptions removed',
      `<h1 class="ok">Removed ${n} subscription${n === 1 ? '' : 's'}</h1>
       <p>This ${row.channel === 'telegram' ? 'Telegram chat' : 'Discord channel'} will no longer receive OMB notifications.</p>
       <p><a href="/">Back to the wiki</a></p>`
    );
  }

  setStatus(row.id, 'muted');
  log.info('subscribe', 'muted', { id: row.id });
  return htmlPage(
    'Unsubscribed',
    `<h1 class="ok">Unsubscribed</h1>
     <p>You'll no longer get alerts for this watch.</p>
     <p><a href="/notifications">Manage all subscriptions</a> · <a href="/">Back to the wiki</a></p>`
  );
}
