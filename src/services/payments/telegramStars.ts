import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db/prisma";
import { isUniqueConstraintError } from "@/lib/db/errors";
import { logger } from "@/lib/logger";
import {
  answerPreCheckoutQuery,
  createStarsInvoiceLink,
  sendTextMessage,
  starsInvoiceLinkBody,
  type StarsInvoiceLinkRequest,
} from "@/lib/telegram/client";
import type { TelegramPreCheckoutQuery, TelegramSuccessfulPayment, TelegramUpdate } from "@/lib/telegram/types";
import { ensureShowerTimeOffer, hasPurchasedOffer, SHOWER_TIME_SLUG } from "@/services/payments/offers";

const REJECT_MESSAGE = "This payment can't be completed.";

export type StarsCheckoutDeps = {
  createInvoiceLink: (request: StarsInvoiceLinkRequest) => Promise<string>;
  sendBusinessText: (chatId: string, text: string, businessConnectionId: string) => Promise<void>;
  sendAdminText: (chatId: string, text: string) => Promise<void>;
  answerPreCheckout: (id: string, ok: boolean, errorMessage?: string) => Promise<void>;
};

type CheckReason =
  | "unknown_payload"
  | "not_pending"
  | "wrong_provider"
  | "wrong_currency"
  | "wrong_amount"
  | "wrong_user"
  | "inactive_offer"
  | "inactive_price";

export function classifyStarsAdminCommand(
  update: TelegramUpdate,
  ownerTelegramId: string,
): { chatId: string; telegramUserId?: string; last: boolean } | null {
  const owner = ownerTelegramId.trim();
  if (!owner) return null;
  const message = update.message;
  if (!message?.from || message.from.is_bot) return null;
  if (message.chat?.type !== "private") return null;
  if (message.business_connection_id) return null;
  if (String(message.from.id) !== owner) return null;
  const text = typeof message.text === "string" ? message.text.trim() : "";
  const parts = text.split(/\s+/);
  const token = parts[0]?.split("@")[0]?.toLowerCase();
  if (token === "/stars_test_last" && parts.length === 1) {
    return { chatId: String(message.chat.id), last: true };
  }
  if (token === "/stars_test" && parts.length === 2 && /^\d+$/.test(parts[1] ?? "")) {
    return { chatId: String(message.chat.id), telegramUserId: parts[1], last: false };
  }
  return null;
}

export async function processStarsAdminCommand(
  update: TelegramUpdate,
  ownerTelegramId: string,
  deps: StarsCheckoutDeps = defaultDeps(),
): Promise<void> {
  const command = classifyStarsAdminCommand(update, ownerTelegramId);
  if (!command) return;
  try {
    const result = await createStarsCheckout({
      ownerTelegramId,
      telegramUserId: command.telegramUserId,
      useLatestBusinessConversation: command.last,
      deps,
    });
    await deps.sendAdminText(command.chatId, result.adminText);
  } catch (error) {
    logger.error("payments.stars.checkout_failed", {
      name: error instanceof Error ? error.name : "Error",
    });
    await deps.sendAdminText(command.chatId, "Couldn't create the Stars checkout.");
  }
}

export async function createStarsCheckout(input: {
  ownerTelegramId: string;
  telegramUserId?: string;
  useLatestBusinessConversation: boolean;
  deps: StarsCheckoutDeps;
}): Promise<{ adminText: string; payload: string }> {
  const target = await selectCheckoutTarget(input.ownerTelegramId, input);
  if (!target) {
    return { adminText: "No Amy Business conversation is available for that user.", payload: "" };
  }
  const { offer, price } = await ensureShowerTimeOffer();
  if (!offer.active || !price.active || price.amount !== 420 || price.currency !== "XTR") {
    return { adminText: "The shower-time Stars price is not active.", payload: "" };
  }

  const payload = randomBytes(16).toString("hex");
  const intent = await prisma.paymentIntent.create({
    data: {
      provider: "TELEGRAM_STARS",
      userId: target.userId,
      conversationId: target.conversationId,
      offerId: offer.id,
      status: "PENDING",
      amount: price.amount,
      currency: price.currency,
      providerInvoicePayload: payload,
    },
  });

  const request = starsInvoiceLinkBody({
    businessConnectionId: target.businessConnectionId,
    title: offer.title,
    description: offer.description ?? offer.title,
    payload,
    amount: price.amount,
  });
  const link = await input.deps.createInvoiceLink(request);
  await input.deps.sendBusinessText(
    target.chatId,
    link,
    target.businessConnectionId,
  );
  logger.info("payments.stars.checkout_sent", {
    intentId: intent.id,
    offerSlug: SHOWER_TIME_SLUG,
    payloadLength: payload.length,
  });
  return { adminText: `Stars checkout sent.\n\nOffer: ${SHOWER_TIME_SLUG}\nIntent: ${intent.id}`, payload };
}

