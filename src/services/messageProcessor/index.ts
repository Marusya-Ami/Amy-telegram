import { prisma } from "@/lib/db/prisma";
import { isUniqueConstraintError } from "@/lib/db/errors";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { enqueueUserWork } from "@/lib/userQueue";
import type { ParsedInbound, TelegramUpdate } from "@/lib/telegram/types";
import { interpretUpdate, parseUpdate } from "@/lib/telegram/parseUpdate";
import { TEXT_BURST_DEBOUNCE_MS, createBurstTimer } from "@/services/messageProcessor/burstScheduler";
import { bumpTurnEpoch } from "@/services/messageProcessor/humanDelay";
import { processImmediateMessage, processTextBurst } from "@/services/messageProcessor/runTurn";
import { classifyCompareCommand, processCompareAdminCommand } from "@/services/amyBrain/compare";
import { isOwnerBotAdminUpdate, processOwnerBotAdminUpdate } from "@/services/media/library";
import { classifyMediaSentCommand, processMediaSentCommand } from "@/services/media/delivery";
import { classifyFreeMediaTestCommand, processFreeMediaTestCommand } from "@/services/media/executeFreeMedia";
import {
  classifyOfferHistoryCommand,
  classifyPaidOfferTestCommand,
  processOfferHistoryCommand,
  processPaidOfferTestCommand,
} from "@/services/payments/paidOffer";
import { classifyOfferMediaCommand, processOfferMediaCommand } from "@/services/payments/offerMedia";
import { classifySalesAdminCommand, processSalesAdminCommand } from "@/services/sales/inspect";
import { classifyTipAdminCommand, processTipAdminCommand } from "@/services/sales/tip";
import { fulfillPaidContent, classifyPaidFulfillmentCommand, processPaidFulfillmentCommand } from "@/services/payments/fulfillPaidContent";
import {
  classifyStarsAdminCommand,
  handlePreCheckoutQuery,
  handlePurchasedPaidMedia,
  handleSuccessfulPayment,
  processStarsAdminCommand,
  purchasedPaidMediaFrom,
  successfulPaymentFrom,
} from "@/services/payments/telegramStars";

const STALE_PROCESSING_MS = 120_000;

const textBursts = createBurstTimer(TEXT_BURST_DEBOUNCE_MS, (userId) => {
  void enqueueUserWork(userId, async () => {
    const remaining = await processTextBurst(userId);
    if (remaining) textBursts.push(userId);
  }).catch((error: unknown) => {
    logger.error("turn.failed", {
      userId,
      name: error instanceof Error ? error.name : "Error",
    });
    textBursts.push(userId);
  });
});

export type IngestHooks = {
  scheduleInbound?: (userId: string, messageId: string, kind: ParsedInbound["kind"]) => void;
};

