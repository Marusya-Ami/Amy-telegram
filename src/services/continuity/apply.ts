import type { EventStatus, PromiseAuthor } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import type { ContinuityExtraction } from "@/services/continuity/schema";
import { contentTokens, pickMatchingEvent, preferTitle } from "@/services/continuity/match";
import { isValidTimeZone, planEventFollowUps, planFollowUpAt, resolveWhen, zoneFor } from "@/services/continuity/time";
import { applyMemories } from "@/services/memory/store";
import { nextRelationshipStage } from "@/services/relationship/progress";
import { shouldRefreshSummary } from "@/services/summary/summary";

export async function applyExtraction(input: {
  userId: string;
  sourceMessageId: string | null;
  extraction: ContinuityExtraction;
  now?: Date;
  appTimeZone: string;
  quietStart?: string;
  quietEnd?: string;
}): Promise<void> {
  const now = input.now ?? new Date();
  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user) return;

  if (input.extraction.timezone && isValidTimeZone(input.extraction.timezone)) {
    await prisma.user.update({
      where: { id: user.id },
      data: { timezone: input.extraction.timezone },
    });
    user.timezone = input.extraction.timezone;
  }

  const timeZone = zoneFor(user.timezone, input.appTimeZone);
  await applyMemories(user.id, input.extraction.memories, input.sourceMessageId);

  for (const event of input.extraction.events) {
    await applyEvent({
      userId: user.id,
      event,
      sourceMessageId: input.sourceMessageId,
      now,
      timeZone,
      quietStart: input.quietStart,
      quietEnd: input.quietEnd,
    });
  }

  for (const promise of input.extraction.promises) {
    await applyPromise({
      userId: user.id,
      promise,
      sourceMessageId: input.sourceMessageId,
      now,
      timeZone,
      quietStart: input.quietStart,
      quietEnd: input.quietEnd,
    });
  }
}

export async function refreshRelationship(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return;
  const recent = await prisma.message.findMany({
    where: { userId, direction: "INBOUND" },
    select: { createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 400,
  });
  const activeDays = new Set(recent.map((message) => message.createdAt.toISOString().slice(0, 10))).size;
  const stage = nextRelationshipStage({
    current: user.relationshipStage,
    messagesCount: user.messagesCount,
    activeDays,
  });
  if (stage !== user.relationshipStage) {
    await prisma.user.update({ where: { id: userId }, data: { relationshipStage: stage } });
  }
}

export async function maybeUpdateSummary(input: {
  userId: string;
  summarize: (previous: string | null, recent: string) => Promise<string>;
}): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user) return;
  const since = user.messagesCount - user.conversationSummaryThroughCount;
  if (!shouldRefreshSummary(since)) return;

  const recent = await prisma.message.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { sender: true, text: true },
  });
  const transcript = recent
    .reverse()
    .map((message) => `${message.sender}: ${message.text ?? ""}`.trim())
    .filter((line) => line.length > 2)
    .join("\n");
  if (!transcript) return;

  try {
    const summary = (await input.summarize(user.conversationSummary, transcript)).trim();
    if (!summary) return;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        conversationSummary: summary.slice(0, 4000),
        conversationSummaryThroughCount: user.messagesCount,
      },
    });
    logger.info("summary.updated", { userId: user.id, throughCount: user.messagesCount });
  } catch (error) {
    logger.error("extraction.failure", {
      userId: user.id,
      name: error instanceof Error ? error.name : "SummaryError",
    });
  }
}

async function applyEvent(input: {
  userId: string;
  event: ContinuityExtraction["events"][number];
  sourceMessageId: string | null;
  now: Date;
  timeZone: string;
  quietStart?: string;
  quietEnd?: string;
}): Promise<void> {
  const resolved = resolveWhen({
    now: input.now,
    timeZone: input.timeZone,
    relativeDay: input.event.relativeDay,
    weekday: input.event.weekday,
    explicitDate: input.event.explicitDate,
    hour: input.event.hour,
    minute: input.event.minute,
  });
  const existing = await findEvent(input.userId, input.event.title, input.event.replacesTitle, resolved.eventDate);

  if (input.event.status === "CANCELLED") {
    if (!existing) return;
    await prisma.importantEvent.update({
      where: { id: existing.id },
      data: { status: "CANCELLED" },
    });
    await cancelFollowUps(existing.id, null, input.userId);
    logger.info("event.updated", { userId: input.userId, eventId: existing.id, status: "CANCELLED" });
    return;
  }

  const data = {
    title: existing ? preferTitle(existing.title, input.event.title.trim()) : input.event.title.trim(),
    description: mergeDescription(existing?.description ?? null, input.event.description),
    eventAt: resolved.timeKnown ? resolved.eventAt : (existing?.eventAt ?? null),
    eventDate: resolved.eventDate ?? existing?.eventDate ?? null,
    timeKnown: resolved.timeKnown || existing?.timeKnown || false,
    timezone: input.timeZone,
    status: input.event.status as EventStatus,
    emotionalContext: input.event.emotionalContext ?? existing?.emotionalContext ?? null,
    followUpEligible: input.event.followUpEligible || existing?.followUpEligible || false,
    sourceMessageId: input.sourceMessageId ?? existing?.sourceMessageId ?? null,
  };

  const saved = existing
    ? await prisma.importantEvent.update({ where: { id: existing.id }, data })
    : await prisma.importantEvent.create({ data: { userId: input.userId, ...data } });
  logger.info(existing ? "event.updated" : "event.created", {
    userId: input.userId,
    eventId: saved.id,
    status: saved.status,
    timeKnown: saved.timeKnown,
  });

  if (!saved.followUpEligible || saved.status === "CANCELLED") {
    await cancelFollowUps(saved.id, null, input.userId);
    return;
  }

  await syncEventFollowUps({
    userId: input.userId,
    event: saved,
    now: input.now,
    timeZone: input.timeZone,
    quietStart: input.quietStart,
    quietEnd: input.quietEnd,
  });
}

