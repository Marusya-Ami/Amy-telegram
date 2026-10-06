import assert from "node:assert/strict";
import test from "node:test";
import { AMY_PERSONALITY_PROMPT } from "@/prompts/amy-personality";
import { amyProfile } from "@/prompts/amy-profile";
import {
  INTERACTION_ESTABLISHED,
  detectInteractionSignal,
  interactionToneLine,
  nextInteractionState,
  type InteractionState,
} from "./dynamic";

const UNKNOWN: InteractionState = {
  interactionDynamic: "UNKNOWN",
  interactionDynamicConfidence: 0,
  interactionDynamicEvidence: null,
};

test("a neutral message does not create an interaction dynamic", () => {
  assert.equal(detectInteractionSignal("hey how was your shift"), null);
  assert.equal(detectInteractionSignal("i paid"), null);
  assert.equal(detectInteractionSignal("i didn't pay you"), null);
  assert.deepEqual(nextInteractionState(UNKNOWN, ["hey", "i have a meeting tomorrow"]), UNKNOWN);
});

test("one title does not establish the dynamic and a second one does", () => {
  const once = nextInteractionState(UNKNOWN, ["yes mistress"]);
  assert.equal(once.interactionDynamic, "DOMINANT_AMY");
  assert.ok(once.interactionDynamicConfidence < INTERACTION_ESTABLISHED);
  assert.match(interactionToneLine(once), /not established/);

  const twice = nextInteractionState(once, ["you're in charge"]);
  assert.equal(twice.interactionDynamic, "DOMINANT_AMY");
  assert.ok(twice.interactionDynamicConfidence >= INTERACTION_ESTABLISHED);
  assert.match(interactionToneLine(twice), /commanding/);
  assert.match(interactionToneLine(twice), /Payment does not change/);
});

test("a later change moves the dynamic gradually", () => {
  const established = nextInteractionState(nextInteractionState(UNKNOWN, ["hey princess"]), ["tell me what to do"]);
  assert.equal(established.interactionDynamic, "DOMINANT_AMY");
  const opposed = nextInteractionState(established, ["i'm in charge, good girl"]);
  assert.equal(opposed.interactionDynamic, "DOMINANT_AMY");
  assert.ok(opposed.interactionDynamicConfidence < established.interactionDynamicConfidence);
  const switched = nextInteractionState(opposed, ["obey me"]);
  assert.equal(switched.interactionDynamic, "DOMINANT_USER");
  assert.ok(switched.interactionDynamicConfidence < INTERACTION_ESTABLISHED);
});

test("playful equality is remembered only after it is repeated", () => {
  const once = nextInteractionState(UNKNOWN, ["let's keep it playful"]);
  assert.equal(once.interactionDynamic, "EQUAL");
  assert.ok(once.interactionDynamicConfidence < INTERACTION_ESTABLISHED);
  const twice = nextInteractionState(once, ["we're equals"]);
  assert.equal(twice.interactionDynamic, "EQUAL");
  assert.match(interactionToneLine(twice), /balanced/);
});

test("payment does not change a stored dynamic", () => {
  const established = nextInteractionState(nextInteractionState(UNKNOWN, ["good girl"]), ["kneel"]);
  assert.equal(established.interactionDynamic, "DOMINANT_USER");
  assert.deepEqual(nextInteractionState(established, ["i paid", "i did not pay"]), established);
});

test("a mixed burst does not update the dynamic", () => {
  assert.deepEqual(nextInteractionState(UNKNOWN, ["yes goddess", "i'm in charge"]), UNKNOWN);
});

test("the personality rule keeps Amy's profile stable and off a neutral chat", () => {
  assert.match(AMY_PERSONALITY_PROMPT, /factual profile stay the same/);
  assert.match(AMY_PERSONALITY_PROMPT, /neutral conversation stays ordinary/);
  assert.match(AMY_PERSONALITY_PROMPT, /paid or did not pay/);
  assert.equal(amyProfile.name, "Amy");
  assert.equal(amyProfile.home.city, "Los Angeles");
});