export async function ingestTelegramUpdate(payload: unknown, hooks?: IngestHooks): Promise<void> {
  const update = parseUpdate(payload);
  if (!update) {
    logger.warn("telegram.inbound_invalid", {});
    return;
  }

  const claim = await claimUpdate(update);
  if (claim === "done" || claim === "in_progress") {
    logger.info("telegram.duplicate", { updateId: String(update.update_id), claim });
    return;
  }

  if (update.pre_checkout_query) {
    try {
      await handlePreCheckoutQuery(update.pre_checkout_query);
      await markUpdate(update.update_id, "DONE");
    } catch (error) {
      await markUpdate(update.update_id, "FAILED");
      logger.error("payments.stars.pre_checkout_failed", {
        updateId: String(update.update_id),
        name: error instanceof Error ? error.name : "Error",
      });
      throw error;
    }
    return;
  }

  const purchasedPaidMedia = purchasedPaidMediaFrom(update);
  if (purchasedPaidMedia) {
    try {
      await handlePurchasedPaidMedia(purchasedPaidMedia);
      await markUpdate(update.update_id, "DONE");
    } catch (error) {
      await markUpdate(update.update_id, "FAILED");
      logger.error("payments.stars.paid_media_failed", {
        updateId: String(update.update_id),
        name: error instanceof Error ? error.name : "Error",
      });
      throw error;
    }
    return;
  }

  const successfulPayment = successfulPaymentFrom(update);
  if (successfulPayment) {
    try {
      const outcome = await handleSuccessfulPayment(successfulPayment);
      if (outcome === "recorded" || outcome === "duplicate") {
        const payment = await prisma.payment.findUnique({
          where: { providerPaymentId: successfulPayment.payment.telegram_payment_charge_id },
          select: { id: true, status: true },
        });
        if (payment?.status === "PAID") {
          const result = await fulfillPaidContent({ paymentId: payment.id });
          if (result.status === "incomplete" || result.status === "missing_business") {
            logger.warn("paid_content.fulfillment_incomplete", { paymentId: payment.id, status: result.status });
            throw new Error("PaidContentFulfillmentIncomplete");
          }
        }
      }
      await markUpdate(update.update_id, "DONE");
    } catch (error) {
      await markUpdate(update.update_id, "FAILED");
      logger.error("payments.stars.success_failed", {
        updateId: String(update.update_id),
        name: error instanceof Error ? error.name : "Error",
      });
      throw error;
    }
    return;
  }

  const ownerTelegramId = getEnv().OWNER_TELEGRAM_ID;
  if (classifyStarsAdminCommand(update, ownerTelegramId)) {
    try {
      await processStarsAdminCommand(update, ownerTelegramId);
      await markUpdate(update.update_id, "DONE");
    } catch (error) {
      await markUpdate(update.update_id, "FAILED");
      logger.error("payments.stars.admin_failed", {
        updateId: String(update.update_id),
        name: error instanceof Error ? error.name : "Error",
      });
      throw error;
    }
    return;
  }

  if (classifyCompareCommand(update, ownerTelegramId)) {
    try {
      await processCompareAdminCommand(update, ownerTelegramId);
      await markUpdate(update.update_id, "DONE");
    } catch (error) {
      await markUpdate(update.update_id, "FAILED");
      logger.error("reply.compare_failed", {
        updateId: String(update.update_id),
        name: error instanceof Error ? error.name : "Error",
      });
      throw error;
    }
    return;
  }

  if (classifyTipAdminCommand(update, ownerTelegramId)) {
    try {
      await processTipAdminCommand(update, ownerTelegramId);
      await markUpdate(update.update_id, "DONE");
    } catch (error) {
      await markUpdate(update.update_id, "FAILED");
      logger.error("tip.admin_failed", {
        updateId: String(update.update_id),
        name: error instanceof Error ? error.name : "Error",
      });
      throw error;
    }
    return;
  }

  if (classifyPaidFulfillmentCommand(update, ownerTelegramId)) {
    try {
      await processPaidFulfillmentCommand(update, ownerTelegramId);
      await markUpdate(update.update_id, "DONE");
    } catch (error) {
      await markUpdate(update.update_id, "FAILED");
      logger.error("paid_content.command_failed", {
        updateId: String(update.update_id),
        name: error instanceof Error ? error.name : "Error",
      });
      throw error;
    }
    return;
  }

  if (classifyOfferMediaCommand(update, ownerTelegramId)) {
    try {
      await processOfferMediaCommand(update, ownerTelegramId);
      await markUpdate(update.update_id, "DONE");
    } catch (error) {
      await markUpdate(update.update_id, "FAILED");
      logger.error("offer_media.command_failed", {
        updateId: String(update.update_id),
        name: error instanceof Error ? error.name : "Error",
      });
      throw error;
    }
    return;
  }

  if (classifyPaidOfferTestCommand(update, ownerTelegramId)) {
    try {
      await processPaidOfferTestCommand(update, ownerTelegramId);
      await markUpdate(update.update_id, "DONE");
    } catch (error) {
      await markUpdate(update.update_id, "FAILED");
      logger.error("paid_offer.test_failed", {
        updateId: String(update.update_id),
        name: error instanceof Error ? error.name : "Error",
      });
      throw error;
    }
    return;
  }

  if (classifyOfferHistoryCommand(update, ownerTelegramId)) {
    try {
      await processOfferHistoryCommand(update, ownerTelegramId);
      await markUpdate(update.update_id, "DONE");
    } catch (error) {
      await markUpdate(update.update_id, "FAILED");
      logger.error("paid_offer.history_failed", {
        updateId: String(update.update_id),
        name: error instanceof Error ? error.name : "Error",
      });
      throw error;
    }
    return;
  }

  if (classifyFreeMediaTestCommand(update, ownerTelegramId)) {
    try {
      await processFreeMediaTestCommand(update, ownerTelegramId);
      await markUpdate(update.update_id, "DONE");
    } catch (error) {
      await markUpdate(update.update_id, "FAILED");
      logger.error("free_media.test_failed", {
        updateId: String(update.update_id),
        name: error instanceof Error ? error.name : "Error",
      });
      throw error;
    }
    return;
  }

  if (classifyMediaSentCommand(update, ownerTelegramId)) {
    try {
      await processMediaSentCommand(update, ownerTelegramId);
      await markUpdate(update.update_id, "DONE");
    } catch (error) {
      await markUpdate(update.update_id, "FAILED");
      logger.error("media.sent_inspect_failed", {
        updateId: String(update.update_id),
        name: error instanceof Error ? error.name : "Error",
      });
      throw error;
    }
    return;
  }

  if (classifySalesAdminCommand(update, ownerTelegramId)) {
    try {
      await processSalesAdminCommand(update, ownerTelegramId);
      await markUpdate(update.update_id, "DONE");
    } catch (error) {
      await markUpdate(update.update_id, "FAILED");
      logger.error("sales.admin_failed", {
        updateId: String(update.update_id),
        name: error instanceof Error ? error.name : "Error",
      });
      throw error;
    }
    return;
  }

  if (isOwnerBotAdminUpdate(update, ownerTelegramId)) {
    try {
      await processOwnerBotAdminUpdate(update);
      await markUpdate(update.update_id, "DONE");
    } catch (error) {
      await markUpdate(update.update_id, "FAILED");
      logger.error("media.admin_failed", {
        updateId: String(update.update_id),
        name: error instanceof Error ? error.name : "Error",
      });
      throw error;
    }
    return;
  }

  const interpreted = interpretUpdate(update);
  if (interpreted.action === "business_connection") {
    await prisma.businessConnection.upsert({
      where: { connectionId: interpreted.connectionId },
      create: {
        connectionId: interpreted.connectionId,
        businessUserId: interpreted.businessUserId,
        userChatId: interpreted.userChatId,
        isEnabled: interpreted.isEnabled,
        canReply: interpreted.canReply,
      },
      update: {
        businessUserId: interpreted.businessUserId,
        userChatId: interpreted.userChatId,
        isEnabled: interpreted.isEnabled,
        canReply: interpreted.canReply,
      },
    });
    await markUpdate(update.update_id, "DONE");
    logger.info("telegram.business_connection", {
      updateId: String(update.update_id),
      connectionId: interpreted.connectionId,
      businessUserId: interpreted.businessUserId,
      isEnabled: interpreted.isEnabled,
      canReply: interpreted.canReply,
    });
    return;
  }

  if (interpreted.action === "edited_business_message") {
    await markUpdate(update.update_id, "DONE");
    logger.info("telegram.business_message_edited", {
      updateId: interpreted.updateId,
      chatId: interpreted.chatId,
      telegramMessageId: interpreted.messageId,
    });
    return;
  }

  if (interpreted.action === "deleted_business_messages") {
    await markUpdate(update.update_id, "DONE");
    logger.info("telegram.business_messages_deleted", {
      updateId: interpreted.updateId,
      chatId: interpreted.chatId,
      messageCount: interpreted.messageCount,
    });
    return;
  }

  if (interpreted.action === "ignore") {
    await markUpdate(update.update_id, "DONE");
    logger.info("telegram.inbound_ignored", {
      updateId: String(update.update_id),
      reason: interpreted.reason,
    });
    return;
  }

  const inbound = interpreted.inbound;

  try {
    const stored = await storeInbound(inbound);
    await prisma.telegramUpdate.update({
      where: { updateId: inbound.updateId },
      data: { inboundMessageId: stored.messageId },
    });

    logger.info("telegram.inbound", {
      updateId: inbound.updateId,
      userId: stored.userId,
      chatId: inbound.chatId,
      kind: inbound.kind,
      telegramMessageId: inbound.telegramMessageId,
    });

    const schedule = hooks?.scheduleInbound ?? scheduleInbound;
    schedule(stored.userId, stored.messageId, inbound.kind);
    await markUpdate(update.update_id, "DONE");
  } catch (error) {
    await markUpdate(update.update_id, "FAILED");
    throw error;
  }
}

