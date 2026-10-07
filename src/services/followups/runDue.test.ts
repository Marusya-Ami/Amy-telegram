import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  CONVERSATIONAL_FOLLOWUP_TTL_MS,
  isFollowUpStale,
  MAX_FOLLOWUP_RETRIES,
  RETRY_BACKOFF_MS,
  runDueFollowUps,
} from "@/services/followups/runDue";
import type { MessagingTransport } from "@/services/transport/messagingTransport";

loadEnv("/Users/mariia/Amy-telegram/.env");

const ZONE = "America/Cancun";
const NOW = new Date("2026-09-22T15:00:00.000Z");

test("isFollowUpStale uses createdAt and ignores scheduledAt for OTHER follow-ups", () => {
  const sevenHoursAgo = new Date(NOW.getTime() - 7 * 60 * 60 * 1000);
  assert.equal(
    isFollowUpStale({ createdAt: sevenHoursAgo, reasonType: "OTHER" }, NOW),
    true,
  );
  assert.equal(
    isFollowUpStale({ createdAt: new Date(NOW.getTime() - 5 * 60 * 60 * 1000), reasonType: "OTHER" }, NOW),
    false,
  );
  assert.equal(CONVERSATIONAL_FOLLOWUP_TTL_MS, 6 * 60 * 60 * 1000);
  assert.deepEqual(RETRY_BACKOFF_MS, [15 * 60 * 1000, 30 * 60 * 1000]);
  assert.equal(MAX_FOLLOWUP_RETRIES, 3);
});

test("EVENT follow-ups are exempt from conversational createdAt TTL", () => {
  const sevenHoursAgo = new Date(NOW.getTime() - 7 * 60 * 60 * 1000);
  const futureEvent = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);
  const pastEvent = new Date(NOW.getTime() - 30 * 60 * 1000);
  assert.equal(
    isFollowUpStale({ createdAt: sevenHoursAgo, reasonType: "EVENT", event: { eventAt: futureEvent } }, NOW),
    false,
  );
  assert.equal(
    isFollowUpStale({ createdAt: sevenHoursAgo, reasonType: "EVENT", event: { eventAt: pastEvent } }, NOW),
    false,
  );
  assert.equal(
    isFollowUpStale({ createdAt: sevenHoursAgo, reasonType: "PROMISE" }, NOW),
    false,
  );
});

