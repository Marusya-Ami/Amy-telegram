import { randomUUID } from "crypto";
import type { Message, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import { sleep } from "@/lib/retry";
import { generateReply } from "@/services/amyBrain";
import { interMessageDelayMs } from "@/services/messageProcessor/burstScheduler";
import { describeCustomerPhoto, formatCustomerPhotoContext, visualTurnNote } from "@/services/conversation/customerVision";
import { turnEpoch, waitForHumanReply } from "@/services/messageProcessor/humanDelay";
import { downloadTelegramFile } from "@/services/media/telegramFile";
import { telegramBotTransport } from "@/services/transport/telegramBotTransport";
import { recordContinuity } from "@/services/continuity/record";
import { selectRelevantMemories } from "@/services/memory/store";
import { TransportDeliveryError } from "@/services/transport/messagingTransport";
import { observeSalesTurn, replyCommercialHint } from "@/services/sales/observe";
import { readSalesSignal } from "@/services/sales/signals";
import { stripInventedLinks } from "@/services/sales/tip";
import { confirmDelete, disableProactive, enableProactive, requestDelete, wipeUser } from "@/services/users/commands";

const MAX_DELIVERY_ATTEMPTS = 3;

const UNSUPPORTED_REPLY = "i can only text right now";
const RATE_LIMIT_REPLY = "slow down a sec lol";
const AI_DISABLED_REPLY = "i can't answer right now";

export type TurnDeps = {
  generate: typeof generateReply;
  send: (
    chatId: string,
    text: string,
    context?: { businessConnectionId?: string | null },
  ) => Promise<{ messageId: string }>;
  sleep: (ms: number) => Promise<void>;
  delayMs: () => number;
  recordContinuity?: (input: {
    userId: string;
    sourceMessageId: string | null;
    userTexts: string[];
    amyTexts: string[];
  }) => Promise<void>;
  observeSales?: (input: {
    userId: string;
    conversationId: string;
    triggerMessageId: string | null;
    userTexts: string[];
    amyTexts: string[];
    replyMessageId: string | null;
  }) => Promise<void>;
  understandCustomerPhotos?: (
    photos: Array<{ fileId: string; caption: string | null }>,
  ) => Promise<string | null>;
  waitBeforeReply?: (input: {
    userId: string;
    replyChars: number;
    epochAtStart: number;
    chatId: string;
    businessConnectionId: string | null;
  }) => Promise<"send" | "stale">;
};

const defaultDeps: TurnDeps = {
  generate: generateReply,
  send: (chatId, text, context) => telegramBotTransport.sendText(chatId, text, context),
  sleep,
  delayMs: interMessageDelayMs,
  recordContinuity,
  observeSales: observeSalesTurn,
};

export async function processTextBurst(userId: string, deps: TurnDeps = defaultDeps): Promise<boolean> {
  const pending = await loadPending(userId, { kind: "text" });
  if (pending.length === 0) return false;

  const plannedGroup = pending.filter((message) => plannedMessages(message).length > 0);
  const anchor = turnIdOf(plannedGroup[0]);
  const group =
    plannedGroup.length > 0
      ? pending.filter((message) => turnIdOf(message) === anchor && plannedMessages(message).length > 0)
      : pending;

  try {
    const delivered = await deliverGroup(userId, group, deps);
    if (delivered.status === "stale") return pending.length > group.length;
    const texts = delivered.texts;
    await deps.recordContinuity?.({
      userId,
      sourceMessageId: group[group.length - 1]?.id ?? null,
      userTexts: group.map((message) => message.text?.trim() ?? "").filter(Boolean),
      amyTexts: texts,
    })?.catch((error: unknown) => {
      logger.error("extraction.failure", {
        userId,
        name: error instanceof Error ? error.name : "ExtractionError",
      });
    });
  } catch (error) {
    const attempts = await noteDeliveryFailure(group);
    logger.error("turn.failed", {
      userId,
      attempts,
      name: error instanceof Error ? error.name : "Error",
    });
    if (attempts >= MAX_DELIVERY_ATTEMPTS || (error instanceof TransportDeliveryError && !error.retryable)) {
      await markProcessed(group);
      return pending.length > group.length;
    }
    throw error;
  }

  return pending.length > group.length;
}

export async function processImmediateMessage(
  userId: string,
  messageId: string,
  deps: TurnDeps = defaultDeps,
): Promise<void> {
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  const kind = message ? meta(message.metadata).kind : null;
  if (message && (kind === "start" || kind === "stop" || kind === "delete" || kind === "delete_confirm")) {
    await handleControlMessage(userId, message, deps);
    return;
  }
  await processGroup(userId, deps, { kind: "immediate", messageId });
}

async function processGroup(
  userId: string,
  deps: TurnDeps,
  selector: { kind: "text" } | { kind: "immediate"; messageId: string },
): Promise<void> {
  const pending = await loadPending(userId, selector);
  if (pending.length === 0) return;

  const plannedGroup = pending.filter((message) => plannedMessages(message).length > 0);
  const group =
    plannedGroup.length > 0
      ? pending.filter((message) => turnIdOf(message) === turnIdOf(plannedGroup[0]) && plannedMessages(message).length > 0)
      : pending;

  try {
    await deliverGroup(userId, group, deps);
  } catch (error) {
    const attempts = await noteDeliveryFailure(group);
    logger.error("turn.failed", {
      userId,
      attempts,
      name: error instanceof Error ? error.name : "Error",
    });
    if (attempts >= MAX_DELIVERY_ATTEMPTS || (error instanceof TransportDeliveryError && !error.retryable)) {
      await markProcessed(group);
      return;
    }
    throw error;
  }
}

async function handleControlMessage(userId: string, message: Message, deps: TurnDeps): Promise<void> {
  const kind = meta(message.metadata).kind;
  let texts: string[] = [];
  let wipe = false;
  if (kind === "start") {
    await enableProactive(userId);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    texts = [startReply(user?.firstName ?? null)];
  } else if (kind === "stop") {
    texts = await disableProactive(userId);
  } else if (kind === "delete") {
    texts = await requestDelete(userId);
  } else if (kind === "delete_confirm") {
    const result = await confirmDelete(userId);
    texts = result.texts;
    wipe = result.wipe;
  }
  await savePlan([message], randomUUID(), texts);
  await deliverGroup(userId, [message], deps);
  if (wipe) await wipeUser(userId);
}

async function deliverGroup(
  userId: string,
  group: Message[],
  deps: TurnDeps,
): Promise<{ status: "sent"; texts: string[] } | { status: "stale" }> {
  const epochAtStart = turnEpoch(userId);
  let turnId = turnIdOf(group[0]);
  let texts = plannedMessages(group[0]);

  if (texts.length === 0) {
    turnId = randomUUID();
    texts = await composeTexts(userId, group, deps);
    const userLines = group.map((message) => message.text?.trim() ?? "").filter(Boolean);
    if (readSalesSignal(userLines).intent === "TIP_DISCUSSION") texts = stripInventedLinks(texts);
    await savePlan(group, turnId, texts);
  }

  const conversation = await prisma.conversation.findUniqueOrThrow({
    where: { id: group[0].conversationId },
    select: { platformConversationId: true, businessConnectionId: true },
  });
  const alreadySent = await prisma.message.findMany({
    where: {
      userId,
      direction: "OUTBOUND",
      metadata: { path: ["turnId"], equals: turnId },
    },
    select: { metadata: true, telegramMessageId: true },
  });
  const sentParts = new Set(alreadySent.map((message) => partNumber(message.metadata)));
  const sentIds = new Map<number, string>();
  for (const message of alreadySent) {
    if (message.telegramMessageId) sentIds.set(partNumber(message.metadata), message.telegramMessageId);
  }
  const respondingToIds = group.map((message) => message.id);
  const replyToMessageId = group[group.length - 1]?.telegramMessageId ?? null;
  const firstUnsent = texts.findIndex((_, index) => !sentParts.has(index + 1));
  const conversational = group.some((message) => {
    const kind = meta(message.metadata).kind;
    return kind === "text" || kind === "photo" || kind === "video";
  });
  if (conversational && firstUnsent === 0) {
    const decision = await (deps.waitBeforeReply ?? defaultWaitBeforeReply)({
      userId,
      replyChars: texts.join("").length,
      epochAtStart,
      chatId: conversation.platformConversationId,
      businessConnectionId: conversation.businessConnectionId,
    });
    if (decision === "stale") {
      await clearPlan(group);
      logger.info("turn.stale", { userId, inboundCount: group.length });
      return { status: "stale" };
    }
  }

  for (let index = 0; index < texts.length; index += 1) {
    const part = index + 1;
    if (sentParts.has(part)) continue;
    if (index > 0) await deps.sleep(deps.delayMs());

    const sent = await deps.send(
      conversation.platformConversationId,
      texts[index],
      conversation.businessConnectionId ? { businessConnectionId: conversation.businessConnectionId } : undefined,
    );
    sentIds.set(part, sent.messageId);
    await prisma.message.create({
      data: {
        conversationId: group[0].conversationId,
        userId,
        direction: "OUTBOUND",
        sender: "AMY",
        type: "TEXT",
        text: texts[index],
        telegramMessageId: sent.messageId,
        replyToMessageId: part === 1 ? replyToMessageId : null,
        metadata: {
          turnId,
          respondingToIds,
          part,
          parts: texts.length,
          kind: "reply",
        },
      },
    });
    sentParts.add(part);
  }

  await prisma.user.update({
    where: { id: userId },
    data: { lastAmyMessageAt: new Date() },
  });
  await markProcessed(group);
  logger.info("turn.completed", {
    userId,
    inboundCount: group.length,
    outboundCount: texts.length,
  });
  if (conversational) {
    await noteSalesObservation(userId, group, texts, sentIds.get(texts.length) ?? null, deps);
  }
  return { status: "sent", texts };
}

async function defaultWaitBeforeReply(input: {
  userId: string;
  replyChars: number;
  epochAtStart: number;
  chatId: string;
  businessConnectionId: string | null;
}): Promise<"send" | "stale"> {
  return waitForHumanReply({
    ...input,
    typing: () => telegramBotTransport.sendTyping(input.chatId, { businessConnectionId: input.businessConnectionId }),
  });
}

async function clearPlan(group: Message[]): Promise<void> {
  for (const message of group) {
    const data: Record<string, Prisma.JsonValue> = { ...meta(message.metadata), processed: false };
    delete data.turnId;
    delete data.plannedMessages;
    await prisma.message.update({
      where: { id: message.id },
      data: { metadata: data },
    });
  }
}

async function noteSalesObservation(
  userId: string,
  group: Message[],
  texts: string[],
  replyMessageId: string | null,
  deps: TurnDeps,
): Promise<void> {
  const observation = deps.observeSales?.({
    userId,
    conversationId: group[0].conversationId,
    triggerMessageId: group[group.length - 1]?.id ?? null,
    userTexts: group.map((message) => message.text?.trim() ?? "").filter(Boolean),
    amyTexts: texts,
    replyMessageId,
  });
  if (!observation) return;
  try {
    await observation;
  } catch (error: unknown) {
    logger.error("sales.observe_failed", {
      userId,
      name: error instanceof Error ? error.name : "Error",
    });
  }
}

async function composeTexts(userId: string, group: Message[], deps: TurnDeps): Promise<string[]> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const kind = meta(group[0].metadata).kind;
  const currentMessages = group.map((message) => message.text?.trim() ?? "").filter(Boolean);

  const hasVisual = group.some((message) => {
    const data = meta(message.metadata);
    return data.kind === "photo" || data.kind === "video" || typeof data.photoFileId === "string";
  });
  if (kind === "start") return [startReply(user.firstName)];
  if (!user.aiEnabled) return [AI_DISABLED_REPLY];
  if ((!hasVisual && kind !== "text") || (currentMessages.length === 0 && !hasVisual)) return [UNSUPPORTED_REPLY];
  if (await isRateLimited(userId)) {
    logger.warn("telegram.rate_limited", { userId });
    return [RATE_LIMIT_REPLY];
  }

  const spoken = currentMessages.length > 0 ? currentMessages : ["(sent a photo)"];
  let memories: Awaited<ReturnType<typeof selectRelevantMemories>> = [];
  try {
    memories = await selectRelevantMemories(userId, spoken);
  } catch (error) {
    logger.error("memory.retrieval_failed", {
      userId,
      name: error instanceof Error ? error.name : "Error",
    });
  }
  const history = await prisma.message.findMany({
    where: {
      conversationId: group[0].conversationId,
      id: { notIn: group.map((message) => message.id) },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { direction: true, sender: true, text: true },
  });

  const visualContext = hasVisual ? await photoContext(group, deps) : null;
  let commercialContext: string | null = null;
  try {
    commercialContext = await replyCommercialHint({
      userId,
      conversationId: group[0].conversationId,
      userTexts: spoken,
    });
  } catch (error) {
    logger.error("sales.hint_failed", {
      userId,
      name: error instanceof Error ? error.name : "Error",
    });
  }
  return deps.generate({
    user,
    history: history.reverse(),
    currentMessages: spoken,
    memories: memories.map((memory) => ({ key: memory.key, value: memory.value })),
    visualContext,
    commercialContext,
  });
}

async function photoContext(group: Message[], deps: TurnDeps): Promise<string | null> {
  const photos = group
    .map((message) => {
      const data = meta(message.metadata);
      const fileId = data.photoFileId;
      if (typeof fileId !== "string" || fileId.length === 0) return null;
      return { fileId, caption: message.text?.trim() || null };
    })
    .filter((photo): photo is { fileId: string; caption: string | null } => photo !== null)
    .slice(0, 3);
  const form = visualFormOf(group);
  if (photos.length === 0) return visualTurnNote(null, group.some((message) => Boolean(message.text?.trim())), form);
  const understand = deps.understandCustomerPhotos ?? understandCustomerPhotos;
  let summary: string | null = null;
  try {
    summary = await understand(photos);
  } catch (error) {
    logger.warn("customer_photo.vision_failed", {
      name: error instanceof Error ? error.name : "Error",
    });
  }
  return visualTurnNote(summary, group.some((message) => Boolean(message.text?.trim())), form);
}

function visualFormOf(group: Message[]): "photo" | "image_file" | "video" | "animation" {
  const forms = group.map((message) => meta(message.metadata).visualForm);
  if (forms.includes("video")) return "video";
  if (forms.includes("animation")) return "animation";
  if (forms.includes("image_file")) return "image_file";
  return "photo";
}

async function understandCustomerPhotos(
  photos: Array<{ fileId: string; caption: string | null }>,
): Promise<string | null> {
  const lines: string[] = [];
  for (const photo of photos) {
    try {
      const file = await downloadTelegramFile(photo.fileId);
      const facts = await describeCustomerPhoto({
        bytes: file.bytes,
        mimeType: file.mimeType,
        caption: photo.caption,
      });
      if (facts) lines.push(formatCustomerPhotoContext(facts));
    } catch (error) {
      logger.warn("customer_photo.vision_failed", {
        name: error instanceof Error ? error.name : "Error",
      });
    }
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

async function loadPending(
  userId: string,
  selector: { kind: "text" } | { kind: "immediate"; messageId: string },
): Promise<Message[]> {
  const rows = await prisma.message.findMany({
    where: {
      userId,
      direction: "INBOUND",
      ...(selector.kind === "immediate" ? { id: selector.messageId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: selector.kind === "immediate" ? 1 : 50,
  });

  return rows
    .filter((message) => {
      const data = meta(message.metadata);
      if (data.processed === true) return false;
      if (selector.kind === "text") return data.kind === "text" || data.kind === "photo" || data.kind === "video";
      return true;
    })
    .reverse();
}

async function savePlan(group: Message[], turnId: string, texts: string[]): Promise<void> {
  for (const message of group) {
    const data = meta(message.metadata);
    await prisma.message.update({
      where: { id: message.id },
      data: {
        metadata: {
          ...data,
          turnId,
          plannedMessages: texts,
          processed: false,
        },
      },
    });
    message.metadata = {
      ...data,
      turnId,
      plannedMessages: texts,
      processed: false,
    };
  }
}

async function markProcessed(group: Message[]): Promise<void> {
  for (const message of group) {
    const current = await prisma.message.findUnique({
      where: { id: message.id },
      select: { metadata: true },
    });
    const data = meta(current?.metadata ?? message.metadata);
    await prisma.message.update({
      where: { id: message.id },
      data: { metadata: { ...data, processed: true } },
    });
  }
}

async function noteDeliveryFailure(group: Message[]): Promise<number> {
  let maxAttempts = 0;
  for (const message of group) {
    const current = await prisma.message.findUnique({
      where: { id: message.id },
      select: { metadata: true },
    });
    const data = meta(current?.metadata ?? message.metadata);
    const attempts = Number(data.deliveryAttempts ?? 0) + 1;
    maxAttempts = Math.max(maxAttempts, attempts);
    await prisma.message.update({
      where: { id: message.id },
      data: { metadata: { ...data, deliveryAttempts: attempts, processed: false } },
    });
  }
  return maxAttempts;
}

function startReply(firstName: string | null): string {
  const name = firstName?.trim();
  const hello = name ? `Hi ${name}.` : "Hi.";
  return `${hello} I'm Amy. Message me whenever you feel like talking — we can just pick up from here.`;
}

async function isRateLimited(userId: string): Promise<boolean> {
  const since = new Date(Date.now() - 60_000);
  const count = await prisma.message.count({
    where: { userId, direction: "INBOUND", createdAt: { gte: since } },
  });
  return count > 20;
}

function plannedMessages(message: Message): string[] {
  const value = meta(message.metadata).plannedMessages;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function turnIdOf(message: Message | undefined): string {
  const value = message ? meta(message.metadata).turnId : undefined;
  return typeof value === "string" ? value : "";
}

function partNumber(value: Prisma.JsonValue | null): number {
  const part = meta(value).part;
  return typeof part === "number" ? part : 0;
}

function meta(value: Prisma.JsonValue | null | undefined): Record<string, Prisma.JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, Prisma.JsonValue>;
}
