import type { ParsedInbound, TelegramMessage, TelegramUpdate } from "@/lib/telegram/types";

export function parseUpdate(value: unknown): TelegramUpdate | null {
  if (!value || typeof value !== "object") return null;
  const update = value as Partial<TelegramUpdate>;
  if (typeof update.update_id !== "number") return null;
  return update as TelegramUpdate;
}

export function parsePrivateInbound(update: TelegramUpdate): ParsedInbound | null {
  const message = update.message;
  if (!message?.from || message.from.is_bot) return null;
  if (message.chat.type !== "private") return null;

  const text = typeof message.text === "string" ? message.text : null;
  const caption = typeof message.caption === "string" ? message.caption : null;
  const kind = classifyMessage(message, text);

  return {
    updateId: String(update.update_id),
    telegramUserId: String(message.from.id),
    chatId: String(message.chat.id),
    chatType: message.chat.type,
    username: message.from.username ?? null,
    firstName: message.from.first_name ?? null,
    lastName: message.from.last_name ?? null,
    languageCode: message.from.language_code ?? null,
    telegramMessageId: String(message.message_id),
    replyToMessageId: message.reply_to_message ? String(message.reply_to_message.message_id) : null,
    text: text ?? caption,
    kind,
    type: messageType(message, kind),
  };
}

function classifyMessage(message: TelegramMessage, text: string | null): ParsedInbound["kind"] {
  if (text && isStartCommand(text)) return "start";
  if (text && !message.photo && !message.video && !message.sticker) return "text";
  return "unsupported";
}

function messageType(message: TelegramMessage, kind: ParsedInbound["kind"]): ParsedInbound["type"] {
  if (kind === "start" || kind === "text") return "TEXT";
  if (message.photo) return "IMAGE";
  if (message.video) return "VIDEO";
  return "SYSTEM";
}

function isStartCommand(text: string): boolean {
  const command = text.trim().split(/\s+/)[0]?.split("@")[0]?.toLowerCase();
  return command === "/start";
}
