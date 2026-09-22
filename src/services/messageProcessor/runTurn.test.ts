import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import type { TurnDeps } from "./runTurn";

loadEnv("/Users/mariia/Amy-telegram/.env");

test("one burst becomes one turn with a two-message reply", async () => {
  const { prisma } = await import("../../lib/db/prisma");
  const { processTextBurst } = await import("./runTurn");
  const userA = await seedUser(prisma, "test-m1-burst");
  const delays: number[] = [];
  let generations = 0;

  try {
    await seedText(prisma, userA, ["hey", "are you there", "had a bad day btw"]);
    const deps = fakeDeps(
      async (input) => {
        generations += 1;
        assert.deepEqual(input.currentMessages, ["hey", "are you there", "had a bad day btw"]);
        return ["just here", "tell me what happened"];
      },
      delays,
    );

    await processTextBurst(userA.userId, deps);
    await processTextBurst(userA.userId, deps);

    const outbound = await prisma.message.findMany({
      where: { userId: userA.userId, direction: "OUTBOUND" },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(generations, 1);
    assert.equal(outbound.length, 2);
    assert.deepEqual(
      outbound.map((message) => message.text),
      ["just here", "tell me what happened"],
    );
    assert.equal(delays.length, 1);
    assert.ok(delays[0] >= 700 && delays[0] <= 1800);
    assert.equal(await unprocessedCount(prisma, userA.userId), 0);
  } finally {
    await cleanup(prisma, userA.userId);
  }
});

test("a one-message reply does not wait between bubbles", async () => {
  const { prisma } = await import("../../lib/db/prisma");
  const { processTextBurst } = await import("./runTurn");
  const user = await seedUser(prisma, "test-m1-single");
  const delays: number[] = [];

  try {
    await seedText(prisma, user, ["what are you doing?"]);
    await processTextBurst(
      user.userId,
      fakeDeps(async () => ["just relaxing at home"], delays),
    );
    const outbound = await prisma.message.count({
      where: { userId: user.userId, direction: "OUTBOUND" },
    });
    assert.equal(outbound, 1);
    assert.equal(delays.length, 0);
  } finally {
    await cleanup(prisma, user.userId);
  }
});

test("three outbound bubbles are stored and a fourth is never sent", async () => {
  const { prisma } = await import("../../lib/db/prisma");
  const { processTextBurst } = await import("./runTurn");
  const user = await seedUser(prisma, "test-m1-three");
  const delays: number[] = [];

  try {
    await seedText(prisma, user, ["talk to me"]);
    await processTextBurst(
      user.userId,
      fakeDeps(async () => ["one", "two", "three"], delays),
    );
    const outbound = await prisma.message.findMany({
      where: { userId: user.userId, direction: "OUTBOUND" },
      orderBy: { createdAt: "asc" },
    });
    assert.deepEqual(
      outbound.map((message) => message.text),
      ["one", "two", "three"],
    );
    assert.equal(delays.length, 2);
  } finally {
    await cleanup(prisma, user.userId);
  }
});

test("different users are processed at the same time", async () => {
  const { prisma } = await import("../../lib/db/prisma");
  const { processTextBurst } = await import("./runTurn");
  const first = await seedUser(prisma, "test-m1-parallel-a");
  const second = await seedUser(prisma, "test-m1-parallel-b");
  let active = 0;
  let maxActive = 0;

  try {
    await seedText(prisma, first, ["from a"]);
    await seedText(prisma, second, ["from b"]);
    const started = Date.now();
    await Promise.all([
      processTextBurst(first.userId, slowDeps("reply a", () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        return new Promise((resolve) => setTimeout(() => {
          active -= 1;
          resolve(["reply a"]);
        }, 180));
      })),
      processTextBurst(second.userId, slowDeps("reply b", () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        return new Promise((resolve) => setTimeout(() => {
          active -= 1;
          resolve(["reply b"]);
        }, 180));
      })),
    ]);

    assert.ok(Date.now() - started < 340);
    assert.equal(maxActive, 2);
    const replies = await prisma.message.findMany({
      where: { userId: { in: [first.userId, second.userId] }, direction: "OUTBOUND" },
      select: { text: true },
    });
    assert.deepEqual(replies.map((message) => message.text).sort(), ["reply a", "reply b"]);
  } finally {
    await cleanup(prisma, first.userId);
    await cleanup(prisma, second.userId);
  }
});

function fakeDeps(
  generate: TurnDeps["generate"],
  delays: number[],
): TurnDeps {
  let sequence = 0;
  return {
    generate,
    send: async (_chatId, text) => {
      sequence += 1;
      return { messageId: `sent-${text}-${sequence}` };
    },
    sleep: async (ms) => {
      delays.push(ms);
    },
    delayMs: () => 900,
  };
}

function slowDeps(label: string, generate: TurnDeps["generate"]): TurnDeps {
  return {
    generate,
    send: async () => ({ messageId: `sent-${label}` }),
    sleep: async () => undefined,
    delayMs: () => 700,
  };
}

async function seedUser(
  prisma: typeof import("../../lib/db/prisma").prisma,
  telegramUserId: string,
): Promise<{ userId: string; conversationId: string }> {
  const user = await prisma.user.create({
    data: { telegramUserId, firstName: "Test" },
  });
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      platform: "telegram",
      platformConversationId: telegramUserId,
    },
  });
  return { userId: user.id, conversationId: conversation.id };
}

async function seedText(
  prisma: typeof import("../../lib/db/prisma").prisma,
  ids: { userId: string; conversationId: string },
  texts: string[],
): Promise<void> {
  let offset = 0;
  for (const text of texts) {
    offset += 1;
    await prisma.message.create({
      data: {
        conversationId: ids.conversationId,
        userId: ids.userId,
        direction: "INBOUND",
        sender: "USER",
        type: "TEXT",
        text,
        telegramMessageId: `${ids.userId}-${offset}`,
        metadata: { kind: "text", processed: false },
      },
    });
  }
}

async function unprocessedCount(
  prisma: typeof import("../../lib/db/prisma").prisma,
  userId: string,
): Promise<number> {
  const rows = await prisma.message.findMany({
    where: { userId, direction: "INBOUND" },
    select: { metadata: true },
  });
  return rows.filter((row) => {
    const metadata = row.metadata;
    return !metadata || typeof metadata !== "object" || Array.isArray(metadata) || metadata.processed !== true;
  }).length;
}

async function cleanup(prisma: typeof import("../../lib/db/prisma").prisma, userId: string): Promise<void> {
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
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
