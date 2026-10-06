import assert from "node:assert/strict";
import test from "node:test";
import type { TurnDeps } from "./runTurn";

test("ordinary bot message still enters the same pipeline", async () => {
  const { prisma } = await import("../../lib/db/prisma");
  const { ingestTelegramUpdate } = await import("./index");
  const sender = uniqueId();
  const updateId = uniqueId();
  const scheduled: string[] = [];

  try {
    await ingestTelegramUpdate(privateMessage(updateId, sender, "hey"), {
      scheduleInbound: (_userId, _messageId, kind) => scheduled.push(kind),
    });

    const user = await prisma.user.findUniqueOrThrow({ where: { telegramUserId: sender } });
    const conversations = await prisma.conversation.findMany({ where: { userId: user.id } });
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0]?.platform, "telegram");
    assert.equal(conversations[0]?.businessConnectionId, null);
    assert.deepEqual(scheduled, ["text"]);
  } finally {
    await cleanup(sender, [updateId]);
  }
});

test("business_message uses the sender id and the same inbound pipeline", async () => {
  const { prisma } = await import("../../lib/db/prisma");
  const { ingestTelegramUpdate } = await import("./index");
  const sender = uniqueId();
  const botUpdateId = uniqueId();
  const businessUpdateId = uniqueId();
  const scheduled: string[] = [];

  try {
    await ingestTelegramUpdate(privateMessage(botUpdateId, sender, "from the bot chat"), {
      scheduleInbound: (_userId, _messageId, kind) => scheduled.push(kind),
    });
    await ingestTelegramUpdate(businessMessage(businessUpdateId, sender, "from amy's account", "conn-live"), {
      scheduleInbound: (_userId, _messageId, kind) => scheduled.push(kind),
    });

    const users = await prisma.user.findMany({ where: { telegramUserId: sender } });
    assert.equal(users.length, 1);
    const conversations = await prisma.conversation.findMany({
      where: { userId: users[0].id },
      orderBy: { platform: "asc" },
    });
    assert.deepEqual(
      conversations.map((conversation) => ({
        platform: conversation.platform,
        businessConnectionId: conversation.businessConnectionId,
      })),
      [
        { platform: "telegram", businessConnectionId: null },
        { platform: "telegram-business", businessConnectionId: "conn-live" },
      ],
    );
    assert.deepEqual(scheduled, ["text", "text"]);
  } finally {
    await cleanup(sender, [botUpdateId, businessUpdateId]);
  }
});

test("a business conversation reply includes business_connection_id and a bot reply does not", async () => {
  const { prisma } = await import("../../lib/db/prisma");
  const { processTextBurst } = await import("./runTurn");
  const sender = uniqueId();
  const calls: Array<{ chatId: string; context?: { businessConnectionId?: string | null } }> = [];

  try {
    const user = await prisma.user.create({ data: { telegramUserId: sender, firstName: "Test" } });
    const business = await prisma.conversation.create({
      data: {
        userId: user.id,
        platform: "telegram-business",
        platformConversationId: sender,
        businessConnectionId: "conn-reply",
      },
    });
    await prisma.message.create({
      data: {
        conversationId: business.id,
        userId: user.id,
        direction: "INBOUND",
        sender: "USER",
        type: "TEXT",
        text: "hello amy",
        telegramMessageId: `${sender}-1`,
        metadata: { kind: "text", processed: false },
      },
    });

    await processTextBurst(user.id, spyDeps(calls));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.chatId, sender);
    assert.equal(calls[0]?.context?.businessConnectionId, "conn-reply");

    await prisma.message.deleteMany({ where: { userId: user.id } });
    const bot = await prisma.conversation.create({
      data: { userId: user.id, platform: "telegram", platformConversationId: `${sender}-bot` },
    });
    await prisma.message.create({
      data: {
        conversationId: bot.id,
        userId: user.id,
        direction: "INBOUND",
        sender: "USER",
        type: "TEXT",
        text: "hello bot",
        telegramMessageId: `${sender}-2`,
        metadata: { kind: "text", processed: false },
      },
    });
    calls.length = 0;
    await processTextBurst(user.id, spyDeps(calls));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.context, undefined);
  } finally {
    await cleanup(sender, []);
  }
});