function scheduleInbound(userId: string, messageId: string, kind: ParsedInbound["kind"]): void {
  if (kind === "text" || kind === "photo" || kind === "video") {
    bumpTurnEpoch(userId);
    textBursts.push(userId);
    logger.info("turn.scheduled", { userId, debounceMs: TEXT_BURST_DEBOUNCE_MS, kind });
    return;
  }

  void enqueueUserWork(userId, () => processImmediateMessage(userId, messageId)).catch((error: unknown) => {
    logger.error("turn.failed", {
      userId,
      name: error instanceof Error ? error.name : "Error",
    });
    setTimeout(() => scheduleInbound(userId, messageId, "start"), 1000);
  });
}

async function storeInbound(inbound: ParsedInbound): Promise<{ userId: string; messageId: string }> {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.upsert({
      where: { telegramUserId: inbound.telegramUserId },
      create: {
        telegramUserId: inbound.telegramUserId,
        username: inbound.username,
        firstName: inbound.firstName,
        lastName: inbound.lastName,
        languageCode: inbound.languageCode,
      },
      update: {
        username: inbound.username,
        firstName: inbound.firstName,
        lastName: inbound.lastName,
        languageCode: inbound.languageCode,
      },
    });

    const platform = inbound.businessConnectionId ? "telegram-business" : "telegram";
    const conversation = await tx.conversation.upsert({
      where: {
        platform_platformConversationId: {
          platform,
          platformConversationId: inbound.chatId,
        },
      },
      create: {
        userId: user.id,
        platform,
        platformConversationId: inbound.chatId,
        businessConnectionId: inbound.businessConnectionId,
        active: true,
      },
      update: {
        active: true,
        ...(inbound.businessConnectionId ? { businessConnectionId: inbound.businessConnectionId } : {}),
      },
    });

    try {
      const message = await tx.message.create({
        data: {
          conversationId: conversation.id,
          userId: user.id,
          direction: "INBOUND",
          sender: "USER",
          type: inbound.type,
          text: inbound.text,
          telegramMessageId: inbound.telegramMessageId,
          replyToMessageId: inbound.replyToMessageId,
          metadata: {
            updateId: inbound.updateId,
            chatType: inbound.chatType,
            kind: inbound.kind,
            processed: false,
            ...(inbound.photoFileId ? { photoFileId: inbound.photoFileId } : {}),
            ...(inbound.visualForm ? { visualForm: inbound.visualForm } : {}),
            ...(inbound.businessConnectionId ? { businessConnectionId: inbound.businessConnectionId } : {}),
          },
        },
      });

      await tx.user.update({
        where: { id: user.id },
        data: {
          messagesCount: { increment: 1 },
          lastUserMessageAt: new Date(),
        },
      });

      return { userId: user.id, messageId: message.id };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const existing = await tx.message.findUniqueOrThrow({
        where: {
          conversationId_telegramMessageId: {
            conversationId: conversation.id,
            telegramMessageId: inbound.telegramMessageId,
          },
        },
      });
      return { userId: user.id, messageId: existing.id };
    }
  });
}

