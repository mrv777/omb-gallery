import 'server-only';
import { log } from './log';

const API_BASE = 'https://api.telegram.org';

export type TelegramSendError =
  | { kind: 'config' }
  | { kind: 'blocked'; status: number; description: string }
  | { kind: 'rate-limit'; retryAfterSec: number }
  | { kind: 'http'; status: number; description: string }
  | { kind: 'network'; message: string };

export type TelegramSendResult = { ok: true; messageId: number } | { ok: false; error: TelegramSendError };

type ApiResponse<T> = {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
};

function token(): string | null {
  return process.env.TELEGRAM_BOT_TOKEN ?? null;
}

export function isConfigured(): boolean {
  return !!token();
}

export function botUsername(): string {
  return process.env.TELEGRAM_BOT_USERNAME ?? 'OMBalertsBot';
}

export function deepLink(claimToken: string): string {
  return `https://t.me/${botUsername()}?start=${encodeURIComponent(claimToken)}`;
}

export type InlineButton = { text: string; url?: string; callback_data?: string };
export type InlineKeyboard = InlineButton[][];

export type SendArgs = {
  chatId: string | number;
  text: string;
  parseMode?: 'HTML' | 'MarkdownV2';
  disablePreview?: boolean;
  replyMarkup?: { inline_keyboard: InlineKeyboard };
};

async function callApi<T>(method: string, payload: Record<string, unknown>): Promise<TelegramSendResult & { raw?: T }> {
  const t = token();
  if (!t) return { ok: false, error: { kind: 'config' } };
  // 4s per call — fanout dispatches concurrently inside a 30s cron budget.
  // Telegram's bot API typically responds in <500ms; this only matters for
  // dead targets (which respond fast with 403) or pathologically slow links.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4_000);
  try {
    const res = await fetch(`${API_BASE}/bot${t}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const json = (await res.json().catch(() => ({}))) as ApiResponse<T & { message_id?: number }>;
    if (json.ok && json.result) {
      const msgId = (json.result as { message_id?: number }).message_id ?? 0;
      return { ok: true, messageId: msgId, raw: json.result };
    }
    const desc = json.description ?? `http-${res.status}`;
    if (res.status === 403 && /bot was blocked|user is deactivated/i.test(desc)) {
      return { ok: false, error: { kind: 'blocked', status: res.status, description: desc } };
    }
    if (res.status === 429) {
      return { ok: false, error: { kind: 'rate-limit', retryAfterSec: json.parameters?.retry_after ?? 1 } };
    }
    return { ok: false, error: { kind: 'http', status: res.status, description: desc } };
  } catch (e) {
    return { ok: false, error: { kind: 'network', message: e instanceof Error ? e.message : String(e) } };
  } finally {
    clearTimeout(timer);
  }
}

export async function sendMessage(args: SendArgs): Promise<TelegramSendResult> {
  const payload: Record<string, unknown> = {
    chat_id: args.chatId,
    text: args.text,
    parse_mode: args.parseMode ?? 'HTML',
    disable_web_page_preview: args.disablePreview ?? false,
  };
  if (args.replyMarkup) payload.reply_markup = args.replyMarkup;
  return callApi('sendMessage', payload);
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  const payload: Record<string, unknown> = { callback_query_id: callbackQueryId };
  if (text) payload.text = text;
  await callApi('answerCallbackQuery', payload);
}

// Set the bot's webhook URL with Telegram. Idempotent — safe to call from a
// boot script. The secret_token is sent back in the X-Telegram-Bot-Api-Secret-Token
// header on every incoming update; verifyWebhookSecret() checks it.
export async function setWebhook(url: string, secretToken: string): Promise<TelegramSendResult> {
  const payload = {
    url,
    secret_token: secretToken,
    allowed_updates: ['message', 'callback_query'],
  };
  const r = await callApi<{ url: string }>('setWebhook', payload);
  if (!r.ok) log.error('notify/telegram', 'setWebhook failed', { error: r.error });
  return r;
}

export function verifyWebhookSecret(headerValue: string | null): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return false;
  return headerValue === expected;
}

// HTML-escape a string for parse_mode=HTML.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
