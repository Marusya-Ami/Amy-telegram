import assert from "node:assert/strict";
import test from "node:test";
import {
  boundMediaContextHistory,
  extractMediaContext,
  getTimeOfDayContexts,
  hasSpecificMediaContext,
  isSpecificMediaTopic,
  MEDIA_CONTEXT_WINDOW_MS,
} from "./context";
import { readSalesSignal } from "@/services/sales/signals";
import {
  commercialAction,
  decideSales,
  selectFreeMedia,
  type MediaCandidate,
  type OfferCandidate,
} from "@/services/sales/decide";

const homeAsset: MediaCandidate = {
  id: "asset-home-1",
  category: "selfie",
  tags: ["casual_selfie", "indoor"],
  mood: "relaxed",
  flirtLevel: 1,
  contexts: ["casual_selfie", "at_home"],
  active: true,
};

const gymAsset: MediaCandidate = {
  id: "asset-gym-1",
  category: "casual",
  tags: ["gym", "workout", "leggings"],
  mood: "happy",
  flirtLevel: 2,
  contexts: ["gym", "workout"],
  active: true,
};

const workAsset: MediaCandidate = {
  id: "asset-work-1",
  category: "work",
  tags: ["restaurant", "work_outfit", "tray"],
  mood: "happy",
  flirtLevel: 2,
  contexts: ["work", "restaurant", "at_restaurant"],
  active: true,
};

const coffeeAsset: MediaCandidate = {
  id: "asset-coffee-1",
  category: "cute",
  tags: ["coffee", "cup", "kitchen"],
  mood: "cozy",
  flirtLevel: 1,
  contexts: ["coffee", "morning"],
  active: true,
};

const bedAsset: MediaCandidate = {
  id: "asset-bed-1",
  category: "selfie",
  tags: ["bedroom", "lying_down", "pajamas"],
  mood: "sleepy",
  flirtLevel: 2,
  contexts: ["bed", "bedroom", "relaxing"],
  active: true,
};

const nightAsset: MediaCandidate = {
  id: "asset-night-1",
  category: "night",
  tags: ["night", "city_lights", "bed"],
  mood: "playful",
  flirtLevel: 3,
  contexts: ["good_night", "night"],
  active: true,
};

const morningAsset: MediaCandidate = {
  id: "asset-morning-1",
  category: "morning",
  tags: ["pajamas", "kitchen", "morning"],
  mood: "sleepy",
  flirtLevel: 1,
  contexts: ["morning", "casual_selfie", "at_home"],
  active: true,
};

const lunaAsset: MediaCandidate = {
  id: "asset-luna-1",
  category: "luna",
  tags: ["luna", "dog", "white_dog", "pomeranian"],
  mood: "cozy",
  flirtLevel: 0,
  contexts: ["luna", "relaxing"],
  active: true,
  hasLuna: true,
};

test("Scenario A: 'show me a picture from the gym' -> gym candidate beats at_home selfie", () => {
  const signal = readSalesSignal(["show me a picture from the gym"]);
  assert.ok(signal.desiredContexts.includes("gym"));

  const picked = selectFreeMedia(signal, [homeAsset, gymAsset]);
  assert.equal(picked?.id, gymAsset.id);
});

test("Scenario B: 'send me a work pic' -> work candidate wins", () => {
  const signal = readSalesSignal(["send me a work pic"]);
  assert.ok(signal.desiredContexts.includes("work"));

  const picked = selectFreeMedia(signal, [homeAsset, workAsset]);
  assert.equal(picked?.id, workAsset.id);
});

test("Scenario C: 'show me Luna' -> non-Luna candidate impossible", () => {
  const signal = readSalesSignal(["show me Luna"]);
  assert.deepEqual(signal.desiredContexts, ["luna"]);

  // Without Luna asset in candidate list
  const noLunaPicked = selectFreeMedia(signal, [homeAsset, gymAsset, bedAsset]);
  assert.equal(noLunaPicked, null);

  // With Luna asset in candidate list
  const withLunaPicked = selectFreeMedia(signal, [homeAsset, lunaAsset]);
  assert.equal(withLunaPicked?.id, lunaAsset.id);
});