export async function handlePreCheckoutQuery(
  query: TelegramPreCheckoutQuery,
  deps: Pick<StarsCheckoutDeps, "answerPreCheckout"> = { answerPreCheckout: (id, ok, errorMessage) => answerPreCheckoutQuery({ id, ok, errorMessage }) },
): Promise<void> {
  const check = await validateStarsCheckout({
    payload: query.invoice_payload,
    currency: query.currency,
    totalAmount: query.total_amount,
    telegramUserId: String(query.from.id),
    requirePending: true,
  });
  if (!check.ok) {
    logger.warn("payments.stars.pre_checkout_rejected", {
      reason: check.reason,
      ...payloadLog(query.invoice_payload),
    });
    await deps.answerPreCheckout(query.id, false, REJECT_MESSAGE);
    return;
  }
  await deps.answerPreCheckout(query.id, true);
  logger.info("payments.stars.pre_checkout_approved", { intentId: check.intentId, ...payloadLog(query.invoice_payload) });
}

export async function handleSuccessfulPayment(input: {
  payment: TelegramSuccessfulPayment;
  telegramUserId: string;
  paidAt?: Date;
}): Promise<"recorded" | "duplicate" | "rejected"> {
  const existing = await prisma.payment.findUnique({
    where: { providerPaymentId: input.payment.telegram_payment_charge_id },
  });
  if (existing) return "duplicate";

  const check = await validateStarsCheckout({
    payload: input.payment.invoice_payload,
    currency: input.payment.currency,
    totalAmount: input.payment.total_amount,
    telegramUserId: input.telegramUserId,
    requirePending: true,
  });
  if (!check.ok) {
    if (check.reason === "not_pending") {
      const paid = await prisma.payment.findFirst({ where: { intentId: check.intentId } });
      if (paid) return "duplicate";
    }
    logger.warn("payments.stars.success_rejected", {
      reason: check.reason,
      ...payloadLog(input.payment.invoice_payload),
    });
    return "rejected";
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.payment.create({
        data: {
          provider: "TELEGRAM_STARS",
          userId: check.userId,
          offerId: check.offerId,
          intentId: check.intentId,
          amount: check.amount,
          currency: "XTR",
          status: "PAID",
          providerPaymentId: input.payment.telegram_payment_charge_id,
          providerOrderId: input.payment.provider_payment_charge_id ?? null,
          paidAt: input.paidAt ?? new Date(),
        },
      });
      await tx.paymentIntent.update({
        where: { id: check.intentId },
        data: {
          status: "PAID",
          paidAt: input.paidAt ?? new Date(),
          providerOrderId: input.payment.provider_payment_charge_id ?? null,
        },
      });
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    return "duplicate";
  }
  logger.info("payments.stars.recorded", { intentId: check.intentId, offerSlug: SHOWER_TIME_SLUG });
  return "recorded";
}

