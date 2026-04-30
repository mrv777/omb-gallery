import { NextRequest, NextResponse } from 'next/server';
import {
  answerCallbackQuery,
  sendMessage,
  verifyWebhookSecret,
  escapeHtml,
} from '@/lib/telegram';
import {
  claimByToken,
  eventMaskLabel,
  listByTarget,
  setStatus,
  PER_TARGET_LIMIT,
  type SubscriptionRow,
} from '@/lib/subscriptionStore';
import { mintSession } from '@/lib/subscriberSession';
import { log } from '@/lib/log';

function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || 'https://ordinalmaxibiz.wiki').replace(/\/$/, '');
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type TelegramMessage = {
  message_id: number;
  from?: { id: number; username?: string };
  chat: { id: number; type: string };
  text?: string;
};

type TelegramCallbackQuery = {
  id: string;
  from: { id: number };
  message?: TelegramMessage;
  data?: string;
};

type Update = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

function targetLabel(sub: SubscriptionRow): string {
  if (sub.kind === 'inscription') return `OMB #${sub.target_key}`;
  if (sub.kind === 'color') return `${sub.target_key} OMBs`;
  return 'all OMB activity';
}

async function handleStart(chatId: number, payload: string): Promise<void> {
  const result = claimByToken(payload, String(chatId));
  if (!result.ok) {
    let body = '';
    if (result.reason === 'cap-exceeded') {
      body = `You've reached the maximum of ${PER_TARGET_LIMIT} watches. Use /list to see your subscriptions and /unwatch &lt;id&gt; to drop one before adding another.`;
    } else if (result.reason === 'expired') {
      body = `<b>Welcome to OMB Archive alerts.</b>\n\nThat link expired (claims must be used within an hour). Visit <a href="https://ordinalmaxibiz.wiki">the archive</a> to set up a fresh watch.`;
    } else {
      body = `<b>Welcome to OMB Archive alerts.</b>\n\nThat link is no longer valid. Visit <a href="https://ordinalmaxibiz.wiki">the archive</a> to set up a watch.`;
    }
    await sendMessage({ chatId, text: body });
    return;
  }
  const sub = result.row;
  await sendMessage({
    chatId,
    text:
      `🔔 <b>Subscribed</b> — you'll get alerts for ${escapeHtml(targetLabel(sub))} (${eventMaskLabel(sub.event_mask)}).\n\n` +
      `/list — show all watches · /unwatch &lt;id&gt; — mute one · /manage — manage on the web.`,
    replyMarkup: {
      inline_keyboard: [[{ text: 'Add another watch', url: 'https://ordinalmaxibiz.wiki' }]],
    },
  });
}

async function handleList(chatId: number): Promise<void> {
  const subs = listByTarget('telegram', String(chatId));
  if (subs.length === 0) {
    await sendMessage({
      chatId,
      text: 'You have no active watches. Visit <a href="https://ordinalmaxibiz.wiki">the archive</a> to set one up.',
    });
    return;
  }
  const lines = subs.map(s => {
    const status = s.status === 'active' ? '🔔' : s.status === 'muted' ? '🔕' : '⚠️';
    return `${status} <code>${s.id}</code> — ${escapeHtml(targetLabel(s))} <i>(${eventMaskLabel(s.event_mask)})</i>`;
  });
  await sendMessage({
    chatId,
    text: `<b>Your watches:</b>\n\n${lines.join('\n')}\n\nMute one with /unwatch &lt;id&gt;.`,
  });
}

// Per-chat anti-spam for /manage. Each fresh link is a long-lived bearer for
// managing this chat's subs — limit how often a flood of /manage commands
// can post links into a chat history.
const manageCooldown = new Map<number, number>();
const MANAGE_COOLDOWN_MS = 60 * 1000;