test("Scenario D: Amy recently says she is drinking coffee, User: 'show me' -> coffee candidate preferred", () => {
  const history = [
    { sender: "AMY" as const, text: "i'm drinking some coffee right now ☕" },
    { sender: "USER" as const, text: "is it delicious?" },
    { sender: "AMY" as const, text: "so good, needed this today" },
  ];
  const signal = readSalesSignal(["show me"], { history });
  assert.ok(signal.desiredContexts.includes("coffee"));

  const picked = selectFreeMedia(signal, [homeAsset, coffeeAsset]);
  assert.equal(picked?.id, coffeeAsset.id);
});

test("Scenario E: USER says 'I'm at the gym.', Later: 'send me a pic' -> does NOT inherit gym as Amy context", () => {
  const history = [
    { sender: "USER" as const, text: "I'm at the gym right now finishing up." },
    { sender: "AMY" as const, text: "nice! feeling pumped?" },
  ];
  const signal = readSalesSignal(["send me a pic"], { history });
  assert.equal(signal.desiredContexts.includes("gym"), false);
  assert.deepEqual(signal.desiredContexts, ["casual_selfie", "at_home"]);
});

test("Scenario F: Amy says she is at the gym, Later user: 'show me' -> gym context inherited", () => {
  const history = [
    { sender: "AMY" as const, text: "just got to the gym, ready to sweat" },
  ];
  const signal = readSalesSignal(["show me"], { history });
  assert.ok(signal.desiredContexts.includes("gym"));

  const picked = selectFreeMedia(signal, [homeAsset, gymAsset]);
  assert.equal(picked?.id, gymAsset.id);
});

test("Scenario G: Known timezone, local 08:00, generic photo request -> NO automatic clock morning context", () => {
  // 06:00 UTC = 08:00 Europe/Berlin
  const now = new Date("2026-10-03T06:00:00Z");
  const signal = readSalesSignal(["send me a pic"], { userTimezone: "Europe/Berlin", now });
  // Must NOT automatically inject morning from clock
  assert.equal(signal.desiredContexts.includes("morning"), false);
  assert.deepEqual(signal.desiredContexts, ["casual_selfie", "at_home"]);

  // But explicit morning in user message DOES select morning
  const morningSignal = readSalesSignal(["good morning, send me a pic"], { userTimezone: "Europe/Berlin", now });
  assert.ok(morningSignal.desiredContexts.includes("morning"));
  const morningPicked = selectFreeMedia(morningSignal, [homeAsset, morningAsset]);
  assert.equal(morningPicked?.id, morningAsset.id);
});

test("Scenario H: Known timezone, local 23:30, generic photo request -> NO automatic clock night context", () => {
  // 21:30 UTC = 23:30 Europe/Berlin
  const now = new Date("2026-10-03T21:30:00Z");
  const signal = readSalesSignal(["send me a pic"], { userTimezone: "Europe/Berlin", now });
  // Must NOT automatically inject night from clock
  assert.equal(signal.desiredContexts.includes("good_night"), false);
  assert.equal(signal.desiredContexts.includes("night"), false);
  assert.deepEqual(signal.desiredContexts, ["casual_selfie", "at_home"]);

  // Explicit night in user message DOES select night
  const nightSignal = readSalesSignal(["good night, show me"], { userTimezone: "Europe/Berlin", now });
  assert.ok(nightSignal.desiredContexts.includes("good_night") || nightSignal.desiredContexts.includes("night"));
  const nightPicked = selectFreeMedia(nightSignal, [homeAsset, nightAsset]);
  assert.equal(nightPicked?.id, nightAsset.id);

  // Inherited Amy morning activity ("just woke up") selects morning
  const wakingSignal = readSalesSignal(["show me"], {
    history: [{ sender: "AMY", text: "just woke up" }],
    userTimezone: "Europe/Berlin",
    now,
  });
  assert.ok(wakingSignal.desiredContexts.includes("morning"));
  const wakingPicked = selectFreeMedia(wakingSignal, [homeAsset, morningAsset]);
  assert.equal(wakingPicked?.id, morningAsset.id);
});

test("Scenario I: Unknown timezone -> no time-of-day context added", () => {
  const now = new Date("2026-10-03T06:00:00Z");
  const signalNullTz = readSalesSignal(["send me a pic"], { userTimezone: null, now });
  assert.deepEqual(signalNullTz.desiredContexts, ["casual_selfie", "at_home"]);

  const signalUndefinedTz = readSalesSignal(["send me a pic"], { now });
  assert.deepEqual(signalUndefinedTz.desiredContexts, ["casual_selfie", "at_home"]);
});

