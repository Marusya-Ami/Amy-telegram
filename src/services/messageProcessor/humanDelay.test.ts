import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { bumpTurnEpoch, humanReplyDelayMode, humanReplyDelayMs, splitHumanDelay, turnEpoch, waitForHumanReply } from "./humanDelay";
import type { TurnDeps } from "./runTurn";

loadEnv("/Users/mariia/Amy-telegram/.env");

test("reply delay stays inside each length band and under 20 seconds", () => {
  for (const random of [() => 0, () => 0.999]) {
    assert.ok(inRange(humanReplyDelayMs(20, random), 5_000, 9_000));
    assert.ok(inRange(humanReplyDelayMs(50, random), 6_000, 12_000));
    assert.ok(inRange(humanReplyDelayMs(120, random), 8_000, 15_000));
    assert.ok(inRange(humanReplyDelayMs(240, random), 10_000, 18_000));
    assert.ok(humanReplyDelayMs(400, random) <= 20_000);
  }
});

test("the typing window is only the latter part of the delay", () => {
  const split = splitHumanDelay(8_000, () => 0);
  assert.equal(split.silenceMs, 3_600);
  assert.equal(split.typingMs, 4_400);
  assert.ok(split.silenceMs < 8_000 * 0.7);
});

test("delay mode is off unless the value is exactly live", () => {
  assert.equal(humanReplyDelayMode(undefined), "off");
  assert.equal(humanReplyDelayMode(""), "off");
  assert.equal(humanReplyDelayMode("LIVE"), "off");
  assert.equal(humanReplyDelayMode("live"), "live");
});

test("delay mode off does not sleep", async () => {
  const userId = "delay-off-user";
  const epoch = bumpTurnEpoch(userId);
  let slept = 0;
  const decision = await waitForHumanReply({
    userId,
    replyChars: 200,
    epochAtStart: epoch,
    mode: "off",
    sleep: async () => {
      slept += 1;
    },
  });
  assert.equal(decision, "send");
  assert.equal(slept, 0);
});

test("a live delay sleeps on a fake timer and types only after the silence", async () => {
  const userId = "delay-live-user";
  const epoch = bumpTurnEpoch(userId);
  const events: string[] = [];
  const decision = await waitForHumanReply({
    userId,
    replyChars: 10,
    epochAtStart: epoch,
    mode: "live",
    random: () => 0,
    sleep: async (ms) => {
      events.push(`sleep:${ms}`);
    },
    typing: async () => {
      events.push("typing");
    },
  });
  assert.equal(decision, "send");
  assert.deepEqual(events, ["sleep:2250", "typing", "sleep:2750"]);
  assert.ok(events[0].startsWith("sleep:"));
  assert.ok(events.indexOf("typing") > 0);
});

test("a multi-bubble reply waits once before the first bubble", async () => {
  const { prisma } = await import("../../lib/db/prisma");
  const { processTextBurst } = await import("./runTurn");
  const user = await seedUser(prisma, "delay-multi");
  const events: string[] = [];
  try {
    await seedText(prisma, user, "hey");
    await processTextBurst(user.userId, {
      generate: async () => ["one", "two"],
      send: async (_chat, text) => {
        events.push(`send:${text}`);
        return { messageId: text };
      },
      sleep: async (ms) => {
        events.push(`gap:${ms}`);
      },
      delayMs: () => 900,
      waitBeforeReply: async () => {
        events.push("human");
        return "send";
      },
    });
    assert.deepEqual(events, ["human", "send:one", "gap:900", "send:two"]);
  } finally {
    await cleanup(prisma, user.userId);
  }
});

test("a start command does not use the human delay", async () => {
  const { prisma } = await import("../../lib/db/prisma");
  const { processImmediateMessage } = await import("./runTurn");
  const user = await seedUser(prisma, "delay-start");
  try {
    const message = await prisma.message.create({
      data: {
        conversationId: user.conversationId,
        userId: user.userId,
        direction: "INBOUND",
        sender: "USER",
        type: "TEXT",
        text: "/start",
        telegramMessageId: `${user.userId}-start`,
        metadata: { kind: "start", processed: false },
      },
    });
    await processImmediateMessage(user.userId, message.id, {
      generate: async () => ["nope"],
      send: async () => ({ messageId: "start-sent" }),
      sleep: async () => undefined,
      delayMs: () => 900,
      waitBeforeReply: async () => {
        throw new Error("start should not wait");
      },
    });
    const outbound = await prisma.message.findFirst({ where: { userId: user.userId, direction: "OUTBOUND" } });
    assert.match(outbound?.text ?? "", /I'm Amy/);
  } finally {
    await cleanup(prisma, user.userId);
  }
});

test("pre-checkout does not wait on the human reply delay", async () => {
  const { handlePreCheckoutQuery } = await import("../payments/telegramStars");
  const started = Date.now();
  await handlePreCheckoutQuery(
    {
      id: "pre-1",
      from: { id: 1, is_bot: false, first_name: "A" },
      currency: "XTR",
      total_amount: 1,
      invoice_payload: "not-a-real-payload",
    },
    { answerPreCheckout: async () => undefined },
  );
  assert.ok(Date.now() - started < 8_000);
  const source = fs.readFileSync(new URL("../payments/telegramStars.ts", import.meta.url), "utf8");
  assert.equal(source.includes("humanReplyDelay"), false);
});

test("one user's delay does not block another user", async () => {
  const { prisma } = await import("../../lib/db/prisma");
  const { processTextBurst } = await import("./runTurn");
  const first = await seedUser(prisma, "delay-a");
  const second = await seedUser(prisma, "delay-b");
  let active = 0;
  let maxActive = 0;
  let release: () => void = () => undefined;
  const both = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wait: TurnDeps["waitBeforeReply"] = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (maxActive >= 2) release();
    await Promise.race([both, new Promise((resolve) => setTimeout(resolve, 2000))]);
    active -= 1;
    return "send";
  };
  try {
    await seedText(prisma, first, "from a");
    await seedText(prisma, second, "from b");
    await Promise.all([
      processTextBurst(first.userId, baseDeps(wait, async () => ["a"])),
      processTextBurst(second.userId, baseDeps(wait, async () => ["b"])),
    ]);
    assert.equal(maxActive, 2);
  } finally {
    await cleanup(prisma, first.userId);
    await cleanup(prisma, second.userId);
  }
});