async function applyPromise(input: {
  userId: string;
  promise: ContinuityExtraction["promises"][number];
  sourceMessageId: string | null;
  now: Date;
  timeZone: string;
  quietStart?: string;
  quietEnd?: string;
}): Promise<void> {
  const resolved = resolveWhen({
    now: input.now,
    timeZone: input.timeZone,
    relativeDay: input.promise.relativeDay,
    weekday: input.promise.weekday,
    explicitDate: input.promise.explicitDate,
    hour: input.promise.hour,
    minute: input.promise.minute,
  });
  const created = await prisma.userPromise.create({
    data: {
      userId: input.userId,
      madeBy: input.promise.madeBy as PromiseAuthor,
      text: input.promise.text.trim(),
      dueAt: resolved.timeKnown ? resolved.eventAt : null,
      sourceMessageId: input.sourceMessageId,
    },
  });
  logger.info("promise.created", { userId: input.userId, promiseId: created.id, madeBy: created.madeBy });

  if (created.madeBy !== "AMY" && created.madeBy !== "USER") return;
  const scheduledAt = planFollowUpAt({
    now: input.now,
    timeZone: input.timeZone,
    eventAt: resolved.timeKnown ? resolved.eventAt : null,
    eventDate: resolved.eventDate,
    timeKnown: resolved.timeKnown,
    quietStart: input.quietStart,
    quietEnd: input.quietEnd,
  });
  await upsertFollowUp({
    userId: input.userId,
    eventId: null,
    promiseId: created.id,
    reasonType: "PROMISE",
    context: `A ${created.madeBy === "AMY" ? "promise Amy made" : "promise the user made"}: ${created.text}. Timing is ${resolved.timeKnown ? "known" : "approximate"}.`,
    scheduledAt,
  });
}

async function syncEventFollowUps(input: {
  userId: string;
  event: {
    id: string;
    title: string;
    description: string | null;
    emotionalContext: string | null;
    eventAt: Date | null;
    eventDate: string | null;
    timeKnown: boolean;
    followUpEligible: boolean;
  };
  now: Date;
  timeZone: string;
  quietStart?: string;
  quietEnd?: string;
}): Promise<void> {
  const plans = planEventFollowUps({
    now: input.now,
    timeZone: input.timeZone,
    title: input.event.title,
    emotionalContext: input.event.emotionalContext,
    eventAt: input.event.timeKnown ? input.event.eventAt : null,
    eventDate: input.event.eventDate,
    timeKnown: input.event.timeKnown,
    followUpEligible: input.event.followUpEligible,
    quietStart: input.quietStart,
    quietEnd: input.quietEnd,
  });
  const pending = await prisma.followUp.findMany({
    where: { userId: input.userId, eventId: input.event.id, status: "PENDING" },
  });
  const keep = new Set(plans.map((plan) => plan.phase ?? "DATE"));
  const obsolete = pending.filter((row) => !keep.has(row.phase ?? "DATE"));
  if (obsolete.length > 0) {
    await prisma.followUp.updateMany({
      where: { id: { in: obsolete.map((row) => row.id) } },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });
    for (const row of obsolete) logger.info("followup.cancelled", { userId: input.userId, followUpId: row.id });
  }
  for (const plan of plans) {
    await upsertFollowUp({
      userId: input.userId,
      eventId: input.event.id,
      promiseId: null,
      reasonType: "EVENT",
      phase: plan.phase,
      context: followUpContext(input.event, plan.phase),
      scheduledAt: plan.scheduledAt,
    });
  }
}