async function claimUpdate(update: TelegramUpdate): Promise<"claimed" | "done" | "in_progress"> {
  const updateId = String(update.update_id);
  try {
    await prisma.telegramUpdate.create({
      data: { updateId, status: "PROCESSING" },
    });
    return "claimed";
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
  }

  const existing = await prisma.telegramUpdate.findUnique({ where: { updateId } });
  if (!existing || existing.status === "DONE") return existing ? "done" : "in_progress";

  if (existing.status === "FAILED") {
    const reclaimed = await prisma.telegramUpdate.updateMany({
      where: { updateId, status: "FAILED" },
      data: { status: "PROCESSING", updatedAt: new Date() },
    });
    return reclaimed.count === 1 ? "claimed" : "in_progress";
  }

  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
  if (existing.updatedAt <= staleBefore) {
    const reclaimed = await prisma.telegramUpdate.updateMany({
      where: { updateId, status: "PROCESSING", updatedAt: existing.updatedAt },
      data: { status: "PROCESSING", updatedAt: new Date() },
    });
    return reclaimed.count === 1 ? "claimed" : "in_progress";
  }

  return "in_progress";
}

async function markUpdate(updateId: number | string, status: "DONE" | "FAILED"): Promise<void> {
  await prisma.telegramUpdate.update({
    where: { updateId: String(updateId) },
    data: { status },
  });
}
