import { prisma } from "@/lib/db/prisma";
import { isUniqueConstraintError } from "@/lib/db/errors";
import { logger } from "@/lib/logger";
import { enqueueUserWork } from "@/lib/userQueue";
import type { ParsedInbound, TelegramUpdate } from "@/lib/telegram/types";
import { parsePrivateInbound, parseUpdate } from "@/lib/telegram/parseUpdate";
import { TEXT_BURST_DEBOUNCE_MS, createBurstTimer } from "@/services/messageProcessor/burstScheduler";
import { processImmediateMessage, processTextBurst } from "@/services/messageProcessor/runTurn";

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

export async function ingestTelegramUpdate(payload: unknown): Promise<void> {
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

  const inbound = parsePrivateInbound(update);
  if (!inbound) {
    await markUpdate(update.update_id, "DONE");
    logger.info("telegram.inbound_ignored", {
      updateId: String(update.update_id),
      reason: update.message ? "not_private_user_message" : "no_message",
    });
    return;
  }

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

    scheduleInbound(stored.userId, stored.messageId, inbound.kind);
    await markUpdate(update.update_id, "DONE");
  } catch (error) {
    await markUpdate(update.update_id, "FAILED");
    throw error;
  }
}

function scheduleInbound(userId: string, messageId: string, kind: ParsedInbound["kind"]): void {
  if (kind === "text") {
    textBursts.push(userId);
    logger.info("turn.scheduled", { userId, debounceMs: TEXT_BURST_DEBOUNCE_MS });
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

    const conversation = await tx.conversation.upsert({
      where: {
        platform_platformConversationId: {
          platform: "telegram",
          platformConversationId: inbound.chatId,
        },
      },
      create: {
        userId: user.id,
        platform: "telegram",
        platformConversationId: inbound.chatId,
        active: true,
      },
      update: { active: true },
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
