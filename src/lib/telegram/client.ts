import { logger } from "@/lib/logger";
import { getEnv } from "@/lib/env";
import { sleep, withRetry } from "@/lib/retry";

const TELEGRAM_API = "https://api.telegram.org";

export class TelegramRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly description?: string,
  ) {
    super(message);
    this.name = "TelegramRequestError";
  }
}

type SendResult = {
  messageId: string;
};

export type TelegramDeliveryContext = {
  businessConnectionId?: string | null;
  replyMarkup?: {
    inline_keyboard: Array<Array<{ text: string; url: string }>>;
  };
  disableLinkPreview?: boolean;
};

export async function sendTextMessage(
  chatId: string,
  text: string,
  context?: TelegramDeliveryContext,
): Promise<SendResult> {
  const chunks = splitTelegramText(text);
  let last: SendResult | null = null;

  for (const chunk of chunks) {
    last = await sendChunk(chatId, chunk, context);
  }

  if (!last) {
    throw new TelegramRequestError("Refused to send an empty Telegram message", 400, false);
  }

  return last;
}

async function sendChunk(chatId: string, text: string, context?: TelegramDeliveryContext): Promise<SendResult> {
  const started = Date.now();

  return withRetry(
    "telegram.sendMessage",
    async () => {
      const token = getEnv().TELEGRAM_BOT_TOKEN;
      const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(deliveryBody(chatId, { text }, context)),
      });

      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; description?: string; parameters?: { retry_after?: number }; result?: { message_id?: number } }
        | null;

      if (!response.ok || !payload?.ok || payload.result?.message_id == null) {
        const retryAfter = payload?.parameters?.retry_after;
        if (response.status === 429 && retryAfter) {
          await sleep(Math.min(retryAfter, 5) * 1000);
        }

        logger.error("telegram.outbound_failed", {
          chatId,
          status: response.status,
          description: payload?.description ?? "unknown",
          durationMs: Date.now() - started,
        });

        throw new TelegramRequestError(
          "Telegram sendMessage failed",
          response.status,
          response.status === 429 || response.status >= 500,
          payload?.description,
        );
      }

      logger.info("telegram.outbound", {
        chatId,
        telegramMessageId: String(payload.result.message_id),
        chars: text.length,
        durationMs: Date.now() - started,
      });

      return { messageId: String(payload.result.message_id) };
    },
    {
      attempts: 3,
      isRetryable: (error) => error instanceof TelegramRequestError && error.retryable,
    },
  );
}

/** Native paid-media album. Telegram blurs the photos and shows the Stars unlock itself. */
export function paidMediaItems(count: number): Array<{ type: "photo"; media: string }> {
  return Array.from({ length: count }, (_, index) => ({ type: "photo", media: `attach://paid${index}` }));
}

export async function sendPaidMediaMessage(input: {
  chatId: string;
  businessConnectionId: string;
  starCount: number;
  payload: string;
  caption?: string | null;
  media: Buffer[];
}): Promise<SendResult> {
  const businessConnectionId = input.businessConnectionId.trim();
  if (!businessConnectionId) {
    throw new TelegramRequestError("Telegram sendPaidMedia refused without a business connection", 400, false);
  }
  if (!Number.isInteger(input.starCount) || input.starCount < 1 || input.starCount > 25000) {
    throw new TelegramRequestError("Telegram sendPaidMedia refused an invalid star count", 400, false);
  }
  const payload = input.payload.trim();
  if (!payload || Buffer.byteLength(payload) > 128) {
    throw new TelegramRequestError("Telegram sendPaidMedia refused an invalid payload", 400, false);
  }
  if (input.media.length < 1 || input.media.length > 10 || input.media.some((item) => item.length < 1)) {
    throw new TelegramRequestError("Telegram sendPaidMedia has no photo", 400, false);
  }
  const form = new FormData();
  form.set("chat_id", input.chatId);
  form.set("business_connection_id", businessConnectionId);
  form.set("star_count", String(input.starCount));
  form.set("payload", payload);
  const caption = input.caption?.trim() ?? "";
  if (caption) form.set("caption", caption);
  form.set("media", JSON.stringify(paidMediaItems(input.media.length)));
  input.media.forEach((bytes, index) => {
    form.set(`paid${index}`, new Blob([Uint8Array.from(bytes)], { type: "image/jpeg" }), `paid${index}.jpg`);
  });
  return postTelegramMedia("sendPaidMedia", input.chatId, form);
}

