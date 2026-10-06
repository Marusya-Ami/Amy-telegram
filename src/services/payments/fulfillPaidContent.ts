import { prisma } from "@/lib/db/prisma";
import { isUniqueConstraintError } from "@/lib/db/errors";
import { logger } from "@/lib/logger";
import { sendTextMessage } from "@/lib/telegram/client";
import type { TelegramUpdate } from "@/lib/telegram/types";
import { mediaSentLabel } from "@/services/media/delivery";
import { readFreePhoto } from "@/services/media/library";
import { telegramBotTransport } from "@/services/transport/telegramBotTransport";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type PaidDeliverySend = (input: {
  chatId: string;
  businessConnectionId: string;
  mediaAssetId: string;
  telegramFileId: string;
  bytes: Buffer | null;
}) => Promise<{ telegramMessageId: string }>;

export type FulfillmentStatus = "fulfilled" | "incomplete" | "nothing_to_deliver" | "missing_business" | "not_paid";

const tails = new Map<string, Promise<unknown>>();

export async function fulfillPaidContent(input: {
  paymentId: string;
  sendPhoto?: PaidDeliverySend;
}): Promise<{ status: FulfillmentStatus; delivered: number; pending: number }> {
  const previous = tails.get(input.paymentId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => fulfillOnce(input));
  tails.set(input.paymentId, run);
  try {
    return await run;
  } finally {
    if (tails.get(input.paymentId) === run) tails.delete(input.paymentId);
  }
}

async function fulfillOnce(input: {
  paymentId: string;
  sendPhoto?: PaidDeliverySend;
}): Promise<{ status: FulfillmentStatus; delivered: number; pending: number }> {
  const payment = await prisma.payment.findUnique({
    where: { id: input.paymentId },
    select: { id: true, userId: true, offerId: true, status: true, intentId: true },
  });
  if (!payment || payment.status !== "PAID") {
    return { status: "not_paid", delivered: 0, pending: 0 };
  }

  const conversation = await businessConversation(payment.userId, payment.intentId);
  const items = await loadDeliverables(payment.offerId);
  const done = await prisma.paidContentDelivery.findMany({
    where: { paymentId: payment.id, telegramMessageId: { not: null } },
    select: { paymentOfferMediaId: true },
  });
  const deliveredIds = new Set(done.map((row) => row.paymentOfferMediaId));
  const pending = items.filter((item) => !deliveredIds.has(item.id));
  if (!conversation) {
    logger.warn("paid_content.missing_business", { paymentId: payment.id, offerId: payment.offerId, pending: pending.length });
    return { status: pending.length === 0 && items.length === 0 ? "nothing_to_deliver" : "missing_business", delivered: done.length, pending: pending.length };
  }
  if (pending.length === 0) {
    logger.info("paid_content.fulfilled", { paymentId: payment.id, offerId: payment.offerId, delivered: done.length, pending: 0 });
    return { status: items.length === 0 ? "nothing_to_deliver" : "fulfilled", delivered: done.length, pending: 0 };
  }

  const send = input.sendPhoto ?? defaultSendPhoto;
  let sentNow = 0;
  for (const item of pending) {
    let bytes: Buffer | null = null;
    try {
      bytes = await readFreePhoto(item.storagePath);
    } catch {
      bytes = null;
    }
    if (!item.telegramFileId.trim() && !bytes?.length) {
      logger.warn("paid_content.delivery_failed", { paymentId: payment.id, name: "MissingPhoto" });
      return { status: "incomplete", delivered: done.length + sentNow, pending: pending.length - sentNow };
    }
    let telegramMessageId = "";
    try {
      const sent = await send({
        chatId: conversation.chatId,
        businessConnectionId: conversation.businessConnectionId,
        mediaAssetId: item.mediaAssetId,
        telegramFileId: item.telegramFileId,
        bytes,
      });
      telegramMessageId = sent.telegramMessageId;
    } catch (error) {
      logger.warn("paid_content.delivery_failed", {
        paymentId: payment.id,
        name: error instanceof Error ? error.name : "Error",
      });
      return { status: "incomplete", delivered: done.length + sentNow, pending: pending.length - sentNow };
    }
    if (!telegramMessageId) {
      logger.warn("paid_content.delivery_failed", { paymentId: payment.id, name: "EmptyMessageId" });
      return { status: "incomplete", delivered: done.length + sentNow, pending: pending.length - sentNow };
    }
    try {
      await prisma.paidContentDelivery.create({
        data: {
          userId: payment.userId,
          offerId: payment.offerId,
          paymentId: payment.id,
          paymentOfferMediaId: item.id,
          mediaAssetId: item.mediaAssetId,
          position: item.position,
          telegramMessageId,
        },
      });
      sentNow += 1;
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      sentNow += 1;
    }
  }
  logger.info("paid_content.fulfilled", { paymentId: payment.id, offerId: payment.offerId, delivered: done.length + sentNow, pending: 0 });
  return { status: "fulfilled", delivered: done.length + sentNow, pending: 0 };
}

