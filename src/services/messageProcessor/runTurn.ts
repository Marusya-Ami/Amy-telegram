import { randomUUID } from "crypto";
import type { Message, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import { sleep } from "@/lib/retry";
import { generateReply } from "@/services/amyBrain";
import { interMessageDelayMs } from "@/services/messageProcessor/burstScheduler";
import { telegramBotTransport } from "@/services/transport/telegramBotTransport";
import { TransportDeliveryError } from "@/services/transport/messagingTransport";

const MAX_DELIVERY_ATTEMPTS = 3;

const UNSUPPORTED_REPLY = "i can only text right now";
const RATE_LIMIT_REPLY = "slow down a sec lol";
const AI_DISABLED_REPLY = "i can't answer right now";

export type TurnDeps = {
  generate: typeof generateReply;
  send: (chatId: string, text: string) => Promise<{ messageId: string }>;
  sleep: (ms: number) => Promise<void>;
  delayMs: () => number;
};

const defaultDeps: TurnDeps = {
  generate: generateReply,
  send: (chatId, text) => telegramBotTransport.sendText(chatId, text),
  sleep,
  delayMs: interMessageDelayMs,
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

async function deliverGroup(userId: string, group: Message[], deps: TurnDeps): Promise<void> {
  let turnId = turnIdOf(group[0]);
  let texts = plannedMessages(group[0]);

  if (texts.length === 0) {
    turnId = randomUUID();
    texts = await composeTexts(userId, group, deps);
    await savePlan(group, turnId, texts);
  }

  const conversation = await prisma.conversation.findUniqueOrThrow({
    where: { id: group[0].conversationId },
    select: { platformConversationId: true },
  });
  const alreadySent = await prisma.message.findMany({
    where: {
      userId,
      direction: "OUTBOUND",
      metadata: { path: ["turnId"], equals: turnId },
    },
    select: { metadata: true },
  });
  const sentParts = new Set(alreadySent.map((message) => partNumber(message.metadata)));
  const respondingToIds = group.map((message) => message.id);
  const replyToMessageId = group[group.length - 1]?.telegramMessageId ?? null;

  for (let index = 0; index < texts.length; index += 1) {
    const part = index + 1;
    if (sentParts.has(part)) continue;
    if (index > 0) await deps.sleep(deps.delayMs());

    const sent = await deps.send(conversation.platformConversationId, texts[index]);
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
}

async function composeTexts(userId: string, group: Message[], deps: TurnDeps): Promise<string[]> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const kind = meta(group[0].metadata).kind;
  const currentMessages = group.map((message) => message.text?.trim() ?? "").filter(Boolean);

  if (kind === "start") return [startReply(user.firstName)];
  if (!user.aiEnabled) return [AI_DISABLED_REPLY];
  if (kind !== "text" || currentMessages.length === 0) return [UNSUPPORTED_REPLY];
  if (await isRateLimited(userId)) {
    logger.warn("telegram.rate_limited", { userId });
    return [RATE_LIMIT_REPLY];
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

  return deps.generate({
    user,
    history: history.reverse(),
    currentMessages,
  });
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
      if (selector.kind === "text") return data.kind === "text";
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
