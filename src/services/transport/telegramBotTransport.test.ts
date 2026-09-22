import assert from "node:assert/strict";
import test from "node:test";
import { TransportDeliveryError } from "./messagingTransport";
import { telegramBotTransport } from "./telegramBotTransport";

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

test("media is not implemented on the bot transport yet", async () => {
  await assert.rejects(
    () => telegramBotTransport.sendMedia("42", { kind: "image", source: "photo.jpg" }),
    (error: unknown) => error instanceof TransportDeliveryError && error.retryable === false,
  );
});
