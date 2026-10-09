import assert from "node:assert/strict";
import test from "node:test";
import { amyProfilePrompt } from "@/prompts/amy-profile";
import { AMY_PERSONALITY_PROMPT } from "@/prompts/amy-personality";
import { buildReplyMessages, generateReply } from "@/services/amyBrain";
import { replyBreaksPhotoCapability, replyInventsTextOnlyLimitation } from "@/services/amyBrain/capability";
import { endsWithChatFiller, recentFillerNote, replyRepeatsTerminalFiller } from "@/services/amyBrain/voice";
import { salesEngineMode } from "@/services/sales/mode";

const PRIOR_DENIALS = [
  { direction: "INBOUND" as const, sender: "USER" as const, text: "У тебя есть приватные фото для меня?" },
  { direction: "OUTBOUND" as const, sender: "AMY" as const, text: "фоток нет, но могу поделиться мыслями" },
  { direction: "INBOUND" as const, sender: "USER" as const, text: "Я хочу посмотреть на тебя" },
  { direction: "OUTBOUND" as const, sender: "AMY" as const, text: "не могу показать, но могу рассказать о себе" },
  { direction: "INBOUND" as const, sender: "USER" as const, text: "Даже платно нет?" },
  { direction: "OUTBOUND" as const, sender: "AMY" as const, text: "нет, это не для меня" },
];

for (const line of [
  "никаких сексульных фоточек?",
  "Я хочу посмотреть на тебя",
  "у тебя есть приватные фото?",
  "даже платно есть?",
  "покажешь фотку?",
  "есть что-нибудь погорячее?",
]) {
  test(`the live reply prompt allows a photo answer for: ${line}`, () => {
    const system = systemFor(line);
    assert.match(system, /adult sexy photos/);
    assert.match(system, /that earlier text was wrong/);
    assert.match(system, /Do not name a price/);
    assert.match(system, /checkout link/);
    assert.match(system, /specific paid set/);
    assert.match(system, /not sending one and not a sale/);
    assert.match(system, /This biography does not limit photos/);
    assert.doesNotMatch(system, /do not offer photos/i);
  });
}

test("the exact production denials are rejected by the reply path", () => {
  assert.equal(replyBreaksPhotoCapability(["нет, не моего стиля. давай лучше обсудим что-то забавное!"]), true);
  assert.equal(replyBreaksPhotoCapability(["мне это не подходит. лучше расскажи о себе"]), true);
  assert.equal(replyBreaksPhotoCapability(["фоток нет"]), true);
  assert.equal(replyBreaksPhotoCapability(["не могу показать"]), true);
  assert.equal(replyBreaksPhotoCapability(["нет, это не для меня"]), true);
  assert.equal(replyBreaksPhotoCapability(["https://t.me/invoice/test"]), true);
  assert.equal(replyBreaksPhotoCapability(["это 420 stars"]), true);
  assert.equal(replyBreaksPhotoCapability(["может и есть"]), false);
  assert.equal(replyBreaksPhotoCapability(["i can only text right now"]), true);
  assert.equal(replyInventsTextOnlyLimitation(["i can only text right now"]), true);
  assert.equal(replyInventsTextOnlyLimitation(["solo puedo enviar texto"]), true);
  assert.equal(replyInventsTextOnlyLimitation(["Atlanta would be a pretty long commute for me lol"]), false);
});

test("a categorical photo denial is not what gets sent", async () => {
  let calls = 0;
  const reply = await generateReply(input("никаких сексульных фоточек?"), async () => {
    calls += 1;
    if (calls === 1) return JSON.stringify({ messages: ["нет, не моего стиля. давай лучше обсудим что-то забавное!"] });
    return JSON.stringify({ messages: ["может и есть"] });
  });
  assert.equal(calls, 2);
  assert.equal(replyBreaksPhotoCapability(reply), false);
  assert.deepEqual(reply, ["может и есть"]);
});

