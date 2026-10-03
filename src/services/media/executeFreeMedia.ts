import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db/prisma";
import { isUniqueConstraintError } from "@/lib/db/errors";
import { logger } from "@/lib/logger";
import type { TelegramUpdate } from "@/lib/telegram/types";
import { sendTextMessage } from "@/lib/telegram/client";
import { deliverMediaThenRecord, mediaSentLabel } from "@/services/media/delivery";
import { freeSelectableAssetWhere, isFreePhotoEligible } from "@/services/media/eligibility";
import { readFreePhoto } from "@/services/media/library";
import { salesConfig } from "@/services/sales/config";
import { selectFreeMedia } from "@/services/sales/decide";
import { readSalesSignal } from "@/services/sales/signals";
import { telegramBotTransport } from "@/services/transport/telegramBotTransport";

const STALE_CLAIM_MS = 2 * 60 * 1000;

export type FreeMediaOutcome =
  | "shadow"
  | "sent"
  | "cooldown"
  | "suppressed"
  | "send_failed"
  | "duplicate"
  | "no_asset"
  | "invalid_business_connection";

export type FreePhotoSend = (input: {
  chatId: string;
  businessConnectionId: string;
  mediaAssetId: string;
  telegramFileId: string;
  bytes: Buffer | null;
}) => Promise<{ telegramMessageId: string }>;

export function freeMediaMode(raw = process.env["FREE_MEDIA_MODE"]): "shadow" | "live" {
  return raw?.trim().toLowerCase() === "live" ? "live" : "shadow";
}

export async function executeFreeMedia(input: {
  mode?: "shadow" | "live";
  userId: string;
  conversationId: string;
  triggerMessageId: string | null;
  mediaAssetId: string | null;
  explicitMediaRequest: boolean;
  emotionalState: string;
  declinedNow: boolean;
  now?: Date;
  sendPhoto?: FreePhotoSend;
}): Promise<FreeMediaOutcome> {
  const mode = input.mode ?? freeMediaMode();
  const now = input.now ?? new Date();
  if (mode !== "live") {
    logOutcome(input, "shadow");
    return "shadow";
  }
  if (!input.triggerMessageId) {
    logOutcome(input, "suppressed");
    return "suppressed";
  }

  const claim = await claimExecution({
    triggerKey: input.triggerMessageId,
    userId: input.userId,
    conversationId: input.conversationId,
    mediaAssetId: input.mediaAssetId,
    now,
  });
  if (claim.kind === "duplicate") {
    logOutcome(input, "duplicate");
    return "duplicate";
  }

  try {
    if (claim.telegramMessageId && input.mediaAssetId) {
      await deliverMediaThenRecord({
        userId: input.userId,
        conversationId: input.conversationId,
        mediaAssetId: input.mediaAssetId,
        source: "FREE_MEDIA",
        telegramMessageId: claim.telegramMessageId,
        sentAt: now,
        send: async () => ({ telegramMessageId: claim.telegramMessageId }),
      });
      await finishClaim(claim.id, "SENT", input.mediaAssetId, claim.telegramMessageId);
      logOutcome(input, "sent");
      return "sent";
    }

    const outcome = await guardAndSend(input, now, claim.id);
    return outcome;
  } catch (error) {
    await finishClaim(claim.id, "FAILED", input.mediaAssetId, null);
    logger.error("free_media.send_failed", {
      userId: input.userId,
      conversationId: input.conversationId,
      triggerMessageId: input.triggerMessageId,
      mediaAssetId: input.mediaAssetId,
      name: error instanceof Error ? error.name : "Error",
    });
    logOutcome(input, "send_failed");
    return "send_failed";
  }
}