export async function handlePurchasedPaidMedia(input: {
  telegramUserId: string;
  payload: string;
  paidAt?: Date;
}): Promise<"recorded" | "duplicate" | "rejected"> {
  const payload = input.payload.trim();
  if (!payload || Buffer.byteLength(payload) > 128) return "rejected";
  const stored = await prisma.paymentIntent.findUnique({
    where: { providerInvoicePayload: payload },
    select: { amount: true, currency: true, user: { select: { telegramUserId: true } } },
  });
  if (!stored) return "rejected";
  if (stored.user.telegramUserId !== input.telegramUserId) return "rejected";
  const providerPaymentId = `paid-media:${payload}`;
  const existing = await prisma.payment.findUnique({ where: { providerPaymentId } });
  if (existing) return "duplicate";
  const check = await validateStarsCheckout({
    payload,
    currency: stored.currency,
    totalAmount: stored.amount,
    telegramUserId: input.telegramUserId,
    requirePending: true,
  });
  if (!check.ok) {
    if (check.reason === "not_pending") {
      const paid = await prisma.payment.findFirst({ where: { intentId: check.intentId } });
      if (paid) return "duplicate";
    }
    logger.warn("payments.stars.paid_media_rejected", { reason: check.reason, ...payloadLog(payload) });
    return "rejected";
  }
  try {
    await prisma.$transaction(async (tx) => {
      await tx.payment.create({
        data: {
          provider: "TELEGRAM_STARS",
          userId: check.userId,
          offerId: check.offerId,
          intentId: check.intentId,
          amount: check.amount,
          currency: "XTR",
          status: "PAID",
          providerPaymentId,
          paidAt: input.paidAt ?? new Date(),
        },
      });
      await tx.paymentIntent.update({
        where: { id: check.intentId },
        data: { status: "PAID", paidAt: input.paidAt ?? new Date() },
      });
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    return "duplicate";
  }
  logger.info("payments.stars.paid_media_recorded", { intentId: check.intentId, offerSlug: SHOWER_TIME_SLUG });
  return "recorded";
}

export function purchasedPaidMediaFrom(update: TelegramUpdate): { telegramUserId: string; payload: string } | null {
  const purchase = update.purchased_paid_media;
  if (!purchase?.from || purchase.from.is_bot) return null;
  if (typeof purchase.paid_media_payload !== "string" || !purchase.paid_media_payload.trim()) return null;
  return { telegramUserId: String(purchase.from.id), payload: purchase.paid_media_payload };
}

export function successfulPaymentFrom(update: TelegramUpdate): { payment: TelegramSuccessfulPayment; telegramUserId: string; paidAt?: Date } | null {
  const message = update.message?.successful_payment
    ? update.message
    : update.business_message?.successful_payment
      ? update.business_message
      : null;
  if (!message?.successful_payment || !message.from || message.from.is_bot) return null;
  const paidAt = typeof message.date === "number" ? new Date(message.date * 1000) : undefined;
  return {
    payment: message.successful_payment,
    telegramUserId: String(message.from.id),
    paidAt,
  };
}

async function validateStarsCheckout(input: {
  payload: string;
  currency: string;
  totalAmount: number;
  telegramUserId: string;
  requirePending: boolean;
}): Promise<
  | { ok: true; intentId: string; userId: string; offerId: string; amount: number }
  | { ok: false; reason: CheckReason; intentId?: string }
> {
  const intent = await prisma.paymentIntent.findUnique({
    where: { providerInvoicePayload: input.payload },
    include: { offer: true, user: true },
  });
  if (!intent) return { ok: false, reason: "unknown_payload" };
  if (input.requirePending && intent.status !== "PENDING") return { ok: false, reason: "not_pending", intentId: intent.id };
  if (intent.provider !== "TELEGRAM_STARS") return { ok: false, reason: "wrong_provider", intentId: intent.id };
  if (input.currency !== "XTR" || intent.currency !== "XTR") return { ok: false, reason: "wrong_currency", intentId: intent.id };
  if (input.totalAmount !== intent.amount) return { ok: false, reason: "wrong_amount", intentId: intent.id };
  if (intent.user.telegramUserId !== input.telegramUserId) return { ok: false, reason: "wrong_user", intentId: intent.id };
  if (!intent.offer.active) return { ok: false, reason: "inactive_offer", intentId: intent.id };
  const price = await prisma.paymentOfferPrice.findUnique({
    where: {
      offerId_provider_currency: {
        offerId: intent.offerId,
        provider: "TELEGRAM_STARS",
        currency: "XTR",
      },
    },
  });
  if (!price?.active || price.amount !== intent.amount || price.currency !== "XTR") {
    return { ok: false, reason: "inactive_price", intentId: intent.id };
  }
  return { ok: true, intentId: intent.id, userId: intent.userId, offerId: intent.offerId, amount: intent.amount };
}

async function selectCheckoutTarget(
  ownerTelegramId: string,
  input: { telegramUserId?: string; useLatestBusinessConversation: boolean },
): Promise<{ userId: string; conversationId: string; chatId: string; businessConnectionId: string } | null> {
  if (input.useLatestBusinessConversation) {
    const conversation = await prisma.conversation.findFirst({
      where: {
        platform: "telegram-business",
        businessConnectionId: { not: null },
        active: true,
        user: { telegramUserId: { not: ownerTelegramId } },
      },
      orderBy: { updatedAt: "desc" },
      include: { user: true },
    });
    if (!conversation?.businessConnectionId) return null;
    return {
      userId: conversation.userId,
      conversationId: conversation.id,
      chatId: conversation.platformConversationId,
      businessConnectionId: conversation.businessConnectionId,
    };
  }
  if (!input.telegramUserId) return null;
  const user = await prisma.user.findUnique({ where: { telegramUserId: input.telegramUserId } });
  if (!user || user.telegramUserId === ownerTelegramId) return null;
  const conversation = await prisma.conversation.findFirst({
    where: {
      userId: user.id,
      platform: "telegram-business",
      businessConnectionId: { not: null },
      active: true,
    },
    orderBy: { updatedAt: "desc" },
  });
  if (!conversation?.businessConnectionId) return null;
  return {
    userId: user.id,
    conversationId: conversation.id,
    chatId: conversation.platformConversationId,
    businessConnectionId: conversation.businessConnectionId,
  };
}

function payloadLog(payload: string): { payloadPrefix: string; payloadLength: number } {
  return { payloadPrefix: payload.slice(0, 4), payloadLength: payload.length };
}

function defaultDeps(): StarsCheckoutDeps {
  return {
    createInvoiceLink: (request) =>
      createStarsInvoiceLink({
        businessConnectionId: request.business_connection_id,
        title: request.title,
        description: request.description,
        payload: request.payload,
        amount: request.prices[0].amount,
      }),
    sendBusinessText: async (chatId, text, businessConnectionId) => {
      await sendTextMessage(chatId, text, { businessConnectionId });
    },
    sendAdminText: async (chatId, text) => {
      await sendTextMessage(chatId, text);
    },
    answerPreCheckout: (id, ok, errorMessage) => answerPreCheckoutQuery({ id, ok, errorMessage }),
  };
}

export { hasPurchasedOffer };