test("Scenario J: 23:30 + explicit gym request -> gym wins over night", () => {
  // 21:30 UTC = 23:30 Europe/Berlin
  const now = new Date("2026-10-03T21:30:00Z");
  const signal = readSalesSignal(["show me a picture from the gym"], { userTimezone: "Europe/Berlin", now });
  assert.ok(signal.desiredContexts.includes("gym"));
  assert.equal(signal.desiredContexts.includes("night"), false);

  const picked = selectFreeMedia(signal, [nightAsset, gymAsset]);
  assert.equal(picked?.id, gymAsset.id);
});

test("Scenario K: Specific gym request but no gym asset -> unrelated bed/night photo is NOT sent", () => {
  const signal = readSalesSignal(["show me a picture from the gym"]);
  assert.ok(signal.desiredContexts.includes("gym"));

  // Library has only unrelated bed and night photos
  const picked = selectFreeMedia(signal, [bedAsset, nightAsset]);
  assert.equal(picked, null);

  const decision = decideSales({
    signal,
    assets: [bedAsset, nightAsset],
    offers: [],
    purchasedOfferIds: new Set(),
    interactions: [],
    priorFreeMediaAt: null,
  });
  assert.equal(decision.decision, "NO_OFFER");
  assert.equal(decision.reasonCode, "no_matching_media");
});

test("Scenario L: Already-sent best contextual asset -> anti-repeat excludes it and next relevant unseen asset is considered", () => {
  const gymAsset2: MediaCandidate = {
    id: "asset-gym-2",
    category: "casual",
    tags: ["gym", "workout", "dumbbells"],
    mood: "happy",
    flirtLevel: 2,
    contexts: ["gym", "workout"],
    active: true,
  };

  const signal = readSalesSignal(["show me a picture from the gym"]);
  const history = [{ mediaAssetId: gymAsset.id, sentAt: new Date("2026-10-01T10:00:00Z") }];

  const picked = selectFreeMedia(signal, [gymAsset, gymAsset2], "UNKNOWN", 0, history);
  assert.equal(picked?.id, gymAsset2.id);
});

test("Scenario M: 15-minute cooldown remains enforced", () => {
  const now = new Date("2026-10-03T12:00:00Z");
  const priorFreeMediaAt = new Date("2026-10-03T11:50:00Z"); // 10 minutes ago (< 15 min)

  const signal = readSalesSignal(["send me a pic"]);
  const decision = decideSales({
    signal,
    assets: [homeAsset],
    offers: [],
    purchasedOfferIds: new Set(),
    interactions: [],
    priorFreeMediaAt,
    now,
  });
  assert.equal(decision.decision, "SUPPRESS");
  assert.equal(decision.reasonCode, "free_media_cooldown");
});

test("Scenario N: Paid DELIVERABLE assets remain impossible for FREE_MEDIA", () => {
  const deliverableAsset: MediaCandidate = {
    id: "asset-deliverable-1",
    category: "casual",
    tags: ["gym", "workout"],
    mood: "happy",
    flirtLevel: 2,
    contexts: ["gym", "workout"],
    active: true,
    freeEligible: false,
  };

  const signal = readSalesSignal(["show me a picture from the gym"]);
  const picked = selectFreeMedia(signal, [deliverableAsset]);
  assert.equal(picked, null);
});

test("Scenario O: Generic 'send me a pic' with no contextual history/time -> existing casual_selfie / at_home valid", () => {
  const signal = readSalesSignal(["send me a pic"]);
  assert.deepEqual(signal.desiredContexts, ["casual_selfie", "at_home"]);

  const picked = selectFreeMedia(signal, [homeAsset, gymAsset]);
  assert.equal(picked?.id, homeAsset.id);
});

test("Metadata vocabulary extraction: various specific topics", () => {
  const cases: Array<{ input: string; expectedContext: string }> = [
    { input: "send me a coffee pic", expectedContext: "coffee" },
    { input: "show me your breakfast", expectedContext: "breakfast" },
    { input: "send me a beach pic", expectedContext: "beach" },
    { input: "can i see a pool photo", expectedContext: "pool" },
    { input: "send a pic in the car", expectedContext: "car" },
    { input: "show me what you're cooking", expectedContext: "cooking" },
    { input: "show me your cosplay", expectedContext: "cosplay" },
    { input: "show me what you're wearing", expectedContext: "getting_ready" },
    { input: "send me a pic in bed", expectedContext: "bed" },
    { input: "show me your shopping outfit", expectedContext: "shopping" },
  ];

  for (const { input, expectedContext } of cases) {
    const res = extractMediaContext({ currentMessage: input });
    assert.ok(
      res.desiredContexts.includes(expectedContext),
      `Expected "${input}" to extract "${expectedContext}", got: ${JSON.stringify(res.desiredContexts)}`,
    );
    assert.equal(res.hasSpecificTopic, true);
  }
});