async function guardAndSend(
  input: {
    userId: string;
    conversationId: string;
    triggerMessageId: string | null;
    mediaAssetId: string | null;
    explicitMediaRequest: boolean;
    emotionalState: string;
    declinedNow: boolean;
    sendPhoto?: FreePhotoSend;
  },
  now: Date,
  claimId: string,
): Promise<FreeMediaOutcome> {
  if (input.emotionalState === "DISTRESSED" || input.declinedNow) {
    await finishClaim(claimId, "SKIPPED", input.mediaAssetId, null);
    logOutcome(input, "suppressed");
    return "suppressed";
  }

  const [user, conversation] = await Promise.all([
    prisma.user.findUnique({ where: { id: input.userId }, select: { aiEnabled: true } }),
    prisma.conversation.findUnique({
      where: { id: input.conversationId },
      select: { platform: true, platformConversationId: true, businessConnectionId: true, active: true },
    }),
  ]);
  if (!user?.aiEnabled || !conversation?.active) {
    await finishClaim(claimId, "SKIPPED", input.mediaAssetId, null);
    logOutcome(input, "suppressed");
    return "suppressed";
  }
  const businessConnectionId = conversation.businessConnectionId?.trim() ?? "";
  if (conversation.platform !== "telegram-business" || !businessConnectionId) {
    await finishClaim(claimId, "SKIPPED", input.mediaAssetId, null);
    logOutcome(input, "invalid_business_connection");
    return "invalid_business_connection";
  }

  const latest = await prisma.mediaSent.findFirst({
    where: { userId: input.userId },
    orderBy: { sentAt: "desc" },
    select: { sentAt: true },
  });
  if (latest && now.getTime() - latest.sentAt.getTime() < salesConfig.freeMediaMinIntervalMs) {
    await finishClaim(claimId, "SKIPPED", input.mediaAssetId, null);
    logOutcome(input, "cooldown");
    return "cooldown";
  }

  if (!input.mediaAssetId) {
    await finishClaim(claimId, "SKIPPED", null, null);
    logOutcome(input, "no_asset");
    return "no_asset";
  }

  const alreadySent = await prisma.mediaSent.findFirst({
    where: { userId: input.userId, mediaAssetId: input.mediaAssetId },
    select: { id: true },
  });
  if (alreadySent) {
    await finishClaim(claimId, "SKIPPED", input.mediaAssetId, null);
    logOutcome(input, "suppressed");
    return "suppressed";
  }
  const asset = await prisma.mediaAsset.findUnique({
    where: { id: input.mediaAssetId },
    select: { id: true, active: true, availability: true, mediaType: true, telegramFileId: true, storagePath: true },
  });
  const deliverable = asset
    ? await prisma.paymentOfferMedia.findFirst({
        where: { mediaAssetId: asset.id, role: "DELIVERABLE", active: true },
        select: { id: true },
      })
    : null;
  if (!asset || asset.mediaType !== "PHOTO" || !isFreePhotoEligible({
    active: asset.active,
    availability: asset.availability,
    deliverable: Boolean(deliverable),
  })) {
    await finishClaim(claimId, "SKIPPED", input.mediaAssetId, null);
    logOutcome(input, "no_asset");
    return "no_asset";
  }

  let bytes: Buffer | null = null;
  try {
    bytes = await readFreePhoto(asset.storagePath);
  } catch {
    bytes = null;
  }
  if (!asset.telegramFileId.trim() && !bytes?.length) {
    await finishClaim(claimId, "SKIPPED", asset.id, null);
    logOutcome(input, "no_asset");
    return "no_asset";
  }

  const send = input.sendPhoto ?? defaultSendPhoto;
  const delivered = await deliverMediaThenRecord({
    userId: input.userId,
    conversationId: input.conversationId,
    mediaAssetId: asset.id,
    source: "FREE_MEDIA",
    sentAt: now,
    send: async () => {
      const sent = await send({
        chatId: conversation.platformConversationId,
        businessConnectionId,
        mediaAssetId: asset.id,
        telegramFileId: asset.telegramFileId,
        bytes,
      });
      await prisma.freeMediaExecution.update({
        where: { id: claimId },
        data: { telegramMessageId: sent.telegramMessageId, mediaAssetId: asset.id },
      });
      return { telegramMessageId: sent.telegramMessageId };
    },
  });
  await finishClaim(claimId, "SENT", asset.id, delivered.telegramMessageId);
  logOutcome({ ...input, mediaAssetId: asset.id }, "sent");
  return "sent";
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

async function claimExecution(input: {
  triggerKey: string;
  userId: string;
  conversationId: string;
  mediaAssetId: string | null;
  now: Date;
}): Promise<{ kind: "go"; id: string; telegramMessageId: string | null } | { kind: "duplicate" }> {
  try {
    const created = await prisma.freeMediaExecution.create({
      data: {
        triggerKey: input.triggerKey,
        userId: input.userId,
        conversationId: input.conversationId,
        mediaAssetId: input.mediaAssetId,
        status: "CLAIMED",
      },
    });
    return { kind: "go", id: created.id, telegramMessageId: null };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
  }

  const existing = await prisma.freeMediaExecution.findUnique({ where: { triggerKey: input.triggerKey } });
  if (!existing || existing.status === "SENT" || existing.status === "SKIPPED") return { kind: "duplicate" };
  const freshClaim = existing.status === "CLAIMED" && input.now.getTime() - existing.updatedAt.getTime() < STALE_CLAIM_MS;
  if (freshClaim) return { kind: "duplicate" };
  const taken = await prisma.freeMediaExecution.updateMany({
    where: { id: existing.id, status: existing.status, updatedAt: existing.updatedAt },
    data: { status: "CLAIMED", updatedAt: input.now },
  });
  if (taken.count !== 1) return { kind: "duplicate" };
  return { kind: "go", id: existing.id, telegramMessageId: existing.telegramMessageId };
}

async function finishClaim(
  id: string,
  status: "SENT" | "FAILED" | "SKIPPED",
  mediaAssetId: string | null,
  telegramMessageId: string | null,
): Promise<void> {
  await prisma.freeMediaExecution.update({
    where: { id },
    data: {
      status,
      ...(mediaAssetId ? { mediaAssetId } : {}),
      ...(telegramMessageId ? { telegramMessageId } : {}),
    },
  });
}

function logOutcome(
  input: { userId: string; conversationId: string; triggerMessageId: string | null; mediaAssetId: string | null },
  outcome: FreeMediaOutcome,
): void {
  logger.info("free_media.execution", {
    userId: input.userId,
    conversationId: input.conversationId,
    triggerMessageId: input.triggerMessageId,
    mediaAssetId: input.mediaAssetId,
    outcome,
  });
}

export function classifyFreeMediaTestCommand(
  update: TelegramUpdate,
  ownerTelegramId: string,
): { chatId: string; telegramUserId: string } | null {
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
  if (token !== "/free_media_test" || parts.length !== 2 || !/^\d+$/.test(parts[1] ?? "")) return null;
  return { chatId: String(message.chat.id), telegramUserId: parts[1] ?? "" };
}

export async function processFreeMediaTestCommand(
  update: TelegramUpdate,
  ownerTelegramId: string,
  deps: {
    sendOwner?: (chatId: string, text: string) => Promise<void>;
    sendPhoto?: FreePhotoSend;
    now?: Date;
  } = {},
): Promise<void> {
  const command = classifyFreeMediaTestCommand(update, ownerTelegramId);
  if (!command) return;
  const sendOwner = deps.sendOwner ?? (async (chatId: string, text: string) => {
    await sendTextMessage(chatId, text);
  });
  await sendOwner(command.chatId, await ownerFreeMediaTest(command.telegramUserId, deps));
}

async function ownerFreeMediaTest(
  telegramUserId: string,
  deps: { sendPhoto?: FreePhotoSend; now?: Date },
): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { telegramUserId },
    select: { id: true, aiEnabled: true, interactionDynamic: true, interactionDynamicConfidence: true },
  });
  const conversation = user
    ? await prisma.conversation.findFirst({
        where: {
          userId: user.id,
          platform: "telegram-business",
          active: true,
          businessConnectionId: { not: null },
        },
        orderBy: { updatedAt: "desc" },
      })
    : null;
  if (!user || !conversation) return "No Amy Business conversation is available.";

  const [assets, deliveries] = await Promise.all([
    prisma.mediaAsset.findMany({
      where: freeSelectableAssetWhere({ mediaType: "PHOTO" }),
      select: { id: true, category: true, tags: true, mood: true, flirtLevel: true, contexts: true, active: true },
    }),
    prisma.mediaSent.findMany({
      where: { userId: user.id },
      select: { mediaAssetId: true, sentAt: true },
    }),
  ]);
  const selected = selectFreeMedia(
    readSalesSignal(["send me a pic"]),
    assets.map((asset) => ({
      id: asset.id,
      category: asset.category,
      tags: asset.tags,
      mood: asset.mood,
      flirtLevel: asset.flirtLevel,
      contexts: asset.contexts,
      active: asset.active,
    })),
    user.interactionDynamic,
    user.interactionDynamicConfidence,
    deliveries,
  );
  if (!selected) return "No active free photo is available.";

  const outcome = await executeFreeMedia({
    mode: "live",
    userId: user.id,
    conversationId: conversation.id,
    triggerMessageId: `owner-test:${randomUUID()}`,
    mediaAssetId: selected.id,
    explicitMediaRequest: false,
    emotionalState: "NORMAL",
    declinedNow: false,
    now: deps.now,
    sendPhoto: deps.sendPhoto,
  });
  if (outcome === "sent") return `Sent.\n${mediaSentLabel(selected)}`;
  return `Not sent.\n${outcome}`;
}