test("two users can understand photos at the same time", async () => {
  const { prisma } = await import("../../lib/db/prisma");
  const { processTextBurst } = await import("./runTurn");
  const first = await seedUser(prisma, "vision-a");
  const second = await seedUser(prisma, "vision-b");
  let active = 0;
  let maxActive = 0;
  let release: () => void = () => undefined;
  const both = new Promise<void>((resolve) => {
    release = resolve;
  });
  const understand: TurnDeps["understandCustomerPhotos"] = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (maxActive >= 2) release();
    await Promise.race([both, new Promise((resolve) => setTimeout(resolve, 2000))]);
    active -= 1;
    return "subject: a desk";
  };
  try {
    await seedPhoto(prisma, first, "file-a");
    await seedPhoto(prisma, second, "file-b");
    await Promise.all([
      processTextBurst(first.userId, { ...baseDeps(async () => "send", async () => ["a"]), understandCustomerPhotos: understand }),
      processTextBurst(second.userId, { ...baseDeps(async () => "send", async () => ["b"]), understandCustomerPhotos: understand }),
    ]);
    assert.equal(maxActive, 2);
  } finally {
    await cleanup(prisma, first.userId);
    await cleanup(prisma, second.userId);
  }
});

test("a newer inbound during the first-response delay cancels the stale turn", async () => {
  const { prisma } = await import("../../lib/db/prisma");
  const { processTextBurst } = await import("./runTurn");
  const user = await seedUser(prisma, "stale-turn");
  let observed = 0;
  let sent = 0;
  try {
    await seedText(prisma, user, "first thought", 1);
    const first = await processTextBurst(user.userId, {
      generate: async () => ["old reply"],
      send: async () => {
        sent += 1;
        return { messageId: "should-not-send" };
      },
      sleep: async () => undefined,
      delayMs: () => 900,
      observeSales: async () => {
        observed += 1;
      },
      waitBeforeReply: async () => {
        await seedText(prisma, user, "second thought", 2);
        bumpTurnEpoch(user.userId);
        return "stale";
      },
    });
    assert.equal(first, false);
    assert.equal(sent, 0);
    assert.equal(observed, 0);
    const pending = await prisma.message.count({ where: { userId: user.userId, direction: "OUTBOUND" } });
    assert.equal(pending, 0);

    let current: string[] = [];
    await processTextBurst(user.userId, {
      generate: async (input) => {
        current = input.currentMessages;
        return ["fresh reply"];
      },
      send: async () => ({ messageId: "fresh" }),
      sleep: async () => undefined,
      delayMs: () => 900,
      waitBeforeReply: async () => "send",
    });
    assert.deepEqual(current, ["first thought", "second thought"]);
    const outbound = await prisma.message.findFirst({ where: { userId: user.userId, direction: "OUTBOUND" } });
    assert.equal(outbound?.text, "fresh reply");
  } finally {
    await cleanup(prisma, user.userId);
  }
});

test("a bump after the first bubble does not retract it", async () => {
  const { prisma } = await import("../../lib/db/prisma");
  const { processTextBurst } = await import("./runTurn");
  const user = await seedUser(prisma, "stale-after-send");
  try {
    await seedText(prisma, user, "hey");
    await processTextBurst(user.userId, {
      generate: async () => ["one", "two"],
      send: async (_chat, text) => {
        if (text === "one") bumpTurnEpoch(user.userId);
        return { messageId: text };
      },
      sleep: async () => undefined,
      delayMs: () => 900,
      waitBeforeReply: async () => "send",
    });
    const outbound = await prisma.message.findMany({
      where: { userId: user.userId, direction: "OUTBOUND" },
      orderBy: { createdAt: "asc" },
    });
    assert.deepEqual(outbound.map((message) => message.text), ["one", "two"]);
  } finally {
    await cleanup(prisma, user.userId);
  }
});

