import { sendChatAction, sendPhotoMessage, sendTextMessage, TelegramRequestError } from "@/lib/telegram/client";
import { parsePrivateInbound, parseUpdate } from "@/lib/telegram/parseUpdate";
import {
  TransportDeliveryError,
  type MessagingTransport,
  type TransportIdentity,
} from "@/services/transport/messagingTransport";

export const telegramBotTransport: MessagingTransport = {
  name: "telegram-bot",

  async sendText(chatId, text, context) {
    try {
      const sent = await sendTextMessage(chatId, text, context);
      return { messageId: sent.messageId };
    } catch (error) {
      if (error instanceof TelegramRequestError) {
        throw new TransportDeliveryError("Text delivery failed", error.retryable, error.status);
      }
      throw error;
    }
  },

  sendMedia() {
    return Promise.reject(new TransportDeliveryError("Media delivery is not available on this transport yet", false));
  },

  async sendBusinessPhoto(chatId, photo) {
    if (!photo.businessConnectionId.trim()) {
      throw new TransportDeliveryError("Business photo refused without a business connection", false, 400);
    }
    try {
      const sent = await sendPhotoMessage({
        chatId,
        businessConnectionId: photo.businessConnectionId,
        telegramFileId: photo.telegramFileId,
        bytes: photo.bytes,
      });
      return { messageId: sent.messageId };
    } catch (error) {
      if (error instanceof TelegramRequestError) {
        throw new TransportDeliveryError("Photo delivery failed", error.retryable, error.status);
      }
      throw error;
    }
  },

  async sendTyping(chatId, context) {
    await sendChatAction(chatId, "typing", context);
  },

  identifyUser(payload): TransportIdentity | null {
    const update = parseUpdate(payload);
    if (!update) return null;
    const inbound = parsePrivateInbound(update);
    if (!inbound) return null;
    return {
      transport: "telegram-bot",
      transportUserId: inbound.telegramUserId,
      chatId: inbound.chatId,
      username: inbound.username,
      firstName: inbound.firstName,
      lastName: inbound.lastName,
      languageCode: inbound.languageCode,
    };
  },
};