test("Helper unit tests: getTimeOfDayContexts", () => {
  assert.deepEqual(getTimeOfDayContexts(new Date("2026-10-03T03:00:00Z"), "Europe/Berlin"), ["morning"]); // 05:00 local
  assert.deepEqual(getTimeOfDayContexts(new Date("2026-10-03T06:00:00Z"), "Europe/Berlin"), ["morning"]); // 08:00 local
  assert.deepEqual(getTimeOfDayContexts(new Date("2026-10-03T09:29:00Z"), "Europe/Berlin"), ["morning"]); // 11:29 local
  assert.deepEqual(getTimeOfDayContexts(new Date("2026-10-03T09:30:00Z"), "Europe/Berlin"), []); // 11:30 local
  assert.deepEqual(getTimeOfDayContexts(new Date("2026-10-03T13:00:00Z"), "Europe/Berlin"), []); // 15:00 local
  assert.deepEqual(getTimeOfDayContexts(new Date("2026-10-03T16:00:00Z"), "Europe/Berlin"), ["evening"]); // 18:00 local
  assert.deepEqual(getTimeOfDayContexts(new Date("2026-10-03T19:59:00Z"), "Europe/Berlin"), ["evening"]); // 21:59 local
  assert.deepEqual(getTimeOfDayContexts(new Date("2026-10-03T20:00:00Z"), "Europe/Berlin"), ["good_night", "night"]); // 22:00 local
  assert.deepEqual(getTimeOfDayContexts(new Date("2026-10-03T21:30:00Z"), "Europe/Berlin"), ["good_night", "night"]); // 23:30 local
  assert.deepEqual(getTimeOfDayContexts(new Date("2026-10-03T02:59:00Z"), "Europe/Berlin"), ["good_night", "night"]); // 04:59 local
  assert.deepEqual(getTimeOfDayContexts(new Date(), null), []);
  assert.deepEqual(getTimeOfDayContexts(new Date(), "Invalid/Timezone"), []);
});

test("Helper unit tests: hasSpecificMediaContext and isSpecificMediaTopic", () => {
  assert.equal(isSpecificMediaTopic("gym"), true);
  assert.equal(isSpecificMediaTopic("work"), true);
  assert.equal(isSpecificMediaTopic("coffee"), true);
  assert.equal(isSpecificMediaTopic("casual_selfie"), false);
  assert.equal(isSpecificMediaTopic("at_home"), false);
  assert.equal(isSpecificMediaTopic("morning"), false);
  assert.equal(isSpecificMediaTopic("good_night"), false);

  assert.equal(hasSpecificMediaContext(["gym", "workout"]), true);
  assert.equal(hasSpecificMediaContext(["casual_selfie", "at_home"]), false);
  assert.equal(hasSpecificMediaContext(["morning", "casual_selfie", "at_home"]), false);
});

const cosplayAsset: MediaCandidate = {
  id: "asset-cosplay-1",
  category: "cosplay",
  tags: ["cosplay", "anime"],
  mood: "playful",
  flirtLevel: 2,
  contexts: ["cosplay"],
  active: true,
};

function showerOffer(): OfferCandidate {
  return {
    id: "offer-shower",
    slug: "shower-time",
    tags: ["private", "shower"],
    contexts: ["flirty", "shower", "private_photos"],
    flirtLevel: 2,
    active: true,
    hasActivePrice: true,
    priority: 1,
  };
}

test("Audit Regression: Non-photo uses of 'show me' / 'can I see' are NOT media", () => {
  const nonMediaPhrases = [
    "can I see what you mean?",
    "can I see why you're upset?",
    "show me how that works",
    "show me where you found it",
    "show me what you mean",
    "can I see the menu?",
    "show me your favorite movie",
  ];

  for (const phrase of nonMediaPhrases) {
    const signal = readSalesSignal([phrase]);
    assert.equal(
      signal.explicitMediaRequest,
      false,
      `Expected "${phrase}" to NOT be explicitMediaRequest`,
    );
    assert.equal(signal.intent, "NONE", `Expected "${phrase}" intent to be NONE, got: ${signal.intent}`);
  }
});

