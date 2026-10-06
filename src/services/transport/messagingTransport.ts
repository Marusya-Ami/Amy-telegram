export type TransportName = "telegram-bot";

export type TransportIdentity = {
  transport: TransportName;
  transportUserId: string;
  chatId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  languageCode: string | null;
};

export type OutboundMedia =
  | { kind: "image"; source: string }
  | { kind: "video"; source: string };

export type OutboundRef = {
  messageId: string;
};

export class TransportDeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TransportDeliveryError";
  }
}

export type DeliveryContext = {
  businessConnectionId?: string | null;
};

export interface MessagingTransport {
  readonly name: TransportName;
  sendText(chatId: string, text: string, context?: DeliveryContext): Promise<OutboundRef>;
  sendMedia(chatId: string, media: OutboundMedia): Promise<OutboundRef>;
  sendBusinessPhoto(
    chatId: string,
    photo: { businessConnectionId: string; telegramFileId?: string | null; bytes?: Buffer | null },
  ): Promise<OutboundRef>;
  sendTyping(chatId: string, context?: DeliveryContext): Promise<void>;
  identifyUser(payload: unknown): TransportIdentity | null;
}