export async function loadDeliverables(offerId: string): Promise<Array<{
  id: string;
  position: number;
  mediaAssetId: string;
  telegramFileId: string;
  storagePath: string;
  label: string;
}>> {
  const rows = await prisma.paymentOfferMedia.findMany({
    where: {
      offerId,
      role: "DELIVERABLE",
      active: true,
      mediaAsset: { active: true, mediaType: "PHOTO" },
    },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: {
      id: true,
      position: true,
      mediaAssetId: true,
      mediaAsset: { select: { telegramFileId: true, storagePath: true, category: true, id: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    position: row.position,
    mediaAssetId: row.mediaAssetId,
    telegramFileId: row.mediaAsset.telegramFileId,
    storagePath: row.mediaAsset.storagePath,
    label: mediaSentLabel(row.mediaAsset),
  }));
}

async function businessConversation(
  userId: string,
  intentId: string,
): Promise<{ chatId: string; businessConnectionId: string } | null> {
  const intent = await prisma.paymentIntent.findUnique({
    where: { id: intentId },
    select: { conversationId: true },
  });
  if (intent?.conversationId) {
    const linked = await prisma.conversation.findUnique({
      where: { id: intent.conversationId },
      select: { platform: true, platformConversationId: true, businessConnectionId: true, active: true },
    });
    const connection = linked?.businessConnectionId?.trim() ?? "";
    if (linked?.active && linked.platform === "telegram-business" && connection) {
      return { chatId: linked.platformConversationId, businessConnectionId: connection };
    }
  }
  const fallback = await prisma.conversation.findFirst({
    where: {
      userId,
      platform: "telegram-business",
      active: true,
      businessConnectionId: { not: null },
    },
    orderBy: { updatedAt: "desc" },
    select: { platformConversationId: true, businessConnectionId: true },
  });
  const connection = fallback?.businessConnectionId?.trim() ?? "";
  if (!connection) return null;
  return { chatId: fallback?.platformConversationId ?? "", businessConnectionId: connection };
}

async function defaultSendPhoto(input: {
  chatId: string;
  businessConnectionId: string;
  telegramFileId: string;
  bytes: Buffer | null;
}): Promise<{ telegramMessageId: string }> {
  const sent = await telegramBotTransport.sendBusinessPhoto(input.chatId, {
    businessConnectionId: input.businessConnectionId,
    telegramFileId: input.telegramFileId,
    bytes: input.bytes,
  });
  return { telegramMessageId: sent.messageId };
}

export function classifyPaidFulfillmentCommand(
  update: TelegramUpdate,
  ownerTelegramId: string,
): { chatId: string; kind: "inspect" | "retry" | "test"; telegramUserId?: string; paymentId?: string; slug?: string } | null {
  const owner = ownerTelegramId.trim();
  if (!owner) return null;
  const message = update.message;
  if (!message?.from || message.from.is_bot) return null;
  if (message.chat?.type !== "private") return null;
  if (message.business_connection_id) return null;
  if (String(message.from.id) !== owner) return null;
  const parts = (typeof message.text === "string" ? message.text.trim() : "").split(/\s+/);
  const token = parts[0]?.split("@")[0]?.toLowerCase();
  if (token === "/paid_fulfillment" && parts.length === 2 && /^\d+$/.test(parts[1] ?? "")) {
    return { chatId: String(message.chat.id), kind: "inspect", telegramUserId: parts[1] };
  }
  if (token === "/paid_delivery_retry" && parts.length === 2 && /^c[a-z0-9]+$/.test(parts[1] ?? "")) {
    return { chatId: String(message.chat.id), kind: "retry", paymentId: parts[1] };
  }
  if (token === "/paid_delivery_test" && parts.length === 3 && /^\d+$/.test(parts[1] ?? "") && SLUG.test(parts[2] ?? "")) {
    return { chatId: String(message.chat.id), kind: "test", telegramUserId: parts[1], slug: parts[2] };
  }
  return null;
}

export async function processPaidFulfillmentCommand(
  update: TelegramUpdate,
  ownerTelegramId: string,
  deps: { sendOwner?: (chatId: string, text: string) => Promise<void>; sendPhoto?: PaidDeliverySend } = {},
): Promise<void> {
  const command = classifyPaidFulfillmentCommand(update, ownerTelegramId);
  if (!command) return;
  const sendOwner = deps.sendOwner ?? (async (chatId: string, text: string) => {
    await sendTextMessage(chatId, text);
  });
  if (command.kind === "inspect" && command.telegramUserId) {
    await sendOwner(command.chatId, await fulfillmentText(command.telegramUserId));
    return;
  }
  if (command.kind === "test" && command.telegramUserId && command.slug) {
    await sendOwner(command.chatId, await deliveryTestText(command.telegramUserId, command.slug));
    return;
  }
  if (command.kind === "retry" && command.paymentId) {
    const before = await prisma.payment.count({ where: { id: command.paymentId } });
    const result = before === 0
      ? { status: "not_paid" as const, delivered: 0, pending: 0 }
      : await fulfillPaidContent({ paymentId: command.paymentId, sendPhoto: deps.sendPhoto });
    await sendOwner(command.chatId, `Fulfillment ${result.status}\nDelivered: ${result.delivered}\nPending: ${result.pending}`);
  }
}

async function fulfillmentText(telegramUserId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { telegramUserId }, select: { id: true } });
  if (!user) return "No paid fulfillment.";
  const payments = await prisma.payment.findMany({
    where: { userId: user.id, status: "PAID" },
    orderBy: { paidAt: "desc" },
    take: 5,
    select: { id: true, offerId: true, paidAt: true, offer: { select: { slug: true } } },
  });
  if (payments.length === 0) return "No paid fulfillment.";
  const blocks: string[] = [];
  for (const payment of payments) {
    const items = await loadDeliverables(payment.offerId);
    const rows = await prisma.paidContentDelivery.findMany({
      where: { paymentId: payment.id, telegramMessageId: { not: null } },
      select: { paymentOfferMediaId: true },
    });
    const done = new Set(rows.map((row) => row.paymentOfferMediaId));
    const lines = items.map((item, index) => `${index + 1}. ${item.label} ${done.has(item.id) ? "delivered" : "pending"}`);
    blocks.push(
      [
        payment.offer.slug,
        `Payment: paid`,
        `Deliverables: ${items.length}`,
        `Delivered: ${done.size}`,
        `Pending: ${items.length - done.size}`,
        ...lines,
      ].join("\n"),
    );
  }
  return blocks.join("\n\n");
}

async function deliveryTestText(telegramUserId: string, slug: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { telegramUserId }, select: { id: true } });
  const offer = await prisma.paymentOffer.findUnique({ where: { slug }, select: { id: true, slug: true, active: true } });
  if (!user || !offer?.active) return "No active paid offer is available.";
  const conversation = await prisma.conversation.findFirst({
    where: { userId: user.id, platform: "telegram-business", active: true, businessConnectionId: { not: null } },
    select: { id: true },
  });
  const items = await loadDeliverables(offer.id);
  return [
    "Fulfillment test",
    `Offer: ${offer.slug}`,
    conversation ? "Business: connected" : "Business: missing",
    `Deliverables: ${items.length}`,
    ...items.map((item, index) => `${index + 1}. ${item.label}`),
    "No payment was created.",
  ].join("\n");
}
