import assert from "node:assert/strict";
import test from "node:test";
import { amyProfile, amyProfilePrompt } from "./amy-profile";
import { AMY_PERSONALITY_PROMPT } from "./amy-personality";

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
