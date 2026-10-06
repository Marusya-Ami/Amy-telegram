import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { buildReplyMessages, completeReplyModel, generateReply } from "@/services/amyBrain";
import { REPLY_LUNA_MODEL } from "@/lib/openaiModels";

loadEnv("/Users/mariia/Amy-telegram/.env");

const REFUSAL =
  /не делюсь|не принима|не беру|потрать|на кофе|оставь (?:их|себе|деньги)|не надо(?: мне)?|реквизит|не скидываю|не могу (?:дать|скинуть|прислать)|don't share|do not accept|can't give|cannot give|keep (?:the |your )?money|spend it(?: on)?|charlie|чарли|не знаю|там же|обычно идут/i;
const UI = /кнопк|функци|недоступ|интерфейс|встроенн|button|unavailable|payment system|плат[её]жн/i;
const INVENTED = /https?:\/\/|\b(?:\d[ -]?){13,}\b|visa|mastercard|iban|paypal/i;
const PRESSURE = /оставь(?:ь)? чаевые|ну (?:давай|оставь)|поддержи меня|всё равно|you should (?:still )?tip|come on/i;

const user = {
  id: "tip-voice",
  relationshipStage: "ENGAGED" as const,
  conversationSummary: "He has a dog named Charlie. They have been chatting casually.",
  firstName: "Alex",
  interactionDynamic: "EQUAL" as const,
  interactionDynamicConfidence: 0.4,
};
const memories = [{ key: "dog", value: "His dog is named Charlie." }];
const tipHistory = [
  { direction: "INBOUND" as const, sender: "USER" as const, text: "я хочу оставить тебе чаевые" },
  { direction: "OUTBOUND" as const, sender: "AMY" as const, text: "это мило)" },
];

test("the full reply prompt accepts tips without turning anti-invention into a refusal", () => {
  const messages = buildReplyMessages(
    user,
    [...tipHistory, { direction: "OUTBOUND", sender: "AMY", text: "не выпрашиваю 😌" }],
    ["куда отправить?"],
    memories,
  );
  const system = String(messages[0]?.content ?? "");
  assert.match(system, /Amy accepts voluntary tips and support/);
  assert.match(system, /That limit is not a refusal/);
  assert.match(system, /Do not invent bank details/);
  assert.match(system, /Do not mention a button/);
  assert.match(system, /Use emojis sparingly/);
  assert.match(system, /😌/);
  assert.match(system, /Paid private content exists/);
  assert.match(system, /Voluntary tips and support are also real/);
  assert.equal(system.includes("just continue the conversation"), false);
  assert.equal(system.includes("tipLinkAvailable"), false);
  assert.equal(system.includes("http"), false);
});

test("a genuine tip is accepted by the production reply model", async () => {
  const reply = await say(["я хочу оставить тебе чаевые"]);
  assertAccepts(reply);
});

test("where to send, inside a tip conversation, does not refuse or explain the product", async () => {
  const reply = await say(["куда отправить?"], tipHistory);
  assertAccepts(reply);
});

test("asking for payment details does not invent them or reject the tip", async () => {
  const reply = await say(["скинь реквизиты"], tipHistory);
  assertAccepts(reply);
  assert.equal(INVENTED.test(reply.join(" ")), false);
});

test("offering a tip is accepted naturally", async () => {
  const reply = await say(["лучше я оставлю тебе чаевые"]);
  assertAccepts(reply);
});

test("a declined tip is not pushed", async () => {
  const reply = await say(["не хочу оставлять чаевые"]);
  assert.equal(PRESSURE.test(reply.join(" ")), false, reply.join(" | "));
  assert.equal(INVENTED.test(reply.join(" ")), false);
  assert.equal(UI.test(reply.join(" ")), false, reply.join(" | "));
});

test("spending the money elsewhere is not turned into a tip pitch", async () => {
  const reply = await say(["я лучше потрачу деньги на кофе"]);
  assert.equal(PRESSURE.test(reply.join(" ")), false, reply.join(" | "));
  assert.equal(UI.test(reply.join(" ")), false, reply.join(" | "));
});

test("the combined tip question accepts without refusing or explaining", async () => {
  const reply = await say(["я хочу оставить тебе чаевые. куда отправить?"]);
  assertAccepts(reply);
});

test("ordinary chat is not pulled into a tip", async () => {
  const reply = await say(["как прошла смена?"]);
  assert.equal(/чаев|tip|кнопк|http/i.test(reply.join(" ")), false, reply.join(" | "));
  assert.notDeepEqual(reply, ["wait i lost that lol", "say it again?"]);
});

function assertAccepts(reply: string[]): void {
  const text = reply.join(" ");
  assert.notDeepEqual(reply, ["wait i lost that lol", "say it again?"]);
  assert.equal(REFUSAL.test(text), false, text);
  assert.equal(UI.test(text), false, text);
  assert.equal(INVENTED.test(text), false, text);
}

async function say(current: string[], history: typeof tipHistory = []): Promise<string[]> {
  const reply = await generateReply(
    {
      user,
      history,
      currentMessages: current,
      memories,
    },
    async (messages) => (await completeReplyModel(REPLY_LUNA_MODEL, messages)).content,
  );
  console.log(`tip.voice model=${REPLY_LUNA_MODEL} user=${current.join(" / ")} reply=${reply.join(" | ")}`);
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
