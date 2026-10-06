import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { TransportDeliveryError } from "./messagingTransport";
import { telegramBotTransport } from "./telegramBotTransport";

for (const line of fs.readFileSync("/Users/mariia/Amy-telegram/.env", "utf8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  if (process.env[key]) continue;
  let value = trimmed.slice(eq + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  process.env[key] = value;
}

test("ordinary bot sends omit business_connection_id and business sends include it", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const action = bodies[bodies.length - 1]?.action;
    return new Response(JSON.stringify({ ok: true, result: action ? true : { message_id: 11 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await telegramBotTransport.sendText("42", "hey");
    await telegramBotTransport.sendTyping("42");
    await telegramBotTransport.sendText("77", "hey", { businessConnectionId: "conn-77" });
    await telegramBotTransport.sendTyping("77", { businessConnectionId: "conn-77" });

    assert.equal(bodies[0]?.chat_id, "42");
    assert.equal(bodies[0]?.text, "hey");
    assert.equal("business_connection_id" in (bodies[0] ?? {}), false);
    assert.equal(bodies[1]?.action, "typing");
    assert.equal("business_connection_id" in (bodies[1] ?? {}), false);
    assert.equal(bodies[2]?.business_connection_id, "conn-77");
    assert.equal(bodies[2]?.chat_id, "77");
    assert.equal(bodies[3]?.business_connection_id, "conn-77");
    assert.equal(bodies[3]?.action, "typing");
  } finally {
    globalThis.fetch = original;
  }
});

test("the bot transport identifies a private user without owning conversation logic", () => {
  const identity = telegramBotTransport.identifyUser({
    update_id: 1,
    message: {
      message_id: 4,
      text: "hey",
      chat: { id: 42, type: "private" },
      from: { id: 42, is_bot: false, first_name: "Mia", username: "mia" },
    },
  });

  assert.deepEqual(identity, {
    transport: "telegram-bot",
    transportUserId: "42",
    chatId: "42",
    username: "mia",
    firstName: "Mia",
    lastName: null,
    languageCode: null,
  });
  assert.equal(telegramBotTransport.identifyUser({ update_id: 2 }), null);
});

test("a business photo has no caption and is refused without a business connection", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 21 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => telegramBotTransport.sendBusinessPhoto("77", { businessConnectionId: "  ", telegramFileId: "file-1", bytes: null }),
      (error: unknown) => error instanceof TransportDeliveryError,
    );
    assert.equal(bodies.length, 0);
    const sent = await telegramBotTransport.sendBusinessPhoto("77", {
      businessConnectionId: "conn-77",
      telegramFileId: "file-1",
      bytes: null,
    });
    assert.equal(sent.messageId, "21");
    assert.equal(bodies[0]?.business_connection_id, "conn-77");
    assert.equal(bodies[0]?.chat_id, "77");
    assert.equal(bodies[0]?.photo, "file-1");
    assert.equal("caption" in (bodies[0] ?? {}), false);
  } finally {
    globalThis.fetch = original;
  }
});

test("media is not implemented on the bot transport yet", async () => {
  await assert.rejects(
    () => telegramBotTransport.sendMedia("42", { kind: "image", source: "photo.jpg" }),
    (error: unknown) => error instanceof TransportDeliveryError && error.retryable === false,
  );
});
