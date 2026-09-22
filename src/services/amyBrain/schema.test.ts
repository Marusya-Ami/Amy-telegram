import assert from "node:assert/strict";
import test from "node:test";
import { ZodError } from "zod";
import { parseAmyReply } from "./schema";

test("accepts one, two, and three chat messages", () => {
  assert.deepEqual(parseAmyReply({ messages: ["hey"] }).messages, ["hey"]);
  assert.deepEqual(parseAmyReply({ messages: ["just relaxing at home", "come keep me company then"] }).messages, [
    "just relaxing at home",
    "come keep me company then",
  ]);
  assert.equal(parseAmyReply({ messages: ["one", "two", "three"] }).messages.length, 3);
});

test("rejects empty messages and more than three", () => {
  assert.throws(() => parseAmyReply({ messages: [] }), ZodError);
  assert.throws(() => parseAmyReply({ messages: ["ok", " "] }), ZodError);
  assert.throws(() => parseAmyReply({ messages: ["", "still no"] }), ZodError);
  assert.throws(() => parseAmyReply({ messages: ["1", "2", "3", "4"] }), ZodError);
  assert.throws(() => parseAmyReply({ reply: "old shape" }), ZodError);
});