test("business_connection does not schedule an Amy reply", async () => {
  const { prisma } = await import("../../lib/db/prisma");
  const { ingestTelegramUpdate } = await import("./index");
  const updateId = uniqueId();
  const businessUserId = uniqueId();
  const connectionId = `conn-${updateId}`;
  const scheduled: string[] = [];

  try {
    await ingestTelegramUpdate(
      {
        update_id: Number(updateId),
        business_connection: {
          id: connectionId,
          user: { id: Number(businessUserId), is_bot: false, first_name: "Amy" },
          user_chat_id: Number(businessUserId),
          is_enabled: true,
          rights: { can_reply: true, can_read_messages: true },
        },
      },
      { scheduleInbound: () => scheduled.push("scheduled") },
    );

    assert.deepEqual(scheduled, []);
    assert.equal(await prisma.user.findUnique({ where: { telegramUserId: businessUserId } }), null);
    const stored = await prisma.businessConnection.findUniqueOrThrow({ where: { connectionId } });
    assert.equal(stored.isEnabled, true);
    assert.equal(stored.canReply, true);
    assert.equal(await prisma.message.count({ where: { telegramMessageId: updateId } }), 0);
  } finally {
    await prisma.businessConnection.deleteMany({ where: { connectionId } });
    await prisma.telegramUpdate.deleteMany({ where: { updateId } });
  }
});

test("edited and deleted business messages do not create a response", async () => {
  const { prisma } = await import("../../lib/db/prisma");
  const { ingestTelegramUpdate } = await import("./index");
  const sender = uniqueId();
  const editedId = uniqueId();
  const deletedId = uniqueId();
  const scheduled: string[] = [];

  try {
    await ingestTelegramUpdate(
      {
        update_id: Number(editedId),
        edited_business_message: {
          message_id: 4,
          text: `edited-${editedId}`,
          business_connection_id: "conn-edit",
          chat: { id: Number(sender), type: "private" },
          from: { id: Number(sender), is_bot: false },
        },
      },
      { scheduleInbound: () => scheduled.push("edited") },
    );
    await ingestTelegramUpdate(
      {
        update_id: Number(deletedId),
        deleted_business_messages: {
          business_connection_id: "conn-edit",
          chat: { id: Number(sender), type: "private" },
          message_ids: [4, 5],
        },
      },
      { scheduleInbound: () => scheduled.push("deleted") },
    );

    assert.deepEqual(scheduled, []);
    assert.equal(await prisma.user.findUnique({ where: { telegramUserId: sender } }), null);
    assert.equal(await prisma.message.count({ where: { text: `edited-${editedId}` } }), 0);
  } finally {
    await cleanup(sender, [editedId, deletedId]);
  }
});

test("a duplicate business update is idempotent", async () => {
  const { prisma } = await import("../../lib/db/prisma");
  const { ingestTelegramUpdate } = await import("./index");
  const sender = uniqueId();
  const updateId = uniqueId();
  let scheduled = 0;
  const payload = businessMessage(updateId, sender, "once", "conn-once");

  try {
    await ingestTelegramUpdate(payload, { scheduleInbound: () => { scheduled += 1; } });
    await ingestTelegramUpdate(payload, { scheduleInbound: () => { scheduled += 1; } });

    const user = await prisma.user.findUniqueOrThrow({ where: { telegramUserId: sender } });
    const messages = await prisma.message.count({ where: { userId: user.id, direction: "INBOUND" } });
    assert.equal(messages, 1);
    assert.equal(scheduled, 1);
  } finally {
    await cleanup(sender, [updateId]);
  }
});

function privateMessage(updateId: string, sender: string, text: string) {
  const id = Number(sender);
  return {
    update_id: Number(updateId),
    message: {
      message_id: Number(updateId),
      text,
      chat: { id, type: "private" },
      from: { id, is_bot: false, first_name: "Tester" },
    },
  };
}

function businessMessage(updateId: string, sender: string, text: string, connectionId: string) {
  const id = Number(sender);
  return {
    update_id: Number(updateId),
    business_message: {
      message_id: Number(updateId),
      text,
      business_connection_id: connectionId,
      chat: { id, type: "private" },
      from: { id, is_bot: false, first_name: "Tester" },
    },
  };
}

function spyDeps(calls: Array<{ chatId: string; context?: { businessConnectionId?: string | null } }>): TurnDeps {
  return {
    generate: async () => ["hey"],
    send: async (chatId, _text, context) => {
      calls.push({ chatId, context });
      return { messageId: `sent-${calls.length}` };
    },
    sleep: async () => undefined,
    delayMs: () => 0,
  };
}

function uniqueId(): string {
  return String(8_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
}

async function cleanup(telegramUserId: string, updateIds: string[]): Promise<void> {
  const { prisma } = await import("../../lib/db/prisma");
  const user = await prisma.user.findUnique({ where: { telegramUserId } });
  if (user) await prisma.user.delete({ where: { id: user.id } });
  if (updateIds.length > 0) await prisma.telegramUpdate.deleteMany({ where: { updateId: { in: updateIds } } });
}
