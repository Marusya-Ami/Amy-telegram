export type TelegramUser = {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code?: string;
};

export type TelegramChat = {
  id: number;
  type: string;
};

export type TelegramMessage = {
  message_id: number;
  date?: number;
  text?: string;
  caption?: string;
  chat: TelegramChat;
  from?: TelegramUser;
  reply_to_message?: { message_id: number };
  photo?: unknown[];
  video?: unknown;
  sticker?: unknown;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

export type ParsedInbound = {
  updateId: string;
  telegramUserId: string;
  chatId: string;
  chatType: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  languageCode: string | null;
  telegramMessageId: string;
  replyToMessageId: string | null;
  text: string | null;
  kind: "start" | "text" | "unsupported";
  type: "TEXT" | "IMAGE" | "VIDEO" | "SYSTEM";
};
