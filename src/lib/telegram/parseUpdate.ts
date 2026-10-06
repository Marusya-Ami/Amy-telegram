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
  return parseMessage(update, message);
}

function parseMessage(update: TelegramUpdate, message: TelegramMessage): ParsedInbound | null {
  if (!message.from) return null;
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
    photoFileId: customerImage(message).fileId,
    visualForm: customerImage(message).form,
    businessConnectionId: null,
  };
}

export type InterpretedTelegramUpdate =
  | { action: "inbound"; inbound: ParsedInbound }
  | {
      action: "business_connection";
      connectionId: string;
      businessUserId: string;
      userChatId: string;
      isEnabled: boolean;
      canReply: boolean;
    }
  | { action: "edited_business_message"; updateId: string; chatId: string; messageId: string }
  | { action: "deleted_business_messages"; updateId: string; chatId: string; messageCount: number }
  | { action: "ignore"; reason: string };

export function interpretUpdate(update: TelegramUpdate): InterpretedTelegramUpdate {
  if (update.business_connection) {
    const connection = update.business_connection;
    if (!connection.id || !connection.user?.id || connection.user_chat_id == null) {
      return { action: "ignore", reason: "invalid_business_connection" };
    }
    return {
      action: "business_connection",
      connectionId: connection.id,
      businessUserId: String(connection.user.id),
      userChatId: String(connection.user_chat_id),
      isEnabled: connection.is_enabled === true,
      canReply: connection.rights?.can_reply === true || connection.can_reply === true,
    };
  }

  if (update.edited_business_message) {
    const message = update.edited_business_message;
    return {
      action: "edited_business_message",
      updateId: String(update.update_id),
      chatId: String(message.chat?.id ?? ""),
      messageId: String(message.message_id),
    };
  }

  if (update.deleted_business_messages) {
    const deleted = update.deleted_business_messages;
    return {
      action: "deleted_business_messages",
      updateId: String(update.update_id),
      chatId: String(deleted.chat?.id ?? ""),
      messageCount: deleted.message_ids?.length ?? 0,
    };
  }

  if (update.business_message) {
    const inbound = parseBusinessInbound(update, update.business_message);
    return inbound ? { action: "inbound", inbound } : { action: "ignore", reason: "business_message_not_inbound" };
  }

  const inbound = parsePrivateInbound(update);
  return inbound ? { action: "inbound", inbound } : { action: "ignore", reason: "no_private_message" };
}

function parseBusinessInbound(update: TelegramUpdate, message: TelegramMessage): ParsedInbound | null {
  if (!message.from || message.from.is_bot || message.sender_business_bot) return null;
  if (message.chat?.type !== "private") return null;
  if (String(message.from.id) !== String(message.chat.id)) return null;
  if (!message.business_connection_id) return null;

  const inbound = parseMessage(update, message);
  if (!inbound) return null;
  return { ...inbound, businessConnectionId: message.business_connection_id };
}

function classifyMessage(message: TelegramMessage, text: string | null): ParsedInbound["kind"] {
  if (text && isCommand(text, "/start")) return "start";
  if (text && isCommand(text, "/stop")) return "stop";
  if (text && text.trim().toLowerCase() === "/delete confirm") return "delete_confirm";
  if (text && isCommand(text, "/delete")) return "delete";
  const image = customerImage(message);
  if (image.form === "photo" || image.form === "image_file") return "photo";
  if (image.form === "video" || image.form === "animation") return "video";
  if (text && !message.video && !message.animation && !message.sticker) return "text";
  return "unsupported";
}

const IMAGE_NAME = /\.(jpe?g|png|webp|gif|heic|heif)$/i;

export function customerImage(message: TelegramMessage): {
  fileId: string | null;
  form: "photo" | "image_file" | "video" | "animation" | null;
} {
  if (message.photo?.length) return { fileId: largestPhotoFileId(message.photo), form: "photo" };
  if (isImageDocument(message.document)) return { fileId: message.document.file_id, form: "image_file" };
  if (message.video) return { fileId: stillFileId(message.video), form: "video" };
  if (message.animation) return { fileId: stillFileId(message.animation), form: "animation" };
  return { fileId: null, form: null };
}

function isImageDocument(document: TelegramMessage["document"]): document is NonNullable<TelegramMessage["document"]> {
  if (!document?.file_id) return false;
  const mime = document.mime_type?.toLowerCase() ?? "";
  if (mime.startsWith("image/")) return true;
  return IMAGE_NAME.test(document.file_name ?? "");
}

function stillFileId(media: NonNullable<TelegramMessage["video"]>): string | null {
  const still = media.thumbnail ?? media.thumb;
  return still?.file_id ?? null;
}

export function largestPhotoFileId(photos: TelegramMessage["photo"]): string | null {
  if (!photos?.length) return null;
  let best = photos[0];
  for (const photo of photos) {
    if ((photo.file_size ?? 0) >= (best?.file_size ?? 0)) best = photo;
  }
  return best?.file_id ?? null;
}

function messageType(message: TelegramMessage, kind: ParsedInbound["kind"]): ParsedInbound["type"] {
  if (kind === "photo" || message.photo?.length || isImageDocument(message.document)) return "IMAGE";
  if (kind === "video" || message.video || message.animation) return "VIDEO";
  if (kind !== "unsupported") return "TEXT";
  return "SYSTEM";
}

function isCommand(text: string, command: string): boolean {
  const token = text.trim().split(/\s+/)[0]?.split("@")[0]?.toLowerCase();
  return token === command;
}