/** Disk imports use a local- id. Telegram rejects those, so the stored bytes are the photo. */
export function telegramPhotoId(fileId: string | null | undefined): string {
  const trimmed = fileId?.trim() ?? "";
  if (!trimmed || trimmed.startsWith("local-")) return "";
  return trimmed;
}

/** Telegram sometimes echoes a URL inside the error. Keep that out of the logs. */
export function safeTelegramDescription(description: string | null | undefined): string {
  const text = description?.trim() || "unknown";
  if (/https?:/i.test(text)) return "telegram_error_redacted";
  return text.slice(0, 180);
}

/** Fields sendPhoto accepts. Caption and reply_markup are omitted unless a paid preview asks for them. */
export function photoDeliveryFields(input: {
  businessConnectionId: string;
  photo: string;
  caption?: string | null;
  replyMarkup?: TelegramDeliveryContext["replyMarkup"];
}): Record<string, unknown> {
  const caption = input.caption?.trim() ?? "";
  return {
    business_connection_id: input.businessConnectionId,
    photo: input.photo,
    ...(caption ? { caption } : {}),
    ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {}),
  };
}

export async function sendPhotoMessage(input: {
  chatId: string;
  businessConnectionId: string;
  telegramFileId?: string | null;
  bytes?: Buffer | null;
  caption?: string | null;
  replyMarkup?: TelegramDeliveryContext["replyMarkup"];
}): Promise<SendResult> {
  const businessConnectionId = input.businessConnectionId.trim();
  if (!businessConnectionId) {
    throw new TelegramRequestError("Telegram sendPhoto refused without a business connection", 400, false);
  }
  const fileId = telegramPhotoId(input.telegramFileId);
  if (fileId) {
    try {
      return await postTelegramMedia("sendPhoto", input.chatId, photoDeliveryFields({
        businessConnectionId,
        photo: fileId,
        caption: input.caption,
        replyMarkup: input.replyMarkup,
      }));
    } catch (error) {
      if (!(error instanceof TelegramRequestError) || error.status !== 400 || !input.bytes?.length) throw error;
      if (!/file/i.test(error.description ?? "")) throw error;
    }
  }
  if (!input.bytes?.length) {
    throw new TelegramRequestError("Telegram sendPhoto has no photo", 400, false);
  }
  const fields = photoDeliveryFields({
    businessConnectionId,
    photo: "upload",
    caption: input.caption,
    replyMarkup: input.replyMarkup,
  });
  const form = new FormData();
  form.set("chat_id", input.chatId);
  form.set("business_connection_id", businessConnectionId);
  if (typeof fields.caption === "string") form.set("caption", fields.caption);
  if (fields.reply_markup) form.set("reply_markup", JSON.stringify(fields.reply_markup));
  form.set("photo", new Blob([Uint8Array.from(input.bytes)]), "photo.jpg");
  return postTelegramMedia("sendPhoto", input.chatId, form);
}

async function postTelegramMedia(method: "sendPhoto" | "sendPaidMedia", chatId: string, body: FormData | Record<string, unknown>): Promise<SendResult> {
  const started = Date.now();
  const token = getEnv().TELEGRAM_BOT_TOKEN;
  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: body instanceof FormData ? undefined : { "content-type": "application/json" },
    body: body instanceof FormData ? body : JSON.stringify({ chat_id: chatId, ...body }),
  });
  const payload = (await response.json().catch(() => null)) as
    | { ok?: boolean; description?: string; result?: { message_id?: number } }
    | null;
  if (!response.ok || !payload?.ok || payload.result?.message_id == null) {
    logger.error("telegram.outbound_failed", {
      chatId,
      status: response.status,
      description: safeTelegramDescription(payload?.description),
      kind: method === "sendPaidMedia" ? "paid_media" : "photo",
      durationMs: Date.now() - started,
    });
    throw new TelegramRequestError(
      `Telegram ${method} failed`,
      response.status,
      response.status === 429 || response.status >= 500,
      payload?.description,
    );
  }
  logger.info("telegram.outbound", {
    chatId,
    telegramMessageId: String(payload.result.message_id),
    kind: method === "sendPaidMedia" ? "paid_media" : "photo",
    durationMs: Date.now() - started,
  });
  return { messageId: String(payload.result.message_id) };
}