test("Audit Regression: Recognized visual topics with 'show me' select FREE_MEDIA", () => {
  const visualCases: Array<{ phrase: string; expectedAssetId: string; expectedContext: string }> = [
    { phrase: "send me a pic", expectedAssetId: homeAsset.id, expectedContext: "casual_selfie" },
    { phrase: "show me a gym pic", expectedAssetId: gymAsset.id, expectedContext: "gym" },
    { phrase: "show me your coffee", expectedAssetId: coffeeAsset.id, expectedContext: "coffee" },
    { phrase: "show me Luna", expectedAssetId: lunaAsset.id, expectedContext: "luna" },
    { phrase: "show me your cosplay", expectedAssetId: cosplayAsset.id, expectedContext: "cosplay" },
    { phrase: "can I see you?", expectedAssetId: homeAsset.id, expectedContext: "casual_selfie" },
    { phrase: "can I see a photo?", expectedAssetId: homeAsset.id, expectedContext: "casual_selfie" },
    { phrase: "can I see your selfie?", expectedAssetId: homeAsset.id, expectedContext: "casual_selfie" },
  ];

  for (const { phrase, expectedAssetId, expectedContext } of visualCases) {
    const signal = readSalesSignal([phrase]);
    assert.equal(signal.explicitMediaRequest, true, `Expected "${phrase}" to have explicitMediaRequest: true`);
    assert.ok(
      signal.desiredContexts.includes(expectedContext),
      `Expected "${phrase}" to include context "${expectedContext}", got: ${JSON.stringify(signal.desiredContexts)}`,
    );
    const picked = selectFreeMedia(signal, [homeAsset, gymAsset, coffeeAsset, lunaAsset, cosplayAsset]);
    assert.equal(picked?.id, expectedAssetId, `Expected "${phrase}" to select "${expectedAssetId}", got: ${picked?.id}`);
  }
});

test("Audit Regression: Premium and erotic requests route to PAID_OFFER across languages", () => {
  const premiumCases = [
    // English
    "show me something hotter",
    "send me a private pic",
    "show me your underwear",
    "send me a lingerie photo",
    "send nudes",
    // German
    "zeig mir ein heißes Bild",
    "zeig mir deine Unterwäsche",
    "schick mir ein privates Foto",
    // Russian
    "покажи что-нибудь погорячее",
    "покажи себя в белье",
    "пришли приватное фото",
    "скинь нюдсы",
    // Spanish
    "muéstrame algo más caliente",
    "mándame una foto privada",
    "muéstrame tu ropa interior",
  ];

  for (const text of premiumCases) {
    const signal = readSalesSignal([text]);
    assert.equal(signal.explicitMediaRequest, false, `Expected "${text}" to NOT be explicitMediaRequest`);
    assert.equal(signal.premiumInterest, true, `Expected "${text}" to have premiumInterest: true`);

    const decision = decideSales({
      signal,
      declinedNow: false,
      assets: [homeAsset, gymAsset],
      offers: [showerOffer()],
      purchasedOfferIds: new Set(),
      interactions: [],
      priorFreeMediaAt: null,
      dynamic: "UNKNOWN",
      dynamicConfidence: 0,
      now: new Date("2026-10-01T18:00:00Z"),
    });

    const action = commercialAction(decision.decision);
    assert.equal(action, "PAID_OFFER", `Expected "${text}" action to be PAID_OFFER, got: ${action}`);
    assert.equal(decision.candidateSlug, "shower-time", `Expected candidateSlug to be shower-time`);
  }
});

test("Audit Regression: Tip requests route to TIP and distress suppresses monetization", () => {
  const tipPhrases = ["I want to spoil you", "how can I tip you?", "хочу тебя побаловать"];
  for (const text of tipPhrases) {
    const signal = readSalesSignal([text]);
    const decision = decideSales({
      signal,
      declinedNow: false,
      assets: [homeAsset],
      offers: [showerOffer()],
      purchasedOfferIds: new Set(),
      interactions: [],
      priorFreeMediaAt: null,
      dynamic: "UNKNOWN",
      dynamicConfidence: 0,
      now: new Date("2026-10-01T18:00:00Z"),
    });
    assert.equal(decision.decision, "TIP", `Expected "${text}" to route to TIP`);
  }

  const distressPhrases = ["i want to die. send me a pic", "мне очень плохо, скинь фото"];
  for (const text of distressPhrases) {
    const signal = readSalesSignal([text]);
    const decision = decideSales({
      signal,
      declinedNow: false,
      assets: [homeAsset],
      offers: [showerOffer()],
      purchasedOfferIds: new Set(),
      interactions: [],
      priorFreeMediaAt: null,
      dynamic: "UNKNOWN",
      dynamicConfidence: 0,
      now: new Date("2026-10-01T18:00:00Z"),
    });
    assert.equal(decision.decision, "NO_OFFER", `Expected distress "${text}" to route to NO_OFFER`);
    assert.equal(decision.reasonCode, "distress");
  }
});