async function handleManage(chatId: number): Promise<void> {
  const now = Date.now();
  const last = manageCooldown.get(chatId);
  if (last != null && now - last < MANAGE_COOLDOWN_MS) {
    const wait = Math.ceil((MANAGE_COOLDOWN_MS - (now - last)) / 1000);
    await sendMessage({
      chatId,
      text: `Please wait ${wait}s before requesting another manage link.`,
    });
    return;
  }

  // Don't bother minting a session for users with no subs — a manage link to
  // an empty page is just confusing.
  const subs = listByTarget('telegram', String(chatId));
  if (subs.length === 0) {
    await sendMessage({
      chatId,
      text: 'You have no active watches yet. Visit <a href="https://ordinalmaxibiz.wiki">the archive</a> to set one up.',
    });
    return;
  }

  const sessionValue = mintSession('telegram', String(chatId));
  if (!sessionValue) {
    log.error('notify/telegram', '/manage failed: session secret missing', {});
    await sendMessage({
      chatId,
      text: 'Manage links are not available right now — try /list and /unwatch instead.',
    });
    return;
  }

  manageCooldown.set(chatId, now);
  const url = `${siteUrl()}/api/notifications/auth?s=${encodeURIComponent(sessionValue)}`;
  await sendMessage({
    chatId,
    text:
      `<b>Manage your watches on the web</b>\n\n` +
      `This link works on any device — bookmark it if you switch browsers often.\n\n` +
      `It grants visibility/mute access for this Telegram chat's subs only.`,
    replyMarkup: {
      inline_keyboard: [[{ text: 'Open notifications', url }]],
    },
  });
}

async function handleUnwatch(chatId: number, idStr: string): Promise<void> {
  const id = parseInt(idStr, 10);
  if (!Number.isFinite(id)) {
    await sendMessage({ chatId, text: 'Usage: /unwatch &lt;id&gt; — get ids from /list.' });
    return;
  }
  const subs = listByTarget('telegram', String(chatId));
  const target = subs.find(s => s.id === id);
  if (!target) {
    await sendMessage({ chatId, text: `No watch with id ${id} found.` });
    return;
  }
  setStatus(id, 'muted');
  await sendMessage({
    chatId,
    text: `🔕 Muted: ${escapeHtml(targetLabel(target))}.`,
  });
}

async function handleCallbackQuery(cq: TelegramCallbackQuery): Promise<void> {
  if (!cq.data || !cq.message) {
    await answerCallbackQuery(cq.id);
    return;
  }
  const [action, idStr] = cq.data.split(':');
  const id = parseInt(idStr, 10);
  if (action === 'mute' && Number.isFinite(id)) {
    const subs = listByTarget('telegram', String(cq.message.chat.id));
    const target = subs.find(s => s.id === id);
    if (target) {
      setStatus(id, 'muted');
      await answerCallbackQuery(cq.id, 'Muted');
      return;
    }
  }
  await answerCallbackQuery(cq.id);
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-telegram-bot-api-secret-token');
  if (!verifyWebhookSecret(secret)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let update: Update;
  try {
    update = (await req.json()) as Update;
  } catch {
    return NextResponse.json({ error: 'invalid-json' }, { status: 400 });
  }

  try {
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    } else if (update.message?.text) {
      const chatId = update.message.chat.id;
      const text = update.message.text.trim();
      if (text.startsWith('/start')) {
        const payload = text.slice('/start'.length).trim();
        if (payload) await handleStart(chatId, payload);
        else
          await sendMessage({
            chatId,
            text: 'Welcome to OMB Archive alerts. Visit <a href="https://ordinalmaxibiz.wiki">the archive</a> to set up a watch.',
          });
      } else if (text === '/list') {
        await handleList(chatId);
      } else if (text === '/manage') {
        await handleManage(chatId);
      } else if (text.startsWith('/unwatch')) {
        const arg = text.slice('/unwatch'.length).trim();
        await handleUnwatch(chatId, arg);
      } else if (text === '/help') {
        await sendMessage({
          chatId,
          text: `<b>OMB Archive alerts</b>\n\n/list — show your watches\n/unwatch &lt;id&gt; — mute a watch\n/manage — get a magic link to manage from the web (any device)\n\nSet up new watches at <a href="https://ordinalmaxibiz.wiki">the archive</a>.`,
        });
      }
    }
  } catch (e) {
    log.error('notify/telegram', 'webhook handler failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // Always 200 — Telegram retries 5xx with exponential backoff and we never want
  // bot logic errors to flood retries.
  return NextResponse.json({ ok: true });
}
