import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { prepareExtraction } from "@/services/continuity/classify";
import { parseContinuityExtraction, type ContinuityExtraction } from "@/services/continuity/schema";
import {
  isQuietHour,
  nextOpenMoment,
  planFollowUpAt,
  proactiveSendDecision,
  resolveWhen,
  zonedParts,
} from "@/services/continuity/time";
import { rankMemories } from "@/services/memory/store";
import { nextRelationshipStage } from "@/services/relationship/progress";
import { shouldRefreshSummary } from "@/services/summary/summary";

loadEnv("/Users/mariia/Amy-telegram/.env");

const ZONE = "America/Cancun";
const NOW = new Date("2026-09-22T15:00:00.000Z");

test("explicit fact creates memory and a trivial one does not", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { applyExtraction } = await import("@/services/continuity/apply");
  const ids = await seed(prisma, "m2-fact");
  try {
    await applyExtraction({
      userId: ids.userId,
      sourceMessageId: null,
      extraction: extraction({
        memories: [
          memory({ key: "preferred_name", value: "John", confidence: 0.95, importance: 0.9, type: "PERSONAL_FACT" }),
          memory({ key: "small_talk", value: "bored", confidence: 0.2, importance: 0.1, type: "OTHER" }),
        ],
      }),
      now: NOW,
      appTimeZone: ZONE,
    });
    const rows = await prisma.userMemory.findMany({ where: { userId: ids.userId, active: true } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.key, "preferred_name");
    assert.equal(rows[0]?.value, "John");
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("duplicate memory confirms instead of inserting another row", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { applyExtraction } = await import("@/services/continuity/apply");
  const ids = await seed(prisma, "m2-dup");
  try {
    const fact = memory({ key: "favorite_food", value: "sushi", type: "PREFERENCE" });
    await applyExtraction({
      userId: ids.userId,
      sourceMessageId: null,
      extraction: extraction({ memories: [fact] }),
      now: NOW,
      appTimeZone: ZONE,
    });
    await applyExtraction({
      userId: ids.userId,
      sourceMessageId: null,
      extraction: extraction({ memories: [fact] }),
      now: NOW,
      appTimeZone: ZONE,
    });
    const rows = await prisma.userMemory.findMany({ where: { userId: ids.userId } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.active, true);
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("a clear move updates the current location and keeps one active fact", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { applyExtraction } = await import("@/services/continuity/apply");
  const ids = await seed(prisma, "m2-move");
  try {
    await applyExtraction({
      userId: ids.userId,
      sourceMessageId: null,
      extraction: extraction({
        memories: [memory({ key: "city", value: "Miami", type: "LOCATION", confidence: 0.9, importance: 0.8 })],
      }),
      now: NOW,
      appTimeZone: ZONE,
    });
    await applyExtraction({
      userId: ids.userId,
      sourceMessageId: null,
      extraction: extraction({
        memories: [
          memory({
            key: "city",
            value: "Los Angeles",
            type: "LOCATION",
            confidence: 0.92,
            importance: 0.8,
            replacesKey: "city",
          }),
        ],
      }),
      now: NOW,
      appTimeZone: ZONE,
    });
    const active = await prisma.userMemory.findMany({ where: { userId: ids.userId, active: true } });
    assert.equal(active.length, 1);
    assert.equal(active[0]?.value, "Los Angeles");
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("weak inference is not stored as a fact", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { applyExtraction } = await import("@/services/continuity/apply");
  const ids = await seed(prisma, "m2-weak");
  try {
    await applyExtraction({
      userId: ids.userId,
      sourceMessageId: null,
      extraction: extraction({
        memories: [
          memory({
            key: "occupation",
            value: "works at a hospital",
            type: "WORK",
            confidence: 0.4,
            importance: 0.7,
          }),
        ],
      }),
      now: NOW,
      appTimeZone: ZONE,
    });
    const rows = await prisma.userMemory.findMany({ where: { userId: ids.userId } });
    assert.equal(rows.length, 0);
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("an uncertain correction does not overwrite the current fact", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { applyExtraction } = await import("@/services/continuity/apply");
  const ids = await seed(prisma, "m2-joke");
  try {
    await applyExtraction({
      userId: ids.userId,
      sourceMessageId: null,
      extraction: extraction({
        memories: [memory({ key: "city", value: "Miami", type: "LOCATION" })],
      }),
      now: NOW,
      appTimeZone: ZONE,
    });
    await applyExtraction({
      userId: ids.userId,
      sourceMessageId: null,
      extraction: extraction({
        memories: [memory({ key: "city", value: "the moon", type: "LOCATION", confidence: 0.62 })],
      }),
      now: NOW,
      appTimeZone: ZONE,
    });
    const active = await prisma.userMemory.findMany({ where: { userId: ids.userId, active: true } });
    assert.equal(active.length, 1);
    assert.equal(active[0]?.value, "Miami");
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("future event resolves a relative time and does not invent a clock time", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { applyExtraction } = await import("@/services/continuity/apply");
  const ids = await seed(prisma, "m2-event");
  try {
    await applyExtraction({
      userId: ids.userId,
      sourceMessageId: null,
      extraction: extraction({
        events: [
          event({
            title: "job interview",
            relativeDay: "tomorrow",
            hour: 10,
            minute: 0,
            emotionalContext: "nervous",
            followUpEligible: true,
          }),
          event({
            title: "exam",
            relativeDay: "tomorrow",
            hour: null,
            minute: null,
            followUpEligible: true,
          }),
        ],
      }),
      now: NOW,
      appTimeZone: ZONE,
    });

    const interview = await prisma.importantEvent.findFirstOrThrow({
      where: { userId: ids.userId, title: "job interview" },
    });
    assert.equal(interview.timeKnown, true);
    assert.equal(interview.eventAt?.toISOString(), "2026-09-23T15:00:00.000Z");
    assert.equal(interview.emotionalContext, "nervous");

    const exam = await prisma.importantEvent.findFirstOrThrow({
      where: { userId: ids.userId, title: "exam" },
    });
    assert.equal(exam.timeKnown, false);
    assert.equal(exam.eventAt, null);
    assert.equal(exam.eventDate, "2026-09-23");

    const interviewFollowUps = await prisma.followUp.findMany({ where: { eventId: interview.id }, orderBy: { scheduledAt: "asc" } });
    assert.deepEqual(interviewFollowUps.map((row) => row.phase), ["BEFORE_EVENT", "AFTER_EVENT"]);
    assert.equal(interviewFollowUps[0]?.scheduledAt.toISOString(), "2026-09-23T14:50:00.000Z");
    assert.equal(interviewFollowUps[1]?.scheduledAt.toISOString(), "2026-09-23T15:40:00.000Z");

    const examFollowUps = await prisma.followUp.findMany({ where: { eventId: exam.id } });
    assert.equal(examFollowUps.length, 1);
    assert.equal(examFollowUps[0]?.phase, null);
    assert.equal(examFollowUps[0]?.scheduledAt.toISOString(), "2026-09-24T16:00:00.000Z");
    assert.equal(zonedParts(examFollowUps[0]!.scheduledAt, ZONE).hour, 11);
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("weekday and explicit dates resolve in the user timezone", () => {
  const friday = resolveWhen({
    now: NOW,
    timeZone: ZONE,
    relativeDay: null,
    weekday: "friday",
    explicitDate: null,
    hour: 10,
    minute: 0,
  });
  assert.equal(friday.timeKnown, true);
  assert.equal(friday.eventAt?.toISOString(), "2026-09-25T15:00:00.000Z");

  const dated = resolveWhen({
    now: NOW,
    timeZone: ZONE,
    relativeDay: null,
    weekday: null,
    explicitDate: "2026-10-02",
    hour: null,
    minute: null,
  });
  assert.equal(dated.timeKnown, false);
  assert.equal(dated.eventAt, null);
  assert.equal(dated.eventDate, "2026-10-02");
});

test("cancelling an event cancels its follow-up and a new date moves it", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { applyExtraction } = await import("@/services/continuity/apply");
  const ids = await seed(prisma, "m2-cancel");
  try {
    const first = extraction({
      events: [event({ title: "job interview", relativeDay: "tomorrow", hour: 10, minute: 0, followUpEligible: true })],
    });
    await applyExtraction({
      userId: ids.userId,
      sourceMessageId: null,
      extraction: first,
      now: NOW,
      appTimeZone: ZONE,
    });
    await applyExtraction({
      userId: ids.userId,
      sourceMessageId: null,
      extraction: extraction({
        events: [
          event({
            title: "job interview",
            replacesTitle: "job interview",
            relativeDay: "next_week",
            hour: 10,
            minute: 0,
            followUpEligible: true,
          }),
        ],
      }),
      now: NOW,
      appTimeZone: ZONE,
    });
    const moved = await prisma.followUp.findMany({
      where: { userId: ids.userId, status: "PENDING" },
      orderBy: { scheduledAt: "asc" },
    });
    assert.deepEqual(moved.map((row) => row.scheduledAt.toISOString()), [
      "2026-09-29T14:50:00.000Z",
      "2026-09-29T15:40:00.000Z",
    ]);

    await applyExtraction({
      userId: ids.userId,
      sourceMessageId: null,
      extraction: extraction({
        events: [event({ title: "job interview", replacesTitle: "job interview", status: "CANCELLED" })],
      }),
      now: NOW,
      appTimeZone: ZONE,
    });
    const followUps = await prisma.followUp.findMany({ where: { userId: ids.userId } });
    const saved = await prisma.importantEvent.findFirstOrThrow({ where: { userId: ids.userId } });
    assert.equal(saved.status, "CANCELLED");
    assert.equal(followUps.length, 2);
    assert.ok(followUps.every((row) => row.status === "CANCELLED"));
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("an Amy promise stores no invented due time", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { applyExtraction } = await import("@/services/continuity/apply");
  const ids = await seed(prisma, "m2-promise");
  try {
    await applyExtraction({
      userId: ids.userId,
      sourceMessageId: null,
      extraction: extraction({
        promises: [
          {
            madeBy: "AMY",
            text: "text after shift",
            relativeDay: null,
            weekday: null,
            explicitDate: null,
            hour: null,
            minute: null,
          },
        ],
      }),
      now: NOW,
      appTimeZone: ZONE,
    });
    const promise = await prisma.userPromise.findFirstOrThrow({ where: { userId: ids.userId } });
    assert.equal(promise.madeBy, "AMY");
    assert.equal(promise.dueAt, null);
    const followUp = await prisma.followUp.findFirstOrThrow({ where: { promiseId: promise.id } });
    assert.equal(followUp.status, "PENDING");
    assert.equal(followUp.scheduledAt.toISOString(), "2026-09-23T16:00:00.000Z");
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("quiet hours block proactive sends and the daily cap reschedules", () => {
  const quiet = new Date("2026-09-23T04:30:00.000Z");
  assert.equal(isQuietHour(quiet, ZONE), true);
  assert.equal(isQuietHour(new Date("2026-09-23T14:00:00.000Z"), ZONE), false);
  const quietDecision = proactiveSendDecision({
    now: quiet,
    timeZone: ZONE,
    proactiveCount24h: 0,
    lastProactiveAt: null,
    proactiveEnabled: true,
    aiEnabled: true,
    lastUserMessageAt: new Date("2026-09-22T12:00:00.000Z"),
  });
  assert.equal(quietDecision.send, false);
  assert.equal(quietDecision.reason, "quiet_hours");
  assert.equal(quietDecision.rescheduleAt?.toISOString(), "2026-09-23T14:00:00.000Z");

  const capped = proactiveSendDecision({
    now: NOW,
    timeZone: ZONE,
    proactiveCount24h: 2,
    lastProactiveAt: new Date("2026-09-22T14:00:00.000Z"),
    proactiveEnabled: true,
    aiEnabled: true,
    lastUserMessageAt: new Date("2026-09-22T12:00:00.000Z"),
  });
  assert.equal(capped.send, false);
  assert.equal(capped.reason, "daily_cap");
  assert.equal(nextOpenMoment(new Date(NOW.getTime() + 12 * 60 * 60 * 1000), ZONE).toISOString(), capped.rescheduleAt?.toISOString());
});

test("a second scheduler run does not send the follow-up again", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { runDueFollowUps } = await import("@/services/followups/runDue");
  const ids = await seed(prisma, "m2-once");
  const sent: string[] = [];
  try {
    await prisma.user.update({
      where: { id: ids.userId },
      data: { lastUserMessageAt: new Date("2026-09-22T12:00:00.000Z") },
    });
    await prisma.followUp.create({
      data: {
        userId: ids.userId,
        reasonType: "OTHER",
        context: "ask how the interview went",
        scheduledAt: NOW,
      },
    });
    const input = {
      now: NOW,
      appTimeZone: ZONE,
      transport: {
        name: "telegram-bot" as const,
        sendText: async (_chatId: string, text: string) => {
          sent.push(text);
          return { messageId: `p-${sent.length}` };
        },
        sendMedia: async () => {
          throw new Error("unused");
        },
        sendBusinessPhoto: async () => {
          throw new Error("unused");
        },
        sendTyping: async () => undefined,
        identifyUser: () => null,
      },
      generate: async () => ["how was it"],
    };
    const [first, second] = await Promise.all([runDueFollowUps(input), runDueFollowUps(input)]);
    assert.equal(first.sentUsers + second.sentUsers, 1);
    assert.equal(sent.length, 1);
    const followUp = await prisma.followUp.findFirstOrThrow({ where: { userId: ids.userId } });
    assert.equal(followUp.status, "SENT");
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("memories from two users stay separate", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { applyExtraction } = await import("@/services/continuity/apply");
  const { selectRelevantMemories } = await import("@/services/memory/store");
  const a = await seed(prisma, "m2-user-a");
  const b = await seed(prisma, "m2-user-b");
  try {
    await applyExtraction({
      userId: a.userId,
      sourceMessageId: null,
      extraction: extraction({ memories: [memory({ key: "pet", value: "Max", type: "PET" })] }),
      now: NOW,
      appTimeZone: ZONE,
    });
    await applyExtraction({
      userId: b.userId,
      sourceMessageId: null,
      extraction: extraction({ memories: [memory({ key: "pet", value: "Luna", type: "PET" })] }),
      now: NOW,
      appTimeZone: ZONE,
    });
    const aMemories = await selectRelevantMemories(a.userId, ["how is the dog"]);
    const bMemories = await selectRelevantMemories(b.userId, ["how is the dog"]);
    assert.deepEqual(aMemories.map((item) => item.value), ["Max"]);
    assert.deepEqual(bMemories.map((item) => item.value), ["Luna"]);
  } finally {
    await cleanup(prisma, a.userId);
    await cleanup(prisma, b.userId);
  }
});

test("retrieval keeps a few important facts and prefers a matching topic", () => {
  const selected = rankMemories(
    [
      row("1", "name", "John", 0.95),
      row("2", "city", "Chicago", 0.9),
      row("3", "occupation", "finance", 0.85),
      row("4", "pet", "Max", 0.82),
      row("5", "hobby", "climbing", 0.4),
      row("6", "favorite_color", "blue", 0.3),
    ],
    ["finally finished work"],
    4,
  );
  assert.equal(selected.length, 4);
  assert.ok(selected.some((item) => item.key === "occupation"));
  assert.ok(selected.every((item) => item.importance >= 0.8 || item.key === "occupation"));
});

test("summary updates after enough new messages and not before", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { maybeUpdateSummary } = await import("@/services/continuity/apply");
  const ids = await seed(prisma, "m2-summary");
  try {
    assert.equal(shouldRefreshSummary(23), false);
    assert.equal(shouldRefreshSummary(24), true);
    await prisma.user.update({ where: { id: ids.userId }, data: { messagesCount: 10 } });
    await prisma.message.create({
      data: {
        conversationId: ids.conversationId,
        userId: ids.userId,
        direction: "INBOUND",
        sender: "USER",
        type: "TEXT",
        text: "talked about work",
      },
    });
    await maybeUpdateSummary({
      userId: ids.userId,
      summarize: async () => "should not save",
    });
    const early = await prisma.user.findUniqueOrThrow({ where: { id: ids.userId } });
    assert.equal(early.conversationSummary, null);

    await prisma.user.update({ where: { id: ids.userId }, data: { messagesCount: 24 } });
    await maybeUpdateSummary({
      userId: ids.userId,
      summarize: async () => "they have been talking about work",
    });
    const later = await prisma.user.findUniqueOrThrow({ where: { id: ids.userId } });
    assert.equal(later.conversationSummary, "they have been talking about work");
    assert.equal(later.conversationSummaryThroughCount, 24);
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("proactive off blocks a follow-up and chat still replies", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { runDueFollowUps } = await import("@/services/followups/runDue");
  const { processImmediateMessage, processTextBurst } = await import("@/services/messageProcessor/runTurn");
  const ids = await seed(prisma, "m2-stop");
  let proactiveSends = 0;
  try {
    await prisma.message.create({
      data: {
        conversationId: ids.conversationId,
        userId: ids.userId,
        direction: "INBOUND",
        sender: "USER",
        type: "TEXT",
        text: "/stop",
        telegramMessageId: "stop-1",
        metadata: { kind: "stop", processed: false },
      },
    });
    const inbound = await prisma.message.findFirstOrThrow({ where: { userId: ids.userId, text: "/stop" } });
    await processImmediateMessage(ids.userId, inbound.id, fakeTurn());
    const stopped = await prisma.user.findUniqueOrThrow({ where: { id: ids.userId } });
    assert.equal(stopped.proactiveEnabled, false);
    assert.equal(stopped.aiEnabled, true);

    await prisma.followUp.create({
      data: {
        userId: ids.userId,
        reasonType: "OTHER",
        context: "check in",
        scheduledAt: NOW,
      },
    });
    const result = await runDueFollowUps({
      now: NOW,
      appTimeZone: ZONE,
      transport: {
        name: "telegram-bot" as const,
        sendText: async () => {
          proactiveSends += 1;
          return { messageId: "nope" };
        },
        sendMedia: async () => {
          throw new Error("unused");
        },
        sendBusinessPhoto: async () => {
          throw new Error("unused");
        },
        sendTyping: async () => undefined,
        identifyUser: () => null,
      },
      generate: async () => ["heyy"],
    });
    assert.equal(result.sentUsers, 0);
    assert.equal(proactiveSends, 0);
    const followUp = await prisma.followUp.findFirstOrThrow({ where: { userId: ids.userId } });
    assert.equal(followUp.status, "PENDING");

    await prisma.message.create({
      data: {
        conversationId: ids.conversationId,
        userId: ids.userId,
        direction: "INBOUND",
        sender: "USER",
        type: "TEXT",
        text: "you there",
        telegramMessageId: "chat-1",
        metadata: { kind: "text", processed: false },
      },
    });
    await processTextBurst(ids.userId, fakeTurn(async () => ["yeah"]));
    const reply = await prisma.message.findFirst({
      where: { userId: ids.userId, direction: "OUTBOUND", text: "yeah" },
    });
    assert.ok(reply);
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("delete asks for confirmation and then removes only that user", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { processImmediateMessage } = await import("@/services/messageProcessor/runTurn");
  const { applyExtraction } = await import("@/services/continuity/apply");
  const ids = await seed(prisma, "m2-delete");
  const other = await seed(prisma, "m2-keep");
  try {
    await applyExtraction({
      userId: ids.userId,
      sourceMessageId: null,
      extraction: extraction({ memories: [memory({ key: "city", value: "Miami", type: "LOCATION" })] }),
      now: NOW,
      appTimeZone: ZONE,
    });
    await applyExtraction({
      userId: other.userId,
      sourceMessageId: null,
      extraction: extraction({ memories: [memory({ key: "city", value: "Chicago", type: "LOCATION" })] }),
      now: NOW,
      appTimeZone: ZONE,
    });

    const ask = await prisma.message.create({
      data: {
        conversationId: ids.conversationId,
        userId: ids.userId,
        direction: "INBOUND",
        sender: "USER",
        type: "TEXT",
        text: "/delete",
        telegramMessageId: "del-1",
        metadata: { kind: "delete", processed: false },
      },
    });
    await processImmediateMessage(ids.userId, ask.id, fakeTurn());
    const pending = await prisma.user.findUniqueOrThrow({ where: { id: ids.userId } });
    assert.ok(pending.deleteRequestedAt);
    assert.equal(await prisma.userMemory.count({ where: { userId: ids.userId } }), 1);

    const confirm = await prisma.message.create({
      data: {
        conversationId: ids.conversationId,
        userId: ids.userId,
        direction: "INBOUND",
        sender: "USER",
        type: "TEXT",
        text: "/delete confirm",
        telegramMessageId: "del-2",
        metadata: { kind: "delete_confirm", processed: false },
      },
    });
    await processImmediateMessage(ids.userId, confirm.id, fakeTurn());
    assert.equal(await prisma.user.count({ where: { id: ids.userId } }), 0);
    const kept = await prisma.userMemory.findMany({ where: { userId: other.userId, active: true } });
    assert.equal(kept[0]?.value, "Chicago");
  } finally {
    await cleanup(prisma, ids.userId);
    await cleanup(prisma, other.userId);
  }
});

test("explicit name, work, and pet statements become memories", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { applyExtraction } = await import("@/services/continuity/apply");
  const ids = await seed(prisma, "m2-explicit");
  try {
    await applyExtraction({
      userId: ids.userId,
      sourceMessageId: null,
      extraction: prepareExtraction({
        llm: extraction({}),
        userTexts: ["my name is Alex", "i work in real estate", "i have a golden retriever called Charlie"],
      }),
      now: NOW,
      appTimeZone: ZONE,
    });
    const rows = await prisma.userMemory.findMany({ where: { userId: ids.userId, active: true }, orderBy: { key: "asc" } });
    assert.deepEqual(
      rows.map((row) => ({ type: row.type, key: row.key, value: row.value })),
      [
        { type: "PERSONAL_FACT", key: "name", value: "Alex" },
        { type: "WORK", key: "occupation", value: "real estate" },
        { type: "PET", key: "pet", value: "golden retriever named Charlie" },
      ],
    );
    assert.ok(rows.every((row) => row.confidence >= 0.9 && row.importance >= 0.8));
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("a name alias from the model is accepted instead of dropping the extraction", () => {
  const parsed = parseContinuityExtraction({
    memories: [{ type: "NAME", key: "preferred_name", value: "Alex", confidence: 0.95, importance: 0.9, replacesKey: "" }],
    events: [],
    promises: [],
    timezone: null,
  });
  assert.equal(parsed.memories[0]?.type, "PERSONAL_FACT");
  assert.equal(parsed.memories[0]?.key, "name");
  assert.equal(parsed.memories[0]?.value, "Alex");
  const ignored = prepareExtraction({
    llm: extraction({}),
    userTexts: ["I've been at the hospital all day", "i'm nervous"],
  });
  assert.equal(ignored.memories.length, 0);
});

test("meeting details across messages enrich one event and its follow-up", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { applyExtraction } = await import("@/services/continuity/apply");
  const ids = await seed(prisma, "m2-enrich");
  try {
    const turns = [
      event({ title: "important meeting", relativeDay: "tomorrow", followUpEligible: true }),
      event({ title: "meeting with business partner", relativeDay: "tomorrow", description: "with business partner", followUpEligible: true }),
      event({ title: "meeting", relativeDay: "tomorrow", hour: 11, minute: 0, followUpEligible: true }),
    ];
    for (const item of turns) {
      await applyExtraction({
        userId: ids.userId,
        sourceMessageId: null,
        extraction: extraction({ events: [item] }),
        now: NOW,
        appTimeZone: ZONE,
      });
    }
    const events = await prisma.importantEvent.findMany({ where: { userId: ids.userId } });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.title, "meeting with business partner");
    assert.equal(events[0]?.timeKnown, true);
    assert.equal(events[0]?.eventAt?.toISOString(), "2026-09-23T16:00:00.000Z");
    assert.equal(events[0]?.eventDate, "2026-09-23");
    const followUps = await prisma.followUp.findMany({
      where: { userId: ids.userId, status: "PENDING" },
      orderBy: { scheduledAt: "asc" },
    });
    assert.deepEqual(followUps.map((row) => [row.phase, row.scheduledAt.toISOString()]), [
      ["BEFORE_EVENT", "2026-09-23T15:50:00.000Z"],
      ["AFTER_EVENT", "2026-09-23T16:40:00.000Z"],
    ]);
    assert.equal(events[0]?.description, "with business partner");
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("nervous about it attaches to the recent meeting", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { applyExtraction } = await import("@/services/continuity/apply");
  const ids = await seed(prisma, "m2-pronoun");
  try {
    await applyExtraction({
      userId: ids.userId,
      sourceMessageId: null,
      extraction: extraction({
        events: [event({ title: "important meeting", relativeDay: "tomorrow", hour: 11, minute: 0, followUpEligible: true })],
      }),
      now: NOW,
      appTimeZone: ZONE,
    });
    const update = prepareExtraction({
      llm: extraction({
        events: [event({ title: "job interview", relativeDay: "tomorrow", emotionalContext: "nervous", followUpEligible: true })],
      }),
      userTexts: ["kinda nervous about it tbh"],
      recentUserTexts: ["i have a really important meeting tomorrow at 11"],
      upcomingEvents: [{ title: "important meeting", eventDate: "2026-09-23" }],
    });
    assert.equal(update.events.length, 1);
    assert.equal(update.events[0]?.replacesTitle, "important meeting");
    assert.equal(update.events[0]?.emotionalContext, "nervous");
    await applyExtraction({
      userId: ids.userId,
      sourceMessageId: null,
      extraction: update,
      now: NOW,
      appTimeZone: ZONE,
    });
    const events = await prisma.importantEvent.findMany({ where: { userId: ids.userId } });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.title, "important meeting");
    assert.equal(events[0]?.emotionalContext, "nervous");
    assert.equal(events[0]?.timeKnown, true);
    assert.equal(events[0]?.eventAt?.toISOString(), "2026-09-23T16:00:00.000Z");
    const followUps = await prisma.followUp.findMany({ where: { userId: ids.userId, status: "PENDING" } });
    assert.equal(followUps.length, 2);
    assert.ok(followUps.every((row) => row.eventId === events[0]?.id));
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("the same event extraction does not create a second event or follow-up", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { applyExtraction } = await import("@/services/continuity/apply");
  const ids = await seed(prisma, "m2-same-event");
  try {
    const item = event({ title: "important meeting", relativeDay: "tomorrow", hour: 11, minute: 0, followUpEligible: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await applyExtraction({
        userId: ids.userId,
        sourceMessageId: null,
        extraction: extraction({ events: [item] }),
        now: NOW,
        appTimeZone: ZONE,
      });
    }
    assert.equal(await prisma.importantEvent.count({ where: { userId: ids.userId } }), 1);
    assert.equal(await prisma.followUp.count({ where: { userId: ids.userId, status: "PENDING" } }), 2);
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("a meeting and a flight stay separate", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { applyExtraction } = await import("@/services/continuity/apply");
  const ids = await seed(prisma, "m2-separate");
  try {
    await applyExtraction({
      userId: ids.userId,
      sourceMessageId: null,
      extraction: extraction({
        events: [
          event({ title: "important meeting", relativeDay: "tomorrow", hour: 11, minute: 0, followUpEligible: true }),
          event({ title: "flight to New York", weekday: "friday", hour: 9, minute: 0, followUpEligible: true }),
        ],
      }),
      now: NOW,
      appTimeZone: ZONE,
    });
    const events = await prisma.importantEvent.findMany({ where: { userId: ids.userId }, orderBy: { title: "asc" } });
    assert.deepEqual(events.map((item) => item.title), ["flight to New York", "important meeting"]);
    assert.equal(await prisma.followUp.count({ where: { userId: ids.userId, status: "PENDING" } }), 3);
    assert.equal(await prisma.followUp.count({ where: { userId: ids.userId, phase: "BEFORE_EVENT" } }), 1);
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("an important timed meeting gets a before and after follow-up on the same event", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { applyExtraction } = await import("@/services/continuity/apply");
  const ids = await seed(prisma, "m2-journey");
  try {
    const meeting = event({
      title: "important meeting",
      description: "with business partner",
      relativeDay: "tomorrow",
      hour: 11,
      minute: 0,
      emotionalContext: "nervous",
      followUpEligible: true,
    });
    await applyExtraction({
      userId: ids.userId,
      sourceMessageId: null,
      extraction: extraction({ events: [meeting] }),
      now: NOW,
      appTimeZone: ZONE,
    });
    await applyExtraction({
      userId: ids.userId,
      sourceMessageId: null,
      extraction: extraction({ events: [meeting] }),
      now: NOW,
      appTimeZone: ZONE,
    });
    const saved = await prisma.importantEvent.findFirstOrThrow({ where: { userId: ids.userId } });
    const followUps = await prisma.followUp.findMany({
      where: { userId: ids.userId, status: "PENDING" },
      orderBy: { scheduledAt: "asc" },
    });
    assert.equal(followUps.length, 2);
    assert.ok(followUps.every((row) => row.eventId === saved.id));
    assert.equal(followUps[0]?.phase, "BEFORE_EVENT");
    assert.equal(followUps[0]?.scheduledAt.toISOString(), "2026-09-23T15:50:00.000Z");
    assert.equal(followUps[1]?.phase, "AFTER_EVENT");
    assert.equal(followUps[1]?.scheduledAt.toISOString(), "2026-09-23T16:40:00.000Z");
    assert.match(followUps[0]?.context ?? "", /business partner/);
    assert.doesNotMatch(followUps[0]?.context ?? "", /BEFORE_EVENT|AFTER_EVENT|Reminder/);
    assert.equal(saved.description, "with business partner");
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("a trivial timed event and a date-only event do not invent a before follow-up", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { applyExtraction } = await import("@/services/continuity/apply");
  const ids = await seed(prisma, "m2-trivial");
  try {
    await applyExtraction({
      userId: ids.userId,
      sourceMessageId: null,
      extraction: extraction({
        events: [
          event({ title: "coffee", relativeDay: "tomorrow", hour: 15, minute: 0, followUpEligible: true }),
          event({ title: "errand", relativeDay: "tomorrow", followUpEligible: true }),
        ],
      }),
      now: NOW,
      appTimeZone: ZONE,
    });
    assert.equal(await prisma.followUp.count({ where: { userId: ids.userId, phase: "BEFORE_EVENT" } }), 0);
    assert.equal(await prisma.followUp.count({ where: { userId: ids.userId, status: "PENDING" } }), 2);
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("nervous makes a timed event eligible for both follow-ups", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { applyExtraction } = await import("@/services/continuity/apply");
  const ids = await seed(prisma, "m2-emotion-journey");
  try {
    await applyExtraction({
      userId: ids.userId,
      sourceMessageId: null,
      extraction: extraction({
        events: [event({ title: "coffee", relativeDay: "tomorrow", hour: 15, minute: 0, emotionalContext: "nervous", followUpEligible: true })],
      }),
      now: NOW,
      appTimeZone: ZONE,
    });
    const phases = await prisma.followUp.findMany({ where: { userId: ids.userId }, orderBy: { scheduledAt: "asc" } });
    assert.deepEqual(phases.map((row) => row.phase), ["BEFORE_EVENT", "AFTER_EVENT"]);
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("a reported outcome cancels only the after follow-up", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { cancelResolvedAfterFollowUps, textResolvesEvent } = await import("@/services/continuity/apply");
  const ids = await seed(prisma, "m2-outcome");
  try {
    assert.equal(textResolvesEvent("kinda nervous about it tbh", "important meeting"), false);
    assert.equal(textResolvesEvent("the meeting went well", "important meeting"), true);
    const saved = await prisma.importantEvent.create({
      data: {
        userId: ids.userId,
        title: "important meeting",
        eventAt: new Date("2026-09-22T15:00:00.000Z"),
        eventDate: "2026-09-22",
        timeKnown: true,
        status: "UPCOMING",
        followUpEligible: true,
      },
    });
    await prisma.followUp.create({
      data: {
        userId: ids.userId,
        reasonType: "EVENT",
        phase: "AFTER_EVENT",
        eventId: saved.id,
        context: "ask how it went",
        scheduledAt: new Date("2026-09-22T15:40:00.000Z"),
      },
    });
    await prisma.message.create({
      data: {
        conversationId: ids.conversationId,
        userId: ids.userId,
        direction: "INBOUND",
        sender: "USER",
        type: "TEXT",
        text: "the meeting went well",
        createdAt: new Date("2026-09-22T15:20:00.000Z"),
      },
    });
    await cancelResolvedAfterFollowUps(ids.userId, new Date("2026-09-22T16:00:00.000Z"));
    const followUp = await prisma.followUp.findFirstOrThrow({ where: { eventId: saved.id } });
    assert.equal(followUp.status, "CANCELLED");
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("recent chatting blocks a due follow-up and a same-event pair can still send later", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { runDueFollowUps } = await import("@/services/followups/runDue");
  const { proactiveSendDecision } = await import("@/services/continuity/time");
  const ids = await seed(prisma, "m2-activity");
  let sends = 0;
  try {
    const blocked = proactiveSendDecision({
      now: NOW,
      timeZone: ZONE,
      proactiveCount24h: 0,
      lastProactiveAt: null,
      proactiveEnabled: true,
      aiEnabled: true,
      lastUserMessageAt: new Date(NOW.getTime() - 5 * 60 * 1000),
    });
    assert.equal(blocked.send, false);
    assert.equal(blocked.reason, "user_active");

    const saved = await prisma.importantEvent.create({
      data: {
        userId: ids.userId,
        title: "important meeting",
        eventAt: new Date("2026-09-23T16:00:00.000Z"),
        eventDate: "2026-09-23",
        timeKnown: true,
        status: "UPCOMING",
      },
    });
    const before = await prisma.followUp.create({
      data: {
        userId: ids.userId,
        reasonType: "EVENT",
        phase: "BEFORE_EVENT",
        eventId: saved.id,
        context: "wish luck",
        scheduledAt: new Date(NOW.getTime() - 30 * 60 * 1000),
        status: "SENT",
        sentAt: new Date(NOW.getTime() - 30 * 60 * 1000),
      },
    });
    await prisma.followUp.create({
      data: {
        userId: ids.userId,
        reasonType: "EVENT",
        phase: "AFTER_EVENT",
        eventId: saved.id,
        context: "ask how it went",
        scheduledAt: NOW,
      },
    });
    await prisma.message.create({
      data: {
        conversationId: ids.conversationId,
        userId: ids.userId,
        direction: "OUTBOUND",
        sender: "AMY",
        type: "TEXT",
        text: "good luck",
        createdAt: new Date(NOW.getTime() - 30 * 60 * 1000),
        metadata: { kind: "proactive", followUpIds: [before.id] },
      },
    });
    await prisma.user.update({
      where: { id: ids.userId },
      data: { lastUserMessageAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000) },
    });
    const result = await runDueFollowUps({
      now: NOW,
      appTimeZone: ZONE,
      transport: {
        name: "telegram-bot",
        sendText: async () => {
          sends += 1;
          return { messageId: "journey" };
        },
        sendMedia: async () => {
          throw new Error("unused");
        },
        sendBusinessPhoto: async () => {
          throw new Error("unused");
        },
        sendTyping: async () => undefined,
        identifyUser: () => null,
      },
      generate: async () => ["how was the meeting"],
    });
    assert.equal(result.sentUsers, 1);
    assert.equal(sends, 1);
    const after = await prisma.followUp.findFirstOrThrow({ where: { eventId: saved.id, phase: "AFTER_EVENT" } });
    assert.equal(after.status, "SENT");
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("a partner detail stays on the recent meeting", () => {
  const update = prepareExtraction({
    llm: extraction({}),
    userTexts: ["it's with my business partner"],
    recentUserTexts: ["i have an important meeting tomorrow"],
    upcomingEvents: [{ title: "important meeting", eventDate: "2026-09-23" }],
  });
  assert.equal(update.events[0]?.replacesTitle, "important meeting");
  assert.equal(update.events[0]?.description, "with business partner");
});

test("relationship stage moves only on engagement counts", () => {
  assert.equal(nextRelationshipStage({ current: "NEW", messagesCount: 11, activeDays: 1 }), "NEW");
  assert.equal(nextRelationshipStage({ current: "NEW", messagesCount: 12, activeDays: 1 }), "ACQUAINTANCE");
  assert.equal(nextRelationshipStage({ current: "ACQUAINTANCE", messagesCount: 40, activeDays: 2 }), "ACQUAINTANCE");
  assert.equal(nextRelationshipStage({ current: "ACQUAINTANCE", messagesCount: 40, activeDays: 3 }), "ENGAGED");
  assert.equal(nextRelationshipStage({ current: "ENGAGED", messagesCount: 100, activeDays: 8 }), "CLOSE");
  assert.equal(nextRelationshipStage({ current: "VIP", messagesCount: 5, activeDays: 1 }), "VIP");
  assert.equal(nextRelationshipStage({ current: "CLOSE", messagesCount: 10, activeDays: 1 }), "CLOSE");
});

test("follow-up timing stays after an exact event and away from quiet hours", () => {
  const eventAt = new Date("2026-09-23T15:00:00.000Z");
  const after = planFollowUpAt({ now: NOW, timeZone: ZONE, eventAt, timeKnown: true });
  assert.equal(after.toISOString(), "2026-09-23T17:00:00.000Z");

  const late = planFollowUpAt({
    now: NOW,
    timeZone: ZONE,
    eventAt: new Date("2026-09-23T03:30:00.000Z"),
    timeKnown: true,
  });
  assert.equal(isQuietHour(new Date(new Date("2026-09-23T03:30:00.000Z").getTime() + 2 * 60 * 60 * 1000), ZONE), true);
  assert.equal(late.toISOString(), "2026-09-23T14:00:00.000Z");
});

function extraction(partial: Partial<ContinuityExtraction>): ContinuityExtraction {
  return {
    memories: partial.memories ?? [],
    events: partial.events ?? [],
    promises: partial.promises ?? [],
    timezone: partial.timezone ?? null,
  };
}

function memory(partial: Partial<ContinuityExtraction["memories"][number]>): ContinuityExtraction["memories"][number] {
  return {
    type: partial.type ?? "PERSONAL_FACT",
    key: partial.key ?? "fact",
    value: partial.value ?? "value",
    confidence: partial.confidence ?? 0.9,
    importance: partial.importance ?? 0.7,
    replacesKey: partial.replacesKey ?? null,
  };
}

function event(partial: Partial<ContinuityExtraction["events"][number]>): ContinuityExtraction["events"][number] {
  return {
    title: partial.title ?? "event",
    description: partial.description ?? null,
    relativeDay: partial.relativeDay ?? null,
    weekday: partial.weekday ?? null,
    explicitDate: partial.explicitDate ?? null,
    hour: partial.hour === undefined ? null : partial.hour,
    minute: partial.minute === undefined ? null : partial.minute,
    status: partial.status ?? "UPCOMING",
    emotionalContext: partial.emotionalContext ?? null,
    followUpEligible: partial.followUpEligible ?? false,
    replacesTitle: partial.replacesTitle ?? null,
  };
}

function row(id: string, key: string, value: string, importance: number) {
  return { id, key, value, importance, lastConfirmedAt: NOW };
}

async function seed(
  prisma: typeof import("@/lib/db/prisma").prisma,
  telegramUserId: string,
): Promise<{ userId: string; conversationId: string }> {
  const unique = `${telegramUserId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const user = await prisma.user.create({ data: { telegramUserId: unique, firstName: "Test" } });
  const conversation = await prisma.conversation.create({
    data: { userId: user.id, platform: "telegram", platformConversationId: unique },
  });
  return { userId: user.id, conversationId: conversation.id };
}

async function cleanup(prisma: typeof import("@/lib/db/prisma").prisma, userId: string): Promise<void> {
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
}

function fakeTurn(generate?: () => Promise<string[]>) {
  return {
    generate: async () => (generate ? generate() : ["ok"]),
    send: async (_chatId: string, text: string) => ({ messageId: `sent-${text}` }),
    sleep: async () => undefined,
    delayMs: () => 0,
  };
}

function loadEnv(path: string): void {
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}