export async function editMessageReplyMarkup(
  chatId: string,
  messageId: string,
  context: {
    businessConnectionId: string;
    replyMarkup: NonNullable<TelegramDeliveryContext["replyMarkup"]>;
  },
): Promise<void> {
  await telegramMethod("editMessageReplyMarkup", {
    business_connection_id: context.businessConnectionId,
    chat_id: chatId,
    message_id: Number(messageId),
    reply_markup: context.replyMarkup,
  });
}

export async function sendChatAction(
  chatId: string,
  action: "typing",
  context?: TelegramDeliveryContext,
): Promise<void> {
  const token = getEnv().TELEGRAM_BOT_TOKEN;
  const response = await fetch(`${TELEGRAM_API}/bot${token}/sendChatAction`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(deliveryBody(chatId, { action }, context)),
  });

  if (!response.ok) {
    logger.warn("telegram.typing_failed", { chatId, status: response.status });
  }
}

export type StarsInvoiceLinkRequest = {
  business_connection_id: string;
  title: string;
  description: string;
  payload: string;
  currency: "XTR";
  prices: [{ label: string; amount: number }];
};

/** Official Stars invoice link on behalf of a business account. provider_token is omitted. */
export function starsInvoiceLinkBody(input: {
  businessConnectionId: string;
  title: string;
  description: string;
  payload: string;
  amount: number;
}): StarsInvoiceLinkRequest {
  return {
    business_connection_id: input.businessConnectionId,
    title: input.title.slice(0, 32),
    description: input.description.slice(0, 255),
    payload: input.payload,
    currency: "XTR",
    prices: [{ label: input.title.slice(0, 32), amount: input.amount }],
  };
}

export async function createStarsInvoiceLink(input: {
  businessConnectionId: string;
  title: string;
  description: string;
  payload: string;
  amount: number;
}): Promise<string> {
  const body = starsInvoiceLinkBody(input);
  const result = await telegramMethod("createInvoiceLink", body);
  if (typeof result !== "string" || result.length === 0) {
    throw new TelegramRequestError("Telegram createInvoiceLink failed", 502, true);
  }
  logger.info("telegram.invoice_link_created", { payloadLength: input.payload.length });
  return result;
}

export async function answerPreCheckoutQuery(input: {
  id: string;
  ok: boolean;
  errorMessage?: string;
}): Promise<void> {
  await telegramMethod("answerPreCheckoutQuery", {
    pre_checkout_query_id: input.id,
    ok: input.ok,
    ...(input.ok ? {} : { error_message: input.errorMessage ?? "This payment can't be completed." }),
  });
}

export function refundStarPaymentBody(userId: string, telegramPaymentChargeId: string): {
  user_id: number;
  telegram_payment_charge_id: string;
} {
  return {
    user_id: Number(userId),
    telegram_payment_charge_id: telegramPaymentChargeId,
  };
}

async function telegramMethod(method: string, body: Record<string, unknown>): Promise<unknown> {
  const token = getEnv().TELEGRAM_BOT_TOKEN;
  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as { ok?: boolean; result?: unknown; description?: string } | null;
  if (!response.ok || !payload?.ok) {
    logger.error("telegram.method_failed", { method, status: response.status });
    throw new TelegramRequestError(`Telegram ${method} failed`, response.status, response.status === 429 || response.status >= 500);
  }
  return payload.result;
}

function deliveryBody(
  chatId: string,
  fields: Record<string, unknown>,
  context?: TelegramDeliveryContext,
): Record<string, unknown> {
  const businessConnectionId = context?.businessConnectionId?.trim();
  return {
    chat_id: chatId,
    ...fields,
    ...(businessConnectionId ? { business_connection_id: businessConnectionId } : {}),
    ...(context?.replyMarkup ? { reply_markup: context.replyMarkup } : {}),
    ...(context?.disableLinkPreview ? { link_preview_options: { is_disabled: true } } : {}),
  };
}

function splitTelegramText(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const limit = 4000;
  if (trimmed.length <= limit) return [trimmed];

  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > limit) {
    chunks.push(rest.slice(0, limit));
    rest = rest.slice(limit);
  }
  if (rest) chunks.push(rest);
  return chunks;
}