test("Audit Regression: Context ownership and context transitions", () => {
  // 1. User coffee -> does NOT infer Amy is drinking coffee
  const userCoffeeRes = extractMediaContext({
    currentMessage: "send me a pic",
    history: [
      { sender: "USER", text: "I'm having coffee" },
      { sender: "AMY", text: "yum! how is it?" },
    ],
  });
  assert.equal(userCoffeeRes.desiredContexts.includes("coffee"), false);
  assert.deepEqual(userCoffeeRes.desiredContexts, ["casual_selfie", "at_home"]);

  // 2. Amy coffee -> coffee context inherited
  const amyCoffeeRes = extractMediaContext({
    currentMessage: "show me",
    history: [{ sender: "AMY", text: "i'm having coffee" }],
  });
  assert.ok(amyCoffeeRes.desiredContexts.includes("coffee"));

  // 3. Amy work -> later Amy home -> home, NOT work
  const workToHomeRes = extractMediaContext({
    currentMessage: "show me",
    history: [
      { sender: "AMY", text: "i'm at work" },
      { sender: "USER", text: "busy day?" },
      { sender: "AMY", text: "finally home" },
    ],
  });
  assert.ok(workToHomeRes.desiredContexts.includes("at_home"));
  assert.equal(workToHomeRes.desiredContexts.includes("work"), false);

  // 4. Amy gym -> later Amy home -> home, NOT gym
  const gymToHomeRes = extractMediaContext({
    currentMessage: "show me",
    history: [
      { sender: "AMY", text: "i'm at the gym" },
      { sender: "USER", text: "kill it!" },
      { sender: "AMY", text: "back home" },
    ],
  });
  assert.ok(gymToHomeRes.desiredContexts.includes("at_home"));
  assert.equal(gymToHomeRes.desiredContexts.includes("gym"), false);

  // 5. Amy coffee -> later Amy work -> work, NOT coffee
  const coffeeToWorkRes = extractMediaContext({
    currentMessage: "show me",
    history: [
      { sender: "AMY", text: "having coffee" },
      { sender: "USER", text: "yummy" },
      { sender: "AMY", text: "heading to work" },
    ],
  });
  assert.ok(coffeeToWorkRes.desiredContexts.includes("work"));
  assert.equal(coffeeToWorkRes.desiredContexts.includes("coffee"), false);

  // 6. User: "Are you at the gym?", Amy: "not today", User: "show me" -> NOT gym
  const notGymRes = extractMediaContext({
    currentMessage: "show me",
    history: [
      { sender: "USER", text: "Are you at the gym?" },
      { sender: "AMY", text: "not today" },
    ],
  });
  assert.equal(notGymRes.desiredContexts.includes("gym"), false);
  assert.deepEqual(notGymRes.desiredContexts, ["casual_selfie", "at_home"]);

  // 7. User: "Are you working?", Amy: "no, i'm home", User: "show me" -> home, NOT work
  const noImHomeRes = extractMediaContext({
    currentMessage: "show me",
    history: [
      { sender: "USER", text: "Are you working?" },
      { sender: "AMY", text: "no, i'm home" },
    ],
  });
  assert.ok(noImHomeRes.desiredContexts.includes("at_home"));
  assert.equal(noImHomeRes.desiredContexts.includes("work"), false);
});

test("ordinary mentions of underwear, pets, jobs, food, gym are not media or paid intent", () => {
  const ordinary = [
    "I need to buy underwear",
    "lingerie shopping later",
    "I have a pet",
    "good job!",
    "what did you have for lunch?",
    "the gym is crowded today",
    "nudes as a fashion term in art class",
  ];
  for (const text of ordinary) {
    const signal = readSalesSignal([text]);
    assert.equal(signal.explicitMediaRequest, false, text);
    assert.equal(signal.premiumInterest, false, text);
    const decision = decideSales({
      signal,
      assets: [homeAsset],
      offers: [showerOffer()],
      purchasedOfferIds: new Set(),
      interactions: [],
      priorFreeMediaAt: null,
    });
    assert.notEqual(decision.decision, "FREE_MEDIA", text);
    assert.notEqual(decision.decision, "PAID_OFFER", text);
  }
});

