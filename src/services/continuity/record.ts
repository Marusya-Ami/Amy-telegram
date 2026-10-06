import { prisma } from "@/lib/db/prisma";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { applyExtraction, cancelResolvedAfterFollowUps, maybeUpdateSummary, refreshRelationship } from "@/services/continuity/apply";
import { extractContinuity } from "@/services/continuity/extract";
import { emptyExtraction } from "@/services/continuity/schema";
import { selectRelevantMemories } from "@/services/memory/store";
import { recordInteractionDynamic } from "@/services/interaction/dynamic";
import { summarizeConversation } from "@/services/summary/generate";

export async function recordContinuity(input: {
  userId: string;
  sourceMessageId: string | null;
  userTexts: string[];
  amyTexts: string[];
}): Promise<void> {
  await refreshRelationship(input.userId);
  await recordInteractionDynamic(input.userId, input.userTexts).catch((error: unknown) => {
    logger.error("interaction.updated", {
      userId: input.userId,
      failed: true,
      name: error instanceof Error ? error.name : "Error",
    });
  });
  const existing = await selectRelevantMemories(input.userId, input.userTexts, 12);
  const context = await loadExtractionContext(input.userId);
  let extraction = emptyExtraction();
  try {
    extraction = await extractContinuity({
      userId: input.userId,
      userTexts: input.userTexts,
      amyTexts: input.amyTexts,
      existingMemories: existing.map((memory) => ({ key: memory.key, value: memory.value })),
      recentUserTexts: context.recentUserTexts,
      upcomingEvents: context.upcomingEvents,
    });
  } catch (error) {
    logger.error("extraction.failure", {
      userId: input.userId,
      name: error instanceof Error ? error.name : "ExtractionError",
    });
  }

  const env = getEnv();
  await applyExtraction({
    userId: input.userId,
    sourceMessageId: input.sourceMessageId,
    extraction,
    appTimeZone: env.APP_TIMEZONE,
    quietStart: env.QUIET_HOURS_START,
    quietEnd: env.QUIET_HOURS_END,
  });

  await cancelResolvedAfterFollowUps(input.userId).catch((error: unknown) => {
    logger.error("followup.cancelled", {
      userId: input.userId,
      failed: true,
      name: error instanceof Error ? error.name : "Error",
    });
  });

  await maybeUpdateSummary({
    userId: input.userId,
    summarize: summarizeConversation,
  });
}

async function loadExtractionContext(userId: string): Promise<{
  recentUserTexts: string[];
  upcomingEvents: Array<{ title: string; eventDate: string | null }>;
}> {
  try {
    const [messages, events] = await Promise.all([
      prisma.message.findMany({
        where: { userId, direction: "INBOUND" },
        orderBy: { createdAt: "desc" },
        take: 8,
        select: { text: true },
      }),
      prisma.importantEvent.findMany({
        where: { userId, status: "UPCOMING" },
        orderBy: { updatedAt: "desc" },
        take: 5,
        select: { title: true, eventDate: true },
      }),
    ]);
    return {
      recentUserTexts: messages.map((message) => message.text?.trim() ?? "").filter(Boolean).reverse(),
      upcomingEvents: events,
    };
  } catch (error) {
    logger.error("extraction.failure", {
      userId,
      name: error instanceof Error ? error.name : "ContextError",
    });
    return { recentUserTexts: [], upcomingEvents: [] };
  }
}