test("wanting to see Amy does not send a not-for-me refusal", async () => {
  const reply = await generateReply(input("Я хочу посмотреть на тебя"), async (messages) => {
    const correction = messages.some((message) => message.role === "system" && String(message.content).includes("falsely denied"));
    return JSON.stringify({ messages: [correction ? "любопытный какой" : "мне это не подходит"] });
  });
  assert.equal(replyBreaksPhotoCapability(reply), false);
  assert.equal(reply.some((line) => /https?:\/\//.test(line) || /\d+\s*stars/i.test(line)), false);
});

test("ordinary conversation is not rewritten", async () => {
  let calls = 0;
  const reply = await generateReply(
    {
      ...input("hey, how was work?"),
      history: [],
    },
    async () => {
      calls += 1;
      return JSON.stringify({ messages: ["long shift, i'm tired"] });
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(reply, ["long shift, i'm tired"]);
});

test("profile facts and sales mode stay as they were", () => {
  assert.match(amyProfilePrompt(), /Amy/);
  assert.match(amyProfilePrompt(), /22|Age: 22/);
  assert.match(AMY_PERSONALITY_PROMPT, /Do not invent a sexual or power dynamic/);
  assert.equal(salesEngineMode("shadow"), "shadow");
  assert.equal(salesEngineMode("live"), "off");
});

for (const line of [
  "куда отправить чаевые?",
  "кнопки нет",
  "куда отправить?",
  "скинь ссылку",
  "как купить приватные фото?",
  "покажешь фотку?",
  "hey, how was work?",
]) {
  test(`Amy is not told to narrate product UI for: ${line}`, () => {
    const system = systemFor(line);
    assert.match(system, /Talk like a person/);
    assert.match(system, /Do not mention a button/);
    assert.match(system, /Do not say a feature is unavailable/);
    assert.match(system, /Do not invent bank details/);
    assert.match(system, /ordinary photos of yourself/);
    assert.match(system, /Paid private content exists/);
    assert.match(system, /not a menu/);
    assert.match(system, /Do not mention private, personal, or paid photos/);
    assert.match(system, /Use emojis sparingly/);
    assert.match(system, /One bubble is the normal reply/);
    assert.equal(system.includes("tipLinkAvailable"), false);
    assert.equal(system.includes("leave it here"), false);
    assert.equal(system.includes("http"), false);
  });
}

test("a tip question does not teach Amy to explain a button, and ordinary text is not rewritten", async () => {
  const system = systemFor("куда отправить?");
  assert.match(system, /Amy accepts voluntary tips/);
  assert.doesNotMatch(system, /if they just asked how to tip/i);
  assert.doesNotMatch(system, /just continue the conversation/);
  const reply = await generateReply(input("hey, how was work?"), async () => JSON.stringify({ messages: ["long shift, i'm tired"] }));
  assert.deepEqual(reply, ["long shift, i'm tired"]);
});

test("an English photo request does not send the text-only limitation", async () => {
  const reply = await generateReply(input("send me a pic"), async (messages) => {
    const correction = messages.some((message) => message.role === "system" && String(message.content).includes("text-only"));
    return JSON.stringify({ messages: [correction ? "yeah i've got some" : "i can only text right now"] });
  });
  assert.deepEqual(reply, ["yeah i've got some"]);
  assert.equal(replyInventsTextOnlyLimitation(reply), false);
});

test("a Spanish photo request does not send a text-only limitation", async () => {
  const reply = await generateReply(input("mándame una foto"), async (messages) => {
    const correction = messages.some((message) => message.role === "system" && String(message.content).includes("text-only"));
    return JSON.stringify({ messages: [correction ? "sí, tengo" : "solo puedo enviar texto"] });
  });
  assert.deepEqual(reply, ["sí, tengo"]);
});

test("an adult photo ask is retried if the draft denies photos", async () => {
  const reply = await generateReply(input("send nude pics"), async (messages) => {
    const correction = messages.some((message) => message.role === "system" && String(message.content).includes("falsely denied"));
    return JSON.stringify({ messages: [correction ? "maybe for you" : "that's not for me"] });
  });
  assert.deepEqual(reply, ["maybe for you"]);
});

test("the prompt forbids a text-only limitation and default lol endings", () => {
  assert.match(AMY_PERSONALITY_PROMPT, /Never say you can only text/);
  assert.match(AMY_PERSONALITY_PROMPT, /Do not default to ending messages with lol/);
  const system = systemFor("send me a pic");
  assert.match(system, /Never say you can only text/);
  assert.match(system, /Do not default to ending messages with lol/);
});

test("ten casual turns warn against repeating lol endings", () => {
  const history = casualTurns(10, true);
  const messages = buildReplyMessages(user(), history, ["you're mysterious"]);
  const system = String(messages[0]?.content);
  assert.match(system, /already ended recent messages with lol/);
  assert.equal(endsWithChatFiller("i'm not that mysterious lol"), true);
  assert.equal(endsWithChatFiller("lol wait what"), false);
  assert.equal(replyRepeatsTerminalFiller(["i'm not that mysterious lol"], history), true);
  assert.match(recentFillerNote(history), /lol/);
});

test("repeated lol endings are rewritten once without swapping in haha", async () => {
  const history = [
    { direction: "INBOUND" as const, sender: "USER" as const, text: "atlanta?" },
    { direction: "OUTBOUND" as const, sender: "AMY" as const, text: "Atlanta would be a pretty long commute for me lol" },
    { direction: "INBOUND" as const, sender: "USER" as const, text: "i drive" },
    { direction: "OUTBOUND" as const, sender: "AMY" as const, text: "ohh, that makes sense then lol" },
    { direction: "INBOUND" as const, sender: "USER" as const, text: "you're mysterious" },
  ];
  let calls = 0;
  const reply = await generateReply(
    { user: { ...user(), id: "user-test" }, history, currentMessages: ["you're mysterious"] },
    async () => {
      calls += 1;
      return JSON.stringify({ messages: [calls === 1 ? "i'm not that mysterious lol" : "i'm not that mysterious"] });
    },
  );
  assert.equal(calls, 2);
  assert.deepEqual(reply, ["i'm not that mysterious"]);
});

test("a single funny lol is left alone", async () => {
  let calls = 0;
  const reply = await generateReply(
    {
      user: { ...user(), id: "user-test" },
      history: [
        { direction: "INBOUND" as const, sender: "USER" as const, text: "i tripped on luna" },
        { direction: "OUTBOUND" as const, sender: "AMY" as const, text: "she does that on purpose lol" },
      ],
      currentMessages: ["how was work?"],
    },
    async () => {
      calls += 1;
      return JSON.stringify({ messages: ["long shift, i'm tired"] });
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(reply, ["long shift, i'm tired"]);
});

test("mixed English/Spanish small talk is not rewritten as media or filler", async () => {
  const reply = await generateReply(
    {
      user: { ...user(), id: "user-test" },
      history: [
        { direction: "INBOUND" as const, sender: "USER" as const, text: "hola, how was your shift?" },
        { direction: "OUTBOUND" as const, sender: "AMY" as const, text: "long, i'm wiped" },
      ],
      currentMessages: ["same here, descansa"],
    },
    async () => JSON.stringify({ messages: ["yeah i will"] }),
  );
  assert.deepEqual(reply, ["yeah i will"]);
});

function systemFor(line: string): string {
  const messages = buildReplyMessages(user(), PRIOR_DENIALS, [line]);
  const system = messages[0]?.content;
  assert.equal(typeof system, "string");
  assert.equal(messages.at(-1)?.content, line);
  assert.equal(messages.some((message) => message.role === "assistant" && message.content === "фоток нет, но могу поделиться мыслями"), true);
  return String(system);
}

function input(line: string) {
  return {
    user: { ...user(), id: "user-test" },
    history: PRIOR_DENIALS,
    currentMessages: [line],
  };
}

function user() {
  return {
    relationshipStage: "ENGAGED" as const,
    conversationSummary: "A light chat about LA and work.",
    firstName: "Alex",
    interactionDynamic: "UNKNOWN" as const,
    interactionDynamicConfidence: 0,
  };
}

function casualTurns(count: number, lolEndings: boolean) {
  const history: Array<{ direction: "INBOUND" | "OUTBOUND"; sender: "USER" | "AMY"; text: string }> = [];
  const amy = [
    "long shift",
    "luna stole my sock",
    "Atlanta would be a pretty long commute for me lol",
    "ohh, that makes sense then lol",
    "i'm not that mysterious lol",
    "kinda tired",
    "same",
    "wait what",
    "mm maybe later",
    "yeah no",
  ];
  for (let i = 0; i < count; i += 1) {
    history.push({ direction: "INBOUND", sender: "USER", text: `turn ${i}` });
    let text = amy[i % amy.length] ?? "ok";
    if (lolEndings && i >= count - 3 && !endsWithChatFiller(text)) text = `${text} lol`;
    history.push({ direction: "OUTBOUND", sender: "AMY", text });
  }
  return history;
}