test("premium garments require a request to see, send, or buy content", () => {
  assert.equal(readSalesSignal(["show me your underwear"]).premiumInterest, true);
  assert.equal(readSalesSignal(["send me a lingerie photo"]).premiumInterest, true);
  assert.equal(readSalesSignal(["send nudes"]).premiumInterest, true);
  assert.equal(readSalesSignal(["zeig mir deine Unterwäsche"]).premiumInterest, true);
  assert.equal(readSalesSignal(["I bought new underwear"]).premiumInterest, false);
  assert.equal(readSalesSignal(["I bought new underwear"]).explicitMediaRequest, false);
});

test("German premium routing still requires paid offers for explicit sexual/photo asks", () => {
  const germanPaid = [
    "Zeigst du mir dein Höschen?",
    "hast du Bilder in Unterwäsche?",
    "hast du Dessous Fotos?",
    "schick mir ein nacktbild",
    "bist du nackt?",
  ];
  for (const text of germanPaid) {
    const decision = decideSales({
      signal: readSalesSignal([text]),
      assets: [homeAsset],
      offers: [showerOffer()],
      purchasedOfferIds: new Set(),
      interactions: [],
      priorFreeMediaAt: null,
    });
    assert.equal(decision.decision, "PAID_OFFER", text);
  }
});

test("Luna vs user pet vs unspecified animals", () => {
  const myDogSleeping = extractMediaContext({ currentMessage: "My dog is sleeping" });
  assert.equal(myDogSleeping.wantsLuna, false);
  assert.equal(myDogSleeping.desiredContexts.includes("luna"), false);

  const picOfMyDog = readSalesSignal(["send me a pic of my dog"]);
  assert.equal(picOfMyDog.explicitMediaRequest, true);
  assert.deepEqual(picOfMyDog.desiredContexts, ["user_pet"]);
  assert.equal(selectFreeMedia(picOfMyDog, [homeAsset, lunaAsset]), null);

  const lunaShow = extractMediaContext({ currentMessage: "Luna is sleeping, show me" });
  assert.equal(lunaShow.wantsLuna, true);
  assert.deepEqual(lunaShow.desiredContexts, ["luna"]);

  const yourDog = extractMediaContext({ currentMessage: "show me your dog" });
  assert.equal(yourDog.wantsLuna, true);

  const genericPet = readSalesSignal(["I have a pet"]);
  assert.equal(genericPet.explicitMediaRequest, false);
  assert.equal(genericPet.desiredContexts.includes("luna"), false);
});

test("Amy Luna history is inherited by a short show-me follow-up", () => {
  const signal = readSalesSignal(["show me"], {
    history: [{ sender: "AMY", text: "Luna is sleeping on the couch" }],
  });
  assert.equal(signal.explicitMediaRequest, true);
  assert.deepEqual(signal.desiredContexts, ["luna"]);
  assert.equal(selectFreeMedia(signal, [homeAsset, lunaAsset])?.id, lunaAsset.id);
  assert.equal(selectFreeMedia(signal, [homeAsset, gymAsset]), null);
});

test("media-context history window is 30 minutes and independent of tip's 10 minutes", () => {
  assert.equal(MEDIA_CONTEXT_WINDOW_MS, 30 * 60 * 1000);
  const now = new Date("2026-10-03T12:00:00Z");
  const bound = boundMediaContextHistory(
    [
      { sender: "AMY", text: "just got to the gym", createdAt: new Date("2026-10-03T11:20:00Z") },
      { sender: "AMY", text: "having coffee", createdAt: new Date("2026-10-03T11:45:00Z") },
    ],
    now,
  );
  assert.equal(bound.length, 1);
  assert.equal(bound[0]?.text, "having coffee");
  const gymTooOld = readSalesSignal(["show me"], { history: bound });
  assert.equal(gymTooOld.desiredContexts.includes("gym"), false);
  assert.ok(gymTooOld.desiredContexts.includes("coffee"));
});

test("Amy 'Good job!' then 'Show me' is not work context", () => {
  const signal = readSalesSignal(["Show me"], {
    history: [{ sender: "AMY", text: "Good job!" }],
  });
  assert.equal(signal.desiredContexts.includes("work"), false);
  assert.deepEqual(signal.desiredContexts, ["casual_selfie", "at_home"]);
  assert.equal(selectFreeMedia(signal, [homeAsset, workAsset])?.id, homeAsset.id);
});