test("free media and tips are considered only after the delivered reply", async () => {
  const { prisma } = await import("../../lib/db/prisma");
  const { processTextBurst } = await import("./runTurn");
  const user = await seedUser(prisma, "delay-actions");
  const events: string[] = [];
  try {
    await seedText(prisma, user, "покажешь фотку?");
    await processTextBurst(user.userId, {
      generate: async () => ["maybe"],
      send: async () => {
        events.push("reply");
        return { messageId: "reply-1" };
      },
      sleep: async () => undefined,
      delayMs: () => 900,
      waitBeforeReply: async () => {
        events.push("human");
        return "send";
      },
      observeSales: async () => {
        events.push("action");
      },
    });
    assert.deepEqual(events, ["human", "reply", "action"]);
  } finally {
    await cleanup(prisma, user.userId);
  }
});

test("a cancelled turn does not run backend actions", async () => {
  const { prisma } = await import("../../lib/db/prisma");
  const { processTextBurst } = await import("./runTurn");
  const user = await seedUser(prisma, "stale-actions");
  let observed = 0;
  try {
    await seedText(prisma, user, "send me a pic");
    await processTextBurst(user.userId, {
      generate: async () => ["sure"],
      send: async () => {
        throw new Error("stale reply must not send");
      },
      sleep: async () => undefined,
      delayMs: () => 900,
      observeSales: async () => {
        observed += 1;
      },
      waitBeforeReply: async () => {
        bumpTurnEpoch(user.userId);
        return "stale";
      },
    });
    assert.equal(observed, 0);
  } finally {
    await cleanup(prisma, user.userId);
  }
});

test("text-only turns still reply when delay mode is off", async () => {
  assert.equal(humanReplyDelayMode(process.env["HUMAN_REPLY_DELAY_MODE"]), "off");
  const { prisma } = await import("../../lib/db/prisma");
  const { processTextBurst } = await import("./runTurn");
  const user = await seedUser(prisma, "text-only-off");
  const sleeps: number[] = [];
  try {
    await seedText(prisma, user, "hello");
    await processTextBurst(user.userId, {
      generate: async () => ["hi"],
      send: async () => ({ messageId: "hi-1" }),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      delayMs: () => 900,
    });
    assert.deepEqual(sleeps, []);
    const outbound = await prisma.message.findFirst({ where: { userId: user.userId, direction: "OUTBOUND" } });
    assert.equal(outbound?.text, "hi");
  } finally {
    await cleanup(prisma, user.userId);
  }
});

test("an epoch change during the live pause marks the reply stale", async () => {
  const userId = "epoch-live";
  const epoch = bumpTurnEpoch(userId);
  let typed = false;
  const decision = await waitForHumanReply({
    userId,
    replyChars: 10,
    epochAtStart: epoch,
    mode: "live",
    random: () => 0,
    sleep: async () => {
      bumpTurnEpoch(userId);
    },
    typing: async () => {
      typed = true;
    },
  });
  assert.equal(decision, "stale");
  assert.equal(typed, false);
  assert.ok(turnEpoch(userId) > epoch);
});

function inRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

function baseDeps(wait: TurnDeps["waitBeforeReply"], generate: TurnDeps["generate"]): TurnDeps {
  return {
    generate,
    send: async () => ({ messageId: "sent" }),
    sleep: async () => undefined,
    delayMs: () => 700,
    waitBeforeReply: wait,
  };
}

async function seedUser(prisma: typeof import("../../lib/db/prisma").prisma, telegramUserId: string) {
  const user = await prisma.user.create({ data: { telegramUserId, firstName: "Test" } });
  const conversation = await prisma.conversation.create({
    data: { userId: user.id, platform: "telegram", platformConversationId: telegramUserId },
  });
  return { userId: user.id, conversationId: conversation.id };
}

async function seedText(
  prisma: typeof import("../../lib/db/prisma").prisma,
  ids: { userId: string; conversationId: string },
  text: string,
  order = 1,
) {
  await prisma.message.create({
    data: {
      conversationId: ids.conversationId,
      userId: ids.userId,
      direction: "INBOUND",
      sender: "USER",
      type: "TEXT",
      text,
      telegramMessageId: `${ids.userId}-t-${order}-${text.length}`,
      createdAt: new Date(Date.UTC(2026, 0, 2, 0, 0, order)),
      metadata: { kind: "text", processed: false },
    },
  });
}

async function seedPhoto(
  prisma: typeof import("../../lib/db/prisma").prisma,
  ids: { userId: string; conversationId: string },
  fileId: string,
) {
  await prisma.message.create({
    data: {
      conversationId: ids.conversationId,
      userId: ids.userId,
      direction: "INBOUND",
      sender: "USER",
      type: "IMAGE",
      telegramMessageId: `${ids.userId}-photo`,
      metadata: { kind: "photo", processed: false, photoFileId: fileId },
    },
  });
}

async function cleanup(prisma: typeof import("../../lib/db/prisma").prisma, userId: string) {
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}
