import type { MessagingTransport } from "@/services/transport/messagingTransport";
import { prisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import { sleep } from "@/lib/retry";
import { generateProactive } from "@/services/amyBrain";
import { interMessageDelayMs } from "@/services/messageProcessor/burstScheduler";
import { selectRelevantMemories } from "@/services/memory/store";
import { proactiveSendDecision, zoneFor } from "@/services/continuity/time";

const BATCH_LIMIT = 3;

export async function runDueFollowUps(input: {
  now?: Date;
  transport: MessagingTransport;
  appTimeZone: string;
  quietStart?: string;
  quietEnd?: string;
  generate?: typeof generateProactive;
}): Promise<{ sentUsers: number; skipped: number }> {
  const now = input.now ?? new Date();
  const due = await prisma.followUp.findMany({
    where: { status: "PENDING", scheduledAt: { lte: now } },
    orderBy: { scheduledAt: "asc" },
    take: 40,
    include: { event: true, promise: true },
  });

  const grouped = new Map<string, typeof due>();
  for (const item of due) {
    const list = grouped.get(item.userId) ?? [];
    list.push(item);
    grouped.set(item.userId, list);
  }

  let sentUsers = 0;
  let skipped = 0;

  for (const [userId, items] of grouped) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) continue;
    const timeZone = zoneFor(user.timezone, input.appTimeZone);
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const recentProactive = await prisma.message.findMany({
      where: {
        userId,
        direction: "OUTBOUND",
        createdAt: { gte: since },
        metadata: { path: ["kind"], equals: "proactive" },
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, metadata: true },
    });
    const siblingIds = await journeySiblingIds(items);
    const counted = recentProactive.filter((message) => !referencesSibling(message.metadata, siblingIds));
    const decision = proactiveSendDecision({
      now,
      timeZone,
      proactiveCount24h: counted.length,
      lastProactiveAt: counted[0]?.createdAt ?? null,
      proactiveEnabled: user.proactiveEnabled,
      aiEnabled: user.aiEnabled,
      lastUserMessageAt: user.lastUserMessageAt,
      quietStart: input.quietStart,
      quietEnd: input.quietEnd,
    });

    if (!decision.send) {
      skipped += 1;
      if (decision.rescheduleAt) {
        await prisma.followUp.updateMany({
          where: { id: { in: items.map((item) => item.id) }, status: "PENDING" },
          data: { scheduledAt: decision.rescheduleAt },
        });
      }
      continue;
    }

    const chosen = items.slice(0, BATCH_LIMIT);
    const claimed = await claimFollowUps(chosen.map((item) => item.id), now);
    if (claimed.length === 0) {
      skipped += 1;
      continue;
    }

    const claimedItems = chosen.filter((item) => claimed.includes(item.id));
    try {
      await sendProactiveTurn({
        user,
        items: claimedItems,
        transport: input.transport,
        generate: input.generate ?? generateProactive,
        now,
      });
      sentUsers += 1;
      logger.info("followup.sent", { userId, count: claimed.length });
    } catch (error) {
      await prisma.followUp.updateMany({
        where: { id: { in: claimed }, status: "SENT", sentAt: now },
        data: { status: "PENDING", sentAt: null },
      });
      logger.error("followup.sent", {
        userId,
        failed: true,
        name: error instanceof Error ? error.name : "Error",
      });
    }
  }

  return { sentUsers, skipped };
}

async function claimFollowUps(ids: string[], now: Date): Promise<string[]> {
  const claimed: string[] = [];
  for (const id of ids) {
    const result = await prisma.followUp.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "SENT", sentAt: now },
    });
    if (result.count === 1) claimed.push(id);
  }
  return claimed;
}

async function sendProactiveTurn(input: {
  user: {
    id: string;
    firstName: string | null;
    relationshipStage: import("@prisma/client").RelationshipStage;
    conversationSummary: string | null;
  };
  items: Array<{ id: string; context: string; event: { title: string; emotionalContext: string | null } | null; promise: { text: string; madeBy: string } | null }>;
  transport: MessagingTransport;
  generate: typeof generateProactive;
  now: Date;
}): Promise<void> {
  const conversation = await prisma.conversation.findFirst({
    where: { userId: input.user.id, active: true },
    orderBy: { updatedAt: "desc" },
  });
  if (!conversation) throw new Error("No conversation for follow-up");

  const history = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "desc" },
    take: 12,
    select: { direction: true, sender: true, text: true },
  });
  const memories = await selectRelevantMemories(
    input.user.id,
    input.items.map((item) => item.context),
  );
  const context = input.items
    .map((item) => {
      const event = item.event ? `Event: ${item.event.title}.` : "";
      const promise = item.promise ? `Promise (${item.promise.madeBy}): ${item.promise.text}.` : "";
      return [item.context, event, promise].filter(Boolean).join(" ");
    })
    .join("\n");

  const bubbles = await input.generate({
    user: input.user,
    history: history.reverse(),
    memories: memories.map((memory) => ({ key: memory.key, value: memory.value })),
    followUpContext: context,
  });

  for (let index = 0; index < bubbles.length; index += 1) {
    if (index > 0) await sleep(interMessageDelayMs());
    const sent = await input.transport.sendText(
      conversation.platformConversationId,
      bubbles[index],
      conversation.businessConnectionId ? { businessConnectionId: conversation.businessConnectionId } : undefined,
    );
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        userId: input.user.id,
        direction: "OUTBOUND",
        sender: "AMY",
        type: "TEXT",
        text: bubbles[index],
        telegramMessageId: sent.messageId,
        metadata: {
          kind: "proactive",
          followUpIds: input.items.map((item) => item.id),
          part: index + 1,
          parts: bubbles.length,
        },
      },
    });
  }

  await prisma.user.update({
    where: { id: input.user.id },
    data: { lastAmyMessageAt: input.now },
  });
}

async function journeySiblingIds(items: Array<{ id: string; eventId: string | null; phase: string | null }>): Promise<Set<string>> {
  const eventIds = items.map((item) => item.eventId).filter((id): id is string => Boolean(id));
  if (eventIds.length === 0) return new Set();
  const sent = await prisma.followUp.findMany({
    where: { eventId: { in: eventIds }, status: "SENT" },
    select: { id: true, eventId: true, phase: true },
  });
  return new Set(
    sent
      .filter((row) =>
        items.some((item) => item.eventId === row.eventId && item.phase && row.phase && item.phase !== row.phase),
      )
      .map((row) => row.id),
  );
}

function referencesSibling(metadata: unknown, siblingIds: Set<string>): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const ids = (metadata as { followUpIds?: unknown }).followUpIds;
  return Array.isArray(ids) && ids.some((id) => typeof id === "string" && siblingIds.has(id));
}