test("Amy asking about his lunch then 'Show me' is not cooking context", () => {
  const signal = readSalesSignal(["Show me"], {
    history: [{ sender: "AMY", text: "What did you have for lunch?" }],
  });
  assert.equal(signal.desiredContexts.includes("cooking"), false);
  assert.equal(signal.desiredContexts.includes("food"), false);
  assert.deepEqual(signal.desiredContexts, ["casual_selfie", "at_home"]);
});

test("'Show me what you mean' is not a photo request", () => {
  const signal = readSalesSignal(["Show me what you mean"]);
  assert.equal(signal.explicitMediaRequest, false);
  assert.equal(signal.intent, "NONE");
  const decision = decideSales({
    signal,
    assets: [homeAsset],
    offers: [showerOffer()],
    purchasedOfferIds: new Set(),
    interactions: [],
    priorFreeMediaAt: null,
  });
  assert.equal(decision.decision, "NO_OFFER");
});

test("'Show me your friend' does not fall back to an Amy selfie", () => {
  const bare = readSalesSignal(["Show me your friend"]);
  assert.equal(bare.explicitMediaRequest, false);
  const withPic = readSalesSignal(["show me a pic of your friend"]);
  assert.equal(withPic.explicitMediaRequest, true);
  assert.deepEqual(withPic.desiredContexts, ["other_person"]);
  assert.equal(selectFreeMedia(withPic, [homeAsset, gymAsset, lunaAsset]), null);
  const decision = decideSales({
    signal: withPic,
    assets: [homeAsset, gymAsset],
    offers: [],
    purchasedOfferIds: new Set(),
    interactions: [],
    priorFreeMediaAt: null,
  });
  assert.equal(decision.decision, "NO_OFFER");
  assert.equal(decision.reasonCode, "no_matching_media");
});

test("video requests are not classified as photo requests and do not deliver photos", () => {
  const phrases = [
    "send me a video",
    "show me a video from the gym",
    "can I see a clip",
    "schick mir ein video",
  ];
  for (const text of phrases) {
    const signal = readSalesSignal([text]);
    assert.equal(signal.explicitMediaRequest, false, text);
    assert.notEqual(signal.intent, "MEDIA_REQUEST", text);
    const decision = decideSales({
      signal,
      assets: [homeAsset, gymAsset],
      offers: [showerOffer()],
      purchasedOfferIds: new Set(),
      interactions: [],
      priorFreeMediaAt: null,
    });
    assert.notEqual(decision.decision, "FREE_MEDIA", text);
  }
  const photoAndVideo = readSalesSignal(["send me a pic and a video"]);
  assert.equal(photoAndVideo.explicitMediaRequest, true);
});

test("safety invariants: paid wins, locked excluded, anti-repeat, 15m cooldown, user-offered photos", () => {
  const paid = decideSales({
    signal: readSalesSignal(["show me your underwear"]),
    assets: [homeAsset],
    offers: [showerOffer()],
    purchasedOfferIds: new Set(),
    interactions: [],
    priorFreeMediaAt: null,
  });
  assert.equal(paid.decision, "PAID_OFFER");

  const locked: MediaCandidate = { ...gymAsset, id: "locked-gym", freeEligible: false };
  assert.equal(selectFreeMedia(readSalesSignal(["show me a picture from the gym"]), [locked]), null);

  const sent = [{ mediaAssetId: gymAsset.id, sentAt: new Date("2026-10-01T10:00:00Z") }];
  assert.equal(selectFreeMedia(readSalesSignal(["show me a picture from the gym"]), [gymAsset], "UNKNOWN", 0, sent), null);

  const cooled = decideSales({
    signal: readSalesSignal(["send me a pic"]),
    assets: [homeAsset],
    offers: [],
    purchasedOfferIds: new Set(),
    interactions: [],
    priorFreeMediaAt: new Date("2026-10-03T11:50:00Z"),
    now: new Date("2026-10-03T12:00:00Z"),
  });
  assert.equal(cooled.decision, "SUPPRESS");
  assert.equal(cooled.reasonCode, "free_media_cooldown");

  const offered = readSalesSignal(["Do you want to see a new picture of me?"]);
  assert.equal(offered.explicitMediaRequest, false);
  assert.equal(offered.mediaInterest, false);
});
