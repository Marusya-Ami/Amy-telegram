export type TelegramVisualMedia = {
  file_id?: string;
  mime_type?: string;
  thumbnail?: TelegramPhotoSize;
  thumb?: TelegramPhotoSize;
};

export type TelegramDocument = {
  file_id: string;
  file_unique_id?: string;
  mime_type?: string;
  file_name?: string;
};

export type TelegramPhotoSize = {
  file_id: string;
  file_unique_id: string;
  width?: number;
  height?: number;
  file_size?: number;
};

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
  photo?: TelegramPhotoSize[];
  video?: TelegramVisualMedia;
  animation?: TelegramVisualMedia;
  document?: TelegramDocument;
  sticker?: unknown;
  media_group_id?: string;
  successful_payment?: TelegramSuccessfulPayment;
  business_connection_id?: string;
  sender_business_bot?: { id: number };
};

export type TelegramBusinessRights = {
  can_reply?: boolean;
  can_read_messages?: boolean;
};

export type TelegramBusinessConnection = {
  id: string;
  user: TelegramUser;
  user_chat_id: number;
  date?: number;
  can_reply?: boolean;
  is_enabled?: boolean;
  rights?: TelegramBusinessRights;
};

export type TelegramDeletedBusinessMessages = {
  business_connection_id?: string;
  chat: TelegramChat;
  message_ids: number[];
};

export type TelegramSuccessfulPayment = {
  currency: string;
  total_amount: number;
  invoice_payload: string;
  telegram_payment_charge_id: string;
  provider_payment_charge_id?: string;
};

export type TelegramPreCheckoutQuery = {
  id: string;
  from: TelegramUser;
  currency: string;
  total_amount: number;
  invoice_payload: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  business_connection?: TelegramBusinessConnection;
  business_message?: TelegramMessage;
  edited_business_message?: TelegramMessage;
  deleted_business_messages?: TelegramDeletedBusinessMessages;
  pre_checkout_query?: TelegramPreCheckoutQuery;
  purchased_paid_media?: TelegramPaidMediaPurchased;
};

export type TelegramPaidMediaPurchased = {
  from: { id: number; is_bot: boolean };
  paid_media_payload: string;
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
  kind: "start" | "text" | "photo" | "video" | "stop" | "delete" | "delete_confirm" | "unsupported";
  type: "TEXT" | "IMAGE" | "VIDEO" | "SYSTEM";
  photoFileId: string | null;
  visualForm: "photo" | "image_file" | "video" | "animation" | null;
  businessConnectionId: string | null;
};
