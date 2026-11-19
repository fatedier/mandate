import type { NotificationChannelConfig } from "../../../config.js";
import type { ChannelContext, ChannelKind, OutgoingNotification, SendOutcome } from "../channel-kind.js";

/** The Bot API's limit on a message's text. */
export const TELEGRAM_TEXT_MAX = 4096;
export const TELEGRAM_TIMEOUT_MS = 15_000;
const UNREACHABLE = "Telegram could not be reached";
const CONNECT_FIRST = "Send any message to your bot, then press Connect.";

type Answer = { ok: true; result: unknown } | { ok: false; error: string };

/** One Bot API call. The token is in the URL, so neither the URL nor a
 *  network error's text is ever passed on: Telegram's own description, or
 *  that it could not be reached. */
async function call(ctx: ChannelContext, token: string, method: string, body: Record<string, unknown>): Promise<Answer> {
  const signal = AbortSignal.timeout(TELEGRAM_TIMEOUT_MS);
  let response: Response;
  try {
    response = await ctx.http.fetch(`${ctx.config.telegramApiBase.replace(/\/+$/, "")}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal
    });
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
  const json = await response.json().catch(() => null) as { ok?: unknown; result?: unknown; description?: unknown } | null;
  if (json?.ok === true) return { ok: true, result: json.result };
  const description = typeof json?.description === "string" && json.description.trim() ? json.description.trim() : `Telegram answered ${response.status}`;
  return { ok: false, error: description.split(token).join("…") };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The title in bold, then the text, escaped for HTML and cut with "…" to
 *  the Bot API's limit — never inside an escaped character or between the
 *  two halves of an emoji. */
export function telegramText(notice: Pick<OutgoingNotification, "title" | "text">): string {
  const head = `<b>${escapeHtml(notice.title)}</b>`;
  if (!notice.text) return head.length <= TELEGRAM_TEXT_MAX ? head : `${cutTo(head, TELEGRAM_TEXT_MAX - 1)}…`;
  const full = `${head}\n\n${escapeHtml(notice.text)}`;
  if (full.length <= TELEGRAM_TEXT_MAX) return full;
  return `${cutTo(full, TELEGRAM_TEXT_MAX - 1).replace(/&[a-z]*$/, "")}…`;
}

/** The first `max` UTF-16 units, less a first half of a pair left alone. */
function cutTo(text: string, max: number): string {
  return text.slice(0, max).replace(/[\uD800-\uDBFF]$/, "");
}

function messageBody(channel: NotificationChannelConfig, notice: OutgoingNotification, withButton: boolean): Record<string, unknown> {
  return {
    chat_id: channel.values.chatId,
    text: telegramText(notice),
    parse_mode: "HTML",
    disable_notification: notice.level === "news",
    ...(withButton && notice.url ? { reply_markup: { inline_keyboard: [[{ text: "Open in Mandate", url: notice.url }]] } } : {})
  };
}

/** Telegram refused the button's address (a private or local one, say). */
function refusedButton(error: string): boolean {
  return /button|wrong http url|url host is empty|unsupported url protocol/i.test(error);
}

/** A sent message's ref: its chat and its id there. A message id means
 *  something only in its chat, and a channel may be connected to another
 *  chat since. */
function refOf(channel: NotificationChannelConfig, result: unknown): string | null {
  const id = (result as { message_id?: unknown } | null)?.message_id;
  return typeof id === "number" || typeof id === "string" ? `${channel.values.chatId}:${id}` : null;
}

/** One notice, one new message, kept as sent: an edit in place would not
 *  alert, and a deleted message is gone from the chat the user reads back. */
async function sendMessage(ctx: ChannelContext, channel: NotificationChannelConfig, notice: OutgoingNotification): Promise<SendOutcome> {
  const token = channel.values.botToken ?? "";
  let answer = await call(ctx, token, "sendMessage", messageBody(channel, notice, true));
  // The message matters more than its button: sent again without it.
  if (!answer.ok && notice.url && refusedButton(answer.error)) {
    answer = await call(ctx, token, "sendMessage", messageBody(channel, notice, false));
  }
  if (answer.ok) return { ok: true, ref: refOf(channel, answer.result) };
  return { ok: false, error: answer.error };
}

export const telegramKind: ChannelKind = {
  id: "telegram",
  label: "Telegram",
  secretKeys: ["botToken"],
  ready: (channel) => Boolean(channel.values.botToken?.trim() && channel.values.chatId?.trim()),
  // No replace and no withdraw: each notice is a message of its own, kept.
  send: sendMessage
};

/** Finds the chat the user opened with their bot: the bot's name, and the
 *  newest private chat among its pending updates. A bot cannot start a chat,
 *  so the user writes to it first. */
export async function connectTelegram(ctx: ChannelContext, botToken: string): Promise<{ ok: true; chatId: string; botName: string } | { ok: false; error: string }> {
  const token = botToken.trim();
  if (!token) return { ok: false, error: "Enter the bot token." };
  const me = await call(ctx, token, "getMe", {});
  if (!me.ok) return me;
  const username = (me.result as { username?: unknown } | null)?.username;
  const botName = typeof username === "string" && username ? `@${username}` : "your bot";
  const updates = await call(ctx, token, "getUpdates", { limit: 100, timeout: 0 });
  if (!updates.ok) return updates;
  const chats = (Array.isArray(updates.result) ? updates.result : [])
    .map((update) => (update as { message?: { chat?: { id?: unknown; type?: unknown } } }).message?.chat)
    .filter((chat): chat is { id: number | string; type: string } => chat?.type === "private" && (typeof chat.id === "number" || typeof chat.id === "string"));
  const chat = chats.at(-1);
  return chat ? { ok: true, chatId: String(chat.id), botName } : { ok: false, error: CONNECT_FIRST };
}
