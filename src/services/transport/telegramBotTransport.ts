import { sendChatAction, sendTextMessage, TelegramRequestError } from "@/lib/telegram/client";
import { parsePrivateInbound, parseUpdate } from "@/lib/telegram/parseUpdate";
import {
  TransportDeliveryError,
  type MessagingTransport,
  type TransportIdentity,
} from "@/services/transport/messagingTransport";

export const telegramBotTransport: MessagingTransport = {
  name: "telegram-bot",

  async sendText(chatId, text) {
    try {
      const sent = await sendTextMessage(chatId, text);
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

  async sendTyping(chatId) {
    await sendChatAction(chatId, "typing");
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
