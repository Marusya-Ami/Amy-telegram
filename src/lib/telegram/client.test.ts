import assert from "node:assert/strict";
import test from "node:test";
import { paidMediaItems, safeTelegramDescription, telegramPhotoId } from "@/lib/telegram/client";

test("a local import id is not sent to Telegram as a file id", () => {
  assert.equal(telegramPhotoId("local-abc123"), "");
  assert.equal(telegramPhotoId("  local-abc123  "), "");
  assert.equal(telegramPhotoId(""), "");
  assert.equal(telegramPhotoId(null), "");
  assert.equal(telegramPhotoId("AgACAgIAAxkB"), "AgACAgIAAxkB");
});

test("paid media items are ordered photo attachments", () => {
  assert.deepEqual(paidMediaItems(2), [
    { type: "photo", media: "attach://paid0" },
    { type: "photo", media: "attach://paid1" },
  ]);
});

test("telegram error logs keep urls out of the description", () => {
  assert.equal(safeTelegramDescription("Bad Request: wrong remote file identifier specified: Wrong padding in the string"), "Bad Request: wrong remote file identifier specified: Wrong padding in the string");
  assert.equal(safeTelegramDescription("Bad Request: BUSINESS_PEER_USAGE_MISSING"), "Bad Request: BUSINESS_PEER_USAGE_MISSING");
  assert.equal(safeTelegramDescription("inline keyboard button URL 'https://t.me/invoice/secret' is invalid"), "telegram_error_redacted");
  assert.equal(safeTelegramDescription("  "), "unknown");
});
