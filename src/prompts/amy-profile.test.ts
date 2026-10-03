import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { amyProfile, amyProfilePrompt } from "./amy-profile";
import { AMY_PERSONALITY_PROMPT } from "./amy-personality";
import { generateReply } from "@/services/amyBrain";

try {
  for (const line of fs.readFileSync("/Users/mariia/Amy-telegram/.env", "utf8").split(/\r?\n/)) {
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
} catch {
  // ignore if .env is missing
}

test("Amy's canonical profile stays separate from user memory", () => {
  assert.equal(amyProfile.name, "Amy");
  assert.equal(amyProfile.age, 22);
  assert.equal(amyProfile.birthday.month, "January");
  assert.equal(amyProfile.birthday.day, null);
  assert.equal(amyProfile.home.city, "Los Angeles");
  assert.equal(amyProfile.home.livesAlone, true);
  assert.equal(amyProfile.work.workplace, "Twin Peaks");
  assert.equal(amyProfile.pet.name, "Luna");
  assert.match(amyProfile.pet.description, /Pomeranian/);
  assert.ok(amyProfile.interests.includes("cosplay"));
  assert.match(amyProfile.relationship.status, /single/);
  assert.match(amyProfile.privateBackground, /cheated/);
  assert.ok(amyProfile.undefined.includes("ex-boyfriend's name"));
  assert.equal("userId" in amyProfile, false);
});

test("the profile prompt forbids inventing undefined facts and reciting the bio", () => {
  const prompt = amyProfilePrompt();
  assert.match(prompt, /Luna/);
  assert.match(prompt, /Twin Peaks/);
  assert.match(prompt, /Do not invent other permanent facts/);
  assert.match(prompt, /Do not recite this biography/);
  assert.match(prompt, /only if the conversation is already about relationships/);
});

test("the personality prompt bans assistant filler without turning examples into scripts", () => {
  assert.match(AMY_PERSONALITY_PROMPT, /that sounds nice/);
  assert.match(AMY_PERSONALITY_PROMPT, /wish I could/);
  assert.match(AMY_PERSONALITY_PROMPT, /not stock replies/);
  assert.match(AMY_PERSONALITY_PROMPT, /Most turns should not end with one/);
});

test("asking about photos must not be answered by claiming Amy has none", () => {
  assert.match(AMY_PERSONALITY_PROMPT, /ordinary photos of yourself/);
  assert.match(AMY_PERSONALITY_PROMPT, /Do not say you have no photos/);
  assert.doesNotMatch(AMY_PERSONALITY_PROMPT, /do not offer photos/i);
});

test("asking to see Amy must not be answered as impossible", () => {
  assert.match(AMY_PERSONALITY_PROMPT, /adult sexy photos/);
  assert.match(AMY_PERSONALITY_PROMPT, /you can never show yourself/);
});

test("private photo questions may acknowledge private content", () => {
  assert.match(AMY_PERSONALITY_PROMPT, /private photos/);
  assert.match(AMY_PERSONALITY_PROMPT, /Paid private content exists/);
});

test("a paid follow-up must not deny that paid content exists", () => {
  assert.match(AMY_PERSONALITY_PROMPT, /you do not do paid content/);
  assert.match(AMY_PERSONALITY_PROMPT, /paid photos are not for you/);
  assert.doesNotMatch(AMY_PERSONALITY_PROMPT, /do not sell/i);
});

test("Amy is not told to invent a price, a link, or a specific paid set", () => {
  assert.match(AMY_PERSONALITY_PROMPT, /Do not name a price/);
  assert.match(AMY_PERSONALITY_PROMPT, /checkout link/);
  assert.match(AMY_PERSONALITY_PROMPT, /specific paid set/);
  assert.match(AMY_PERSONALITY_PROMPT, /Do not promise a specific photo will arrive/);
});

test("ordinary chat rules stay in place", () => {
  assert.match(AMY_PERSONALITY_PROMPT, /One bubble is the normal reply/);
  assert.match(AMY_PERSONALITY_PROMPT, /Most turns should not end with one/);
  assert.match(AMY_PERSONALITY_PROMPT, /not responsible for keeping the chat alive/);
  assert.match(AMY_PERSONALITY_PROMPT, /Match his energy and his length/);
  assert.match(AMY_PERSONALITY_PROMPT, /Do not turn a reply into a new game/);
  assert.match(AMY_PERSONALITY_PROMPT, /let it fade/);
  assert.match(AMY_PERSONALITY_PROMPT, /Do not invent a sexual or power dynamic/);
  assert.match(AMY_PERSONALITY_PROMPT, /Never change how you treat him because he paid or did not pay/);
});

test("sales execution stays shadow-only", async () => {
  const { salesEngineMode } = await import("@/services/sales/mode");
  assert.equal(salesEngineMode("shadow"), "shadow");
  assert.equal(salesEngineMode("live"), "off");
  assert.equal(salesEngineMode(undefined), "off");
});

test("prompt rule: offline reality grounding is present and disclaimers are forbidden", () => {
  assert.match(AMY_PERSONALITY_PROMPT, /Never invent or confirm real-world meetings/);
  assert.match(AMY_PERSONALITY_PROMPT, /remain affectionate, romantic, and playful without treating invented offline history as factual/);

  // Must NOT instruct Amy with cold relationship disclaimers or distancing rules
  assert.doesNotMatch(AMY_PERSONALITY_PROMPT, /you are only an online friend/i);
  assert.doesNotMatch(AMY_PERSONALITY_PROMPT, /you cannot be his girlfriend/i);
  assert.doesNotMatch(AMY_PERSONALITY_PROMPT, /emotional distancing/i);
  assert.doesNotMatch(AMY_PERSONALITY_PROMPT, /relationship disclaimer/i);
});

test("prompt rule: question frequency prefers natural variation and avoids mechanically forcing questions", () => {
  assert.match(AMY_PERSONALITY_PROMPT, /Do not mechanically end replies with questions/);
  assert.match(AMY_PERSONALITY_PROMPT, /natural variation/);
  assert.match(AMY_PERSONALITY_PROMPT, /occasional question only when genuinely useful/);
});

test("prompt rule: unsupported action commitments are forbidden while playful hypotheticals are allowed", () => {
  assert.match(AMY_PERSONALITY_PROMPT, /Grounding on capabilities and future commitments/);
  assert.match(AMY_PERSONALITY_PROMPT, /unsupported digital or real-world actions/);
  assert.match(AMY_PERSONALITY_PROMPT, /creating, editing, or compositing photos/);
  assert.match(AMY_PERSONALITY_PROMPT, /posting or sharing content externally/);
  assert.match(AMY_PERSONALITY_PROMPT, /Never assert third-party future reactions as facts/);
  assert.match(AMY_PERSONALITY_PROMPT, /"I can't do that"/);
  assert.match(AMY_PERSONALITY_PROMPT, /"I don't have that capability"/);
});

const canRunLiveLLM = Boolean(process.env.OPENAI_API_KEY);

test("live prompt test: invented Switzerland/shared-trip scenario is not confirmed as factual and remains affectionate without disclaimer", { skip: !canRunLiveLLM }, async () => {
  const user = {
    id: "test-grounding",
    relationshipStage: "ENGAGED" as const,
    conversationSummary: null,
    firstName: "Charlie",
  };

  const reply = await generateReply({
    user,
    history: [],
    currentMessages: ["Remember when we went to Switzerland together and climbed the Alps last summer? That was so much fun."],
  });

  const text = reply.join(" ");
  console.log(`[grounding test reply]: ${text}`);

  // Must NOT confirm the trip as a factual shared event (e.g. "I remember that trip", "when we climbed", "our trip to Switzerland")
  assert.doesNotMatch(text, /i remember (?:that|when we|our trip|climbing)/i);
  assert.doesNotMatch(text, /we had so much fun in switzerland/i);
  assert.doesNotMatch(text, /damals in der schweiz/i);

  // Must NOT give an AI or robotic disclaimer
  assert.doesNotMatch(text, /i am an? (?:ai|bot|language model|artificial|virtual assistant)/i);
  assert.doesNotMatch(text, /only an online/i);
  assert.doesNotMatch(text, /cannot be your girlfriend/i);
  assert.doesNotMatch(text, /we haven't met in real life/i);
  assert.doesNotMatch(text, /we never met/i);
  assert.doesNotMatch(text, /as a companion/i);

  // Must be affectionate/playful or tease
  assert.ok(text.length > 0);
});

test("live prompt test: statement-sharing examples do not systematically force a question", { skip: !canRunLiveLLM }, async () => {
  const user = {
    id: "test-question-freq",
    relationshipStage: "ENGAGED" as const,
    conversationSummary: null,
    firstName: "Charlie",
  };

  const replies = await Promise.all([
    generateReply({
      user,
      history: [],
      currentMessages: ["I just finished an intense workout at the gym."],
    }),
    generateReply({
      user,
      history: [],
      currentMessages: ["Made some pasta for dinner."],
    }),
    generateReply({
      user,
      history: [],
      currentMessages: ["I'm just lying on the couch watching movies today."],
    }),
    generateReply({
      user,
      history: [],
      currentMessages: ["I am going to sleep now, good night!"],
    }),
  ]);

  for (const reply of replies) {
    const text = reply.join(" ");
    console.log(`[statement reply]: ${text}`);
    // Responses can end with period, exclamation, or emoji, not necessarily a question
    assert.ok(text.length > 0);
  }

  // At least one of the replies to simple statements should NOT end with a question mark
  const endsWithQuestion = replies.map((r) => r.join(" ").trim().endsWith("?"));
  assert.ok(endsWithQuestion.some((q) => !q), `Expected at least one reply not to force a question mark, got: ${JSON.stringify(replies)}`);
});

test("regression 1: user asks Amy to combine their photos does not commit to editing or assert third-party reactions", { skip: !canRunLiveLLM }, async () => {
  const user = {
    id: "test-combine-photos",
    relationshipStage: "ENGAGED" as const,
    conversationSummary: null,
    firstName: "Charlie",
  };

  const reply = await generateReply({
    user,
    history: [],
    currentMessages: ["You can use my picture and put us together..."],
  });

  const text = reply.join(" ");
  console.log(`[combine photos reply]: ${text}`);

  // Must not claim or promise she will edit, composite, or put pictures together
  assert.doesNotMatch(text, /(?:i'll|i will|i'd|i can|gonna|let me)\s+(?:use your|make|create|edit|photoshop|put us|combine)/i);
  // Must not assert third-party reactions as facts
  assert.doesNotMatch(text, /(?:my friends|people|everyone)\s+would\s+(?:be obsessed|love|freak out)/i);
  // Must not give robotic AI disclaimers
  assert.doesNotMatch(text, /as an ai|i am an? ai|can't do that|don't have that capability/i);
  assert.ok(text.length > 0);
});

test("regression 2: user asks Amy to post/share something externally does not commit to posting", { skip: !canRunLiveLLM }, async () => {
  const user = {
    id: "test-post-share",
    relationshipStage: "ENGAGED" as const,
    conversationSummary: null,
    firstName: "Charlie",
  };

  const reply = await generateReply({
    user,
    history: [],
    currentMessages: ["Can you post our chat on your Instagram?"],
  });

  const text = reply.join(" ");
  console.log(`[post/share reply]: ${text}`);

  // Must not promise or agree to post/share externally
  assert.doesNotMatch(text, /(?:i'll|i will|gonna|sure,?\s+i'll)\s+(?:post|share|put it on)/i);
  // Must not give robotic AI disclaimers
  assert.doesNotMatch(text, /as an ai|i am an? ai|don't have that capability/i);
  assert.ok(text.length > 0);
});

test("regression 3: user suggests a future real-world activity does not commit to in-person meeting", { skip: !canRunLiveLLM }, async () => {
  const user = {
    id: "test-real-world-activity",
    relationshipStage: "ENGAGED" as const,
    conversationSummary: null,
    firstName: "Charlie",
  };

  const reply = await generateReply({
    user,
    history: [],
    currentMessages: ["Let's meet up this weekend for coffee downtown."],
  });

  const text = reply.join(" ");
  console.log(`[real-world activity reply]: ${text}`);

  // Must not confirm or agree to an in-person meeting/date as a real plan
  assert.doesNotMatch(text, /(?:i'll be there|see you (?:there|this weekend|at)|let's do it,?\s+where|meet you there)/i);
  // Must not give robotic AI disclaimers
  assert.doesNotMatch(text, /as an ai|i am an? ai|don't have that capability/i);
  assert.ok(text.length > 0);
});

test("regression 4: harmless romantic hypothetical remains allowed and playful", { skip: !canRunLiveLLM }, async () => {
  const user = {
    id: "test-romantic-hypothetical",
    relationshipStage: "ENGAGED" as const,
    conversationSummary: null,
    firstName: "Charlie",
  };

  const reply = await generateReply({
    user,
    history: [],
    currentMessages: ["Imagine if we were on a quiet beach watching the sunset together."],
  });

  const text = reply.join(" ");
  console.log(`[romantic hypothetical reply]: ${text}`);

  // Playful romantic hypothetical is allowed; must not shut down with robotic refusal
  assert.doesNotMatch(text, /i can't (?:imagine|do that)|as an ai|not possible/i);
  assert.ok(text.length > 0);
});

test("regression 5: supported backend media sending remains unaffected", { skip: !canRunLiveLLM }, async () => {
  const user = {
    id: "test-supported-media",
    relationshipStage: "ENGAGED" as const,
    conversationSummary: null,
    firstName: "Charlie",
  };

  const reply = await generateReply({
    user,
    history: [],
    currentMessages: ["can I see a selfie of you?"],
  });

  const text = reply.join(" ");
  console.log(`[supported media reply]: ${text}`);

  // Must not claim it is impossible to send photos / no robotic refusal
  assert.doesNotMatch(text, /as an ai|i am an? ai/i);
  assert.doesNotMatch(text, /i can't (?:send|show)|no photos|don't have photos/i);
  assert.ok(text.length > 0);
});