test("first failed send persists attempt 1 and backs off 15 minutes", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const ids = await seed(prisma, "fu-fail-1");
  try {
    const followUp = await createOther(prisma, ids.userId, { scheduledAt: NOW });
    await runDueFollowUps({ now: NOW, transport: failingTransport(), appTimeZone: ZONE, userId: ids.userId, generate: async () => ["hey"] });
    const row = await prisma.followUp.findUniqueOrThrow({ where: { id: followUp.id } });
    assert.equal(row.status, "PENDING");
    assert.equal(row.sendAttempts, 1);
    assert.equal(row.sentAt, null);
    assert.equal(row.scheduledAt.getTime(), NOW.getTime() + 15 * 60 * 1000);
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("second failed send persists attempt 2 and backs off 30 minutes", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const ids = await seed(prisma, "fu-fail-2");
  try {
    const followUp = await createOther(prisma, ids.userId, { scheduledAt: NOW, sendAttempts: 1 });
    await runDueFollowUps({ now: NOW, transport: failingTransport(), appTimeZone: ZONE, userId: ids.userId, generate: async () => ["hey"] });
    const row = await prisma.followUp.findUniqueOrThrow({ where: { id: followUp.id } });
    assert.equal(row.status, "PENDING");
    assert.equal(row.sendAttempts, 2);
    assert.equal(row.scheduledAt.getTime(), NOW.getTime() + 30 * 60 * 1000);
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("third failed send cancels and does not retry again", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const ids = await seed(prisma, "fu-fail-3");
  try {
    const followUp = await createOther(prisma, ids.userId, { scheduledAt: NOW, sendAttempts: 2 });
    let sends = 0;
    const transport = failingTransport(() => {
      sends += 1;
    });
    await runDueFollowUps({ now: NOW, transport, appTimeZone: ZONE, userId: ids.userId, generate: async () => ["hey"] });
    let row = await prisma.followUp.findUniqueOrThrow({ where: { id: followUp.id } });
    assert.equal(row.status, "CANCELLED");
    assert.equal(row.sendAttempts, 3);
    assert.ok(row.cancelledAt);
    assert.equal(sends, 1);

    await runDueFollowUps({ now: new Date(NOW.getTime() + 60 * 60 * 1000), transport, appTimeZone: ZONE, userId: ids.userId, generate: async () => ["hey"] });
    row = await prisma.followUp.findUniqueOrThrow({ where: { id: followUp.id } });
    assert.equal(row.status, "CANCELLED");
    assert.equal(sends, 1);
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("retry state survives a simulated process restart", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const ids = await seed(prisma, "fu-restart");
  try {
    const followUp = await createOther(prisma, ids.userId, { scheduledAt: NOW });
    await runDueFollowUps({ now: NOW, transport: failingTransport(), appTimeZone: ZONE, userId: ids.userId, generate: async () => ["hey"] });
    const afterFirst = await prisma.followUp.findUniqueOrThrow({ where: { id: followUp.id } });
    assert.equal(afterFirst.sendAttempts, 1);

    const { runDueFollowUps: runAfterRestart } = await import("@/services/followups/runDue");
    const restartNow = new Date(NOW.getTime() + 15 * 60 * 1000);
    await runAfterRestart({
      now: restartNow,
      transport: failingTransport(),
      appTimeZone: ZONE,
      userId: ids.userId,
      generate: async () => ["hey"],
    });
    const afterRestart = await prisma.followUp.findUniqueOrThrow({ where: { id: followUp.id } });
    assert.equal(afterRestart.status, "PENDING");
    assert.equal(afterRestart.sendAttempts, 2);
    assert.equal(afterRestart.scheduledAt.getTime(), restartNow.getTime() + 30 * 60 * 1000);
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("scheduledAt bump does not extend 6-hour createdAt TTL", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const ids = await seed(prisma, "fu-ttl-bump");
  try {
    const sevenHoursAgo = new Date(NOW.getTime() - 7 * 60 * 60 * 1000);
    const followUp = await createOther(prisma, ids.userId, {
      createdAt: sevenHoursAgo,
      scheduledAt: NOW,
    });
    let sent = false;
    await runDueFollowUps({
      now: NOW,
      transport: successTransport(() => {
        sent = true;
      }),
      appTimeZone: ZONE,
      userId: ids.userId,
      generate: async () => ["hey"],
    });
    assert.equal(sent, false);
    const row = await prisma.followUp.findUniqueOrThrow({ where: { id: followUp.id } });
    assert.equal(row.status, "CANCELLED");
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("6-hour expiry is based on createdAt even when scheduledAt is still in the future", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const ids = await seed(prisma, "fu-ttl-future-sched");
  try {
    const sevenHoursAgo = new Date(NOW.getTime() - 7 * 60 * 60 * 1000);
    const followUp = await createOther(prisma, ids.userId, {
      createdAt: sevenHoursAgo,
      scheduledAt: new Date(NOW.getTime() + 2 * 60 * 60 * 1000),
    });
    await runDueFollowUps({
      now: NOW,
      transport: successTransport(),
      appTimeZone: ZONE,
      userId: ids.userId,
      generate: async () => ["hey"],
    });
    const row = await prisma.followUp.findUniqueOrThrow({ where: { id: followUp.id } });
    assert.equal(row.status, "CANCELLED");
    assert.equal(row.cancelledAt?.getTime(), NOW.getTime());
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("EVENT follow-ups remain due past conversational TTL", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const ids = await seed(prisma, "fu-event-ttl");
  try {
    const sevenHoursAgo = new Date(NOW.getTime() - 7 * 60 * 60 * 1000);
    const event = await prisma.importantEvent.create({
      data: {
        userId: ids.userId,
        title: "interview",
        eventAt: new Date(NOW.getTime() + 3 * 60 * 60 * 1000),
        eventDate: "2026-09-22",
        timeKnown: true,
        status: "UPCOMING",
        followUpEligible: true,
      },
    });
    const before = await prisma.followUp.create({
      data: {
        userId: ids.userId,
        reasonType: "EVENT",
        phase: "BEFORE_EVENT",
        eventId: event.id,
        context: "wish luck",
        createdAt: sevenHoursAgo,
        scheduledAt: NOW,
        status: "PENDING",
      },
    });
    const afterEvent = await prisma.importantEvent.create({
      data: {
        userId: ids.userId,
        title: "meeting",
        eventAt: new Date(NOW.getTime() - 20 * 60 * 1000),
        eventDate: "2026-09-22",
        timeKnown: true,
        status: "PAST",
        followUpEligible: true,
      },
    });
    const after = await prisma.followUp.create({
      data: {
        userId: ids.userId,
        reasonType: "EVENT",
        phase: "AFTER_EVENT",
        eventId: afterEvent.id,
        context: "ask how it went",
        createdAt: sevenHoursAgo,
        scheduledAt: NOW,
        status: "PENDING",
      },
    });

    let sent = 0;
    await runDueFollowUps({
      now: NOW,
      transport: successTransport(() => {
        sent += 1;
      }),
      appTimeZone: ZONE,
      userId: ids.userId,
      generate: async () => ["hey"],
    });
    assert.equal(sent, 1);
    const beforeRow = await prisma.followUp.findUniqueOrThrow({ where: { id: before.id } });
    const afterRow = await prisma.followUp.findUniqueOrThrow({ where: { id: after.id } });
    assert.equal(beforeRow.status, "SENT");
    assert.equal(afterRow.status, "SENT");
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("quiet hours reschedule scheduledAt without resetting retry state", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const ids = await seed(prisma, "fu-quiet");
  try {
    const followUp = await createOther(prisma, ids.userId, { scheduledAt: NOW, sendAttempts: 1 });
    let sent = false;
    await runDueFollowUps({
      now: NOW,
      transport: successTransport(() => {
        sent = true;
      }),
      appTimeZone: ZONE,
      userId: ids.userId,
      quietStart: "09:00",
      quietEnd: "11:00",
      generate: async () => ["hey"],
    });
    assert.equal(sent, false);
    const row = await prisma.followUp.findUniqueOrThrow({ where: { id: followUp.id } });
    assert.equal(row.status, "PENDING");
    assert.equal(row.sendAttempts, 1);
    assert.ok(row.scheduledAt.getTime() > NOW.getTime());
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("overlapping cron ticks claim once and do not duplicate sends", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const ids = await seed(prisma, "fu-concurrent");
  try {
    await createOther(prisma, ids.userId, { scheduledAt: NOW });
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport = successTransport(async () => {
      started += 1;
      await gate;
    });
    const input = { now: NOW, transport, appTimeZone: ZONE, userId: ids.userId, generate: async () => ["hey"] };
    const running = Promise.all([runDueFollowUps(input), runDueFollowUps(input)]);
    await waitUntil(() => started === 1);
    release();
    const [first, second] = await running;
    assert.equal(first.sentUsers + second.sentUsers, 1);
    assert.equal(started, 1);
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

test("successful delivery clears pending retry state", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const ids = await seed(prisma, "fu-success-clear");
  try {
    const followUp = await createOther(prisma, ids.userId, { scheduledAt: NOW, sendAttempts: 1 });
    await runDueFollowUps({
      now: NOW,
      transport: successTransport(),
      appTimeZone: ZONE,
      userId: ids.userId,
      generate: async () => ["hey"],
    });
    const row = await prisma.followUp.findUniqueOrThrow({ where: { id: followUp.id } });
    assert.equal(row.status, "SENT");
    assert.equal(row.sendAttempts, 0);
    assert.ok(row.sentAt);
  } finally {
    await cleanup(prisma, ids.userId);
  }
});

function failingTransport(onSend?: () => void): MessagingTransport {
  return {
    name: "telegram-bot",
    sendText: async () => {
      onSend?.();
      throw new Error("BUSINESS_PEER_INVALID");
    },
    sendMedia: async () => {
      throw new Error("unused");
    },
    sendBusinessPhoto: async () => {
      throw new Error("unused");
    },
    sendTyping: async () => undefined,
    identifyUser: () => null,
  };
}

function successTransport(onSend?: () => void | Promise<void>): MessagingTransport {
  return {
    name: "telegram-bot",
    sendText: async () => {
      await onSend?.();
      return { messageId: "ok" };
    },
    sendMedia: async () => {
      throw new Error("unused");
    },
    sendBusinessPhoto: async () => {
      throw new Error("unused");
    },
    sendTyping: async () => undefined,
    identifyUser: () => null,
  };
}

async function createOther(
  prisma: typeof import("@/lib/db/prisma").prisma,
  userId: string,
  extra: { scheduledAt: Date; createdAt?: Date; sendAttempts?: number },
) {
  return prisma.followUp.create({
    data: {
      userId,
      reasonType: "OTHER",
      context: "check in",
      scheduledAt: extra.scheduledAt,
      createdAt: extra.createdAt,
      sendAttempts: extra.sendAttempts ?? 0,
      status: "PENDING",
    },
  });
}

async function seed(prisma: typeof import("@/lib/db/prisma").prisma, telegramUserId: string) {
  const unique = `${telegramUserId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const user = await prisma.user.create({ data: { telegramUserId: unique, firstName: "Test" } });
  await prisma.conversation.create({
    data: { userId: user.id, platform: "telegram", platformConversationId: unique },
  });
  return { userId: user.id };
}

async function cleanup(prisma: typeof import("@/lib/db/prisma").prisma, userId: string) {
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