export async function cancelResolvedAfterFollowUps(userId: string, now = new Date()): Promise<void> {
  const events = await prisma.importantEvent.findMany({
    where: { userId, timeKnown: true, eventAt: { lte: now }, status: { in: ["UPCOMING", "PAST"] } },
    select: { id: true, title: true, eventAt: true },
  });
  if (events.length === 0) return;
  const earliest = events.reduce((min, event) => {
    const at = event.eventAt?.getTime() ?? now.getTime();
    return at < min ? at : min;
  }, now.getTime());
  const messages = await prisma.message.findMany({
    where: { userId, direction: "INBOUND", createdAt: { gte: new Date(earliest) } },
    select: { text: true, createdAt: true },
  });
  for (const event of events) {
    const told = messages.some(
      (message) =>
        event.eventAt &&
        message.createdAt.getTime() >= event.eventAt.getTime() &&
        textResolvesEvent(message.text ?? "", event.title),
    );
    if (!told) continue;
    const pending = await prisma.followUp.findMany({
      where: { userId, eventId: event.id, status: "PENDING", phase: "AFTER_EVENT" },
      select: { id: true },
    });
    if (pending.length === 0) continue;
    await prisma.followUp.updateMany({
      where: { id: { in: pending.map((row) => row.id) } },
      data: { status: "CANCELLED", cancelledAt: now },
    });
    for (const row of pending) logger.info("followup.cancelled", { userId, followUpId: row.id, reason: "outcome_known" });
  }
}

export function textResolvesEvent(text: string, title: string): boolean {
  if (!/\b(went|it was|it'?s over|finished|done with|nailed|bombed)\b/i.test(text)) return false;
  const haystack = text.toLowerCase();
  const tokens = contentTokens(title);
  return tokens.some((token) => haystack.includes(token)) || /\b(it|that)\b/i.test(text);
}

async function upsertFollowUp(input: {
  userId: string;
  eventId: string | null;
  promiseId: string | null;
  reasonType: "EVENT" | "PROMISE";
  phase?: "BEFORE_EVENT" | "AFTER_EVENT" | null;
  context: string;
  scheduledAt: Date;
}): Promise<void> {
  const existing = await prisma.followUp.findFirst({
    where: {
      userId: input.userId,
      status: "PENDING",
      eventId: input.eventId,
      promiseId: input.promiseId,
      phase: input.phase ?? null,
    },
  });
  if (existing) {
    await prisma.followUp.update({
      where: { id: existing.id },
      data: { scheduledAt: input.scheduledAt, context: input.context },
    });
    logger.info("followup.created", { userId: input.userId, followUpId: existing.id, phase: input.phase ?? null, change: "rescheduled" });
    return;
  }
  const created = await prisma.followUp.create({
    data: {
      userId: input.userId,
      reasonType: input.reasonType,
      phase: input.phase ?? null,
      eventId: input.eventId,
      promiseId: input.promiseId,
      context: input.context,
      scheduledAt: input.scheduledAt,
    },
  });
  logger.info("followup.created", { userId: input.userId, followUpId: created.id, phase: input.phase ?? null, reasonType: input.reasonType });
}

async function cancelFollowUps(eventId: string | null, promiseId: string | null, userId: string): Promise<void> {
  const pending = await prisma.followUp.findMany({
    where: { userId, status: "PENDING", eventId, promiseId },
    select: { id: true },
  });
  if (pending.length === 0) return;
  await prisma.followUp.updateMany({
    where: { id: { in: pending.map((item) => item.id) } },
    data: { status: "CANCELLED", cancelledAt: new Date() },
  });
  for (const item of pending) {
    logger.info("followup.cancelled", { userId, followUpId: item.id });
  }
}

async function findEvent(userId: string, title: string, replacesTitle: string | null, eventDate: string | null) {
  const events = await prisma.importantEvent.findMany({
    where: { userId, status: { not: "CANCELLED" } },
    orderBy: { updatedAt: "desc" },
    take: 20,
  });
  const hinted = normalizeTitle(replacesTitle || "");
  if (hinted) {
    const exact = events.find((event) => normalizeTitle(event.title) === hinted);
    if (exact) return exact;
  }
  const sameTitle = events.find((event) => normalizeTitle(event.title) === normalizeTitle(title));
  if (sameTitle) return sameTitle;
  return pickMatchingEvent(events, { title: replacesTitle || title, eventDate });
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function mergeDescription(current: string | null, incoming: string | null): string | null {
  if (!incoming) return current;
  if (!current) return incoming;
  if (current.toLowerCase().includes(incoming.toLowerCase())) return current;
  if (incoming.toLowerCase().includes(current.toLowerCase())) return incoming;
  return `${current}; ${incoming}`;
}

function followUpContext(
  event: { title: string; description: string | null; emotionalContext: string | null; timeKnown: boolean },
  phase: "BEFORE_EVENT" | "AFTER_EVENT" | null,
): string {
  const detail = event.description ? ` Detail: ${event.description}.` : "";
  const feeling = event.emotionalContext ? ` They felt ${event.emotionalContext}.` : "";
  const hidden = "Do not mention reminders, schedules, or internal labels.";
  if (phase === "BEFORE_EVENT") {
    return `They have ${event.title} coming up in a few minutes.${detail}${feeling} If it fits, wish them luck in your own words. ${hidden}`;
  }
  if (phase === "AFTER_EVENT") {
    return `Their ${event.title} has probably happened.${detail}${feeling} Ask how it went in your own words. ${hidden}`;
  }
  const timing = event.timeKnown ? "The time was explicit." : "The exact time was not known.";
  return `Check in naturally about: ${event.title}.${detail}${feeling} ${timing} ${hidden}`;
}
