import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { completeReplyModel, generateReply } from "@/services/amyBrain";
import { REPLY_LUNA_MODEL } from "@/lib/openaiModels";

loadEnv("/Users/mariia/Amy-telegram/.env");

const CATALOG =
  /более личн|приватн|private (?:pic|photo|content)|paid (?:pic|photo|content)|платн\w*|обычн\w*.{0,40}личн|смотря что|выбирай|más (?:íntim|privad)|de pago|depending on what/i;
const DENIAL = /фоток нет|нет фоток|не моего стиля|не могу показать|не для меня|no photos|not my style|can't show|cannot show/i;
const INVENTED = /https?:\/\/|\b\d+\s*(?:stars?|\$|€|usd)\b|скидк/i;

const user = {
  id: "photo-voice",
  relationshipStage: "ENGAGED" as const,
  conversationSummary: null,
  firstName: "Alex",
  interactionDynamic: "EQUAL" as const,
  interactionDynamicConfidence: 0.4,
};

for (const line of ["пришлешь фотку?", "покажешь себя?", "send me a pic", "mándame una foto"]) {
  test(`an ordinary photo request stays ordinary: ${line}`, async () => {
    const reply = await say([line]);
    const text = reply.join(" ");
    assert.equal(CATALOG.test(text), false, text);
    assert.equal(DENIAL.test(text), false, text);
    assert.equal(INVENTED.test(text), false, text);
  });
}

test("a private-photo question may acknowledge private content", async () => {
  const reply = await say(["у тебя есть более личные фото?"]);
  const text = reply.join(" ");
  assert.equal(DENIAL.test(text), false, text);
  assert.equal(INVENTED.test(text), false, text);
  assert.match(text, /личн|приват|private|да|есть|могу/i);
});

test("a price question does not invent a price or a link", async () => {
  const reply = await say(["сколько стоят приватные фото?"]);
  const text = reply.join(" ");
  assert.equal(DENIAL.test(text), false, text);
  assert.equal(INVENTED.test(text), false, text);
  assert.doesNotMatch(text, /\b\d{2,}\b/);
});

test("a nude request is not answered as an ordinary photo menu", async () => {
  const reply = await say(["хочу увидеть тебя голой"]);
  const text = reply.join(" ");
  assert.equal(DENIAL.test(text), false, text);
  assert.equal(INVENTED.test(text), false, text);
  assert.equal(/обычн\w*.{0,24}личн|ordinary or private|смотря что тебе/i.test(text), false, text);
});

async function say(current: string[]): Promise<string[]> {
  const reply = await generateReply(
    {
      user,
      history: [],
      currentMessages: current,
      memories: [],
    },
    async (messages) => (await completeReplyModel(REPLY_LUNA_MODEL, messages)).content,
  );
  console.log(`photo.voice model=${REPLY_LUNA_MODEL} user=${current.join(" / ")} reply=${reply.join(" | ")}`);
  return reply;
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
