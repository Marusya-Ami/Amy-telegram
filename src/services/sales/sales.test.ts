import assert from "node:assert/strict";
import test from "node:test";
import type { TelegramUpdate } from "@/lib/telegram/types";
import { salesEngineMode } from "@/services/sales/mode";
import { capOrdinaryFlirt } from "@/services/sales/schema";
import { readSalesSignal } from "@/services/sales/signals";
import { decideSales, paidOfferGuard, type MediaCandidate, type OfferCandidate, type OfferInteractionFact } from "@/services/sales/decide";
import { classifySalesAdminCommand, formatSalesDecision, formatSalesRecent } from "@/services/sales/inspect";

const NOW = new Date("2026-09-25T18:00:00.000Z");

test("owner sales commands require the numeric owner id", () => {
  const last = commandUpdate("42", "/sales_last");
  assert.equal(classifySalesAdminCommand(last, ""), null);
  assert.equal(classifySalesAdminCommand(last, "99"), null);
  assert.equal(classifySalesAdminCommand(last, "42")?.recent, false);
  assert.equal(classifySalesAdminCommand(commandUpdate("42", "/sales_recent"), "42")?.recent, true);
  assert.equal(classifySalesAdminCommand({ ...last, business_message: last.message, message: undefined }, "42"), null);
  assert.equal(classifySalesAdminCommand(commandUpdate("42", "/sales_last extra"), "42"), null);
});

test("ordinary chat is NO_OFFER", () => {
  const decision = decideText("hey, how was work?");
  assert.equal(decision.decision, "NO_OFFER");
  assert.equal(decision.signal.intent, "NONE");
  assert.equal(decision.signal.commercialReadiness, "LOW");
  assert.equal(decision.candidateOfferId, null);
  assert.equal(decision.candidateMediaAssetId, null);
});

test("an explicit photo request selects free media", () => {
  const decision = decideText("send me a pic");
  assert.equal(decision.decision, "FREE_MEDIA");
  assert.equal(decision.signal.intent, "MEDIA_REQUEST");
  assert.equal(decision.signal.explicitMediaRequest, true);
  assert.equal(decision.candidateMediaAssetId, "media-home");
  assert.equal(decision.candidateOfferId, null);
});

test("asking what Amy is wearing is not a paid offer", () => {
  const decision = decideText("what are you wearing?");
  assert.equal(decision.signal.mediaInterest, true);
  assert.notEqual(decision.signal.commercialReadiness, "HIGH");
  assert.notEqual(decision.decision, "PAID_OFFER");
  assert.equal(decision.candidateOfferId, null);
});

test("Tom regression: German underwear request routes to PAID_OFFER", () => {
  const variations = [
    "Zeigst du mir dein Höschen?",
    "zeig mir dein höschen",
    "hast du Bilder in Unterwäsche?",
    "hast du Dessous Fotos?",
    "schick mir ein nacktbild",
    "bist du nackt?",
  ];
  for (const text of variations) {
    const decision = decideText(text);
    assert.equal(decision.signal.intent, "PREMIUM_MEDIA_REQUEST", `Failed on: ${text}`);
    assert.equal(decision.signal.commercialReadiness, "HIGH", `Failed on: ${text}`);
    assert.equal(decision.decision, "PAID_OFFER", `Failed on: ${text}`);
    assert.equal(decision.candidateSlug, "shower-time");
  }
});

test("Tom regression: German hotter/private request routes to PAID_OFFER", () => {
  const variations = [
    "hast du ein heißeres Bild?",
    "hast du ein heisseres Bild?",
    "ich möchte private Fotos sehen",
    "hast du exklusive Fotos?",
    "kann ich das freischalten?",
    "was kostet das?",
    "wieviel kostet das freischalten?",
  ];
  for (const text of variations) {
    const decision = decideText(text);
    assert.ok(
      decision.signal.intent === "PREMIUM_MEDIA_REQUEST" || decision.signal.intent === "PURCHASE_DISCUSSION",
      `Failed on: ${text}`,
    );
    assert.equal(decision.signal.commercialReadiness, "HIGH", `Failed on: ${text}`);
    assert.equal(decision.decision, "PAID_OFFER", `Failed on: ${text}`);
    assert.equal(decision.candidateSlug, "shower-time");
  }
});

test("Tom regression: explicit casual normal photo request routes to FREE_MEDIA", () => {
  const variations = [
    "Schick mir ein Foto",
    "Kann ich ein Bild sehen?",
    "Kann ich ein Foto von dir sehen?",
    "Zeig mir ein Bild",
  ];
  for (const text of variations) {
    const decision = decideText(text);
    assert.equal(decision.signal.intent, "MEDIA_REQUEST", `Failed on: ${text}`);
    assert.equal(decision.signal.commercialReadiness, "LOW", `Failed on: ${text}`);
    assert.equal(decision.decision, "FREE_MEDIA", `Failed on: ${text}`);
    assert.equal(decision.candidateMediaAssetId, "media-home");
  }
});

test("Tom regression: 3 rapid explicit free requests cannot produce 3 free photos", () => {
  // First request: no prior free media -> FREE_MEDIA
  const t0 = NOW;
  const d1 = decideText("send me a pic", { now: t0, priorFreeMediaAt: null });
  assert.equal(d1.decision, "FREE_MEDIA");

  // Second request: 10 seconds later, explicit request -> SUPPRESS (cooldown)
  const t1 = new Date(t0.getTime() + 10 * 1000);
  const d2 = decideText("send me another pic", { now: t1, priorFreeMediaAt: t0 });
  assert.equal(d2.decision, "SUPPRESS");
  assert.equal(d2.reasonCode, "free_media_cooldown");

  // Third request: 60 seconds later, explicit request -> SUPPRESS (cooldown)
  const t2 = new Date(t0.getTime() + 60 * 1000);
  const d3 = decideText("give me a photo please", { now: t2, priorFreeMediaAt: t0 });
  assert.equal(d3.decision, "SUPPRESS");
  assert.equal(d3.reasonCode, "free_media_cooldown");
});

test("Tom regression: exhausted free library does not recycle previous media", () => {
  const assetA: MediaCandidate = {
    id: "media-a",
    category: "selfie",
    tags: ["casual_selfie"],
    mood: "relaxed",
    flirtLevel: 1,
    contexts: ["casual_selfie"],
    active: true,
  };
  const deliveries = [{ mediaAssetId: "media-a", sentAt: new Date(NOW.getTime() - 30 * 60 * 1000) }];
  const decision = decideText("send me a pic", {
    assets: [assetA],
    mediaDeliveries: deliveries,
    priorFreeMediaAt: new Date(NOW.getTime() - 30 * 60 * 1000), // outside 15m cooldown
  });
  // Must NOT recycle media-a! Must return NO_OFFER
  assert.equal(decision.decision, "NO_OFFER");
  assert.equal(decision.reasonCode, "no_matching_media");
  assert.equal(decision.candidateMediaAssetId, null);
});

test("Charlie regression: 'Do you want to see a new picture of me' produces no outbound media", () => {
  const variations = [
    "Do you want to see a new picture of me?",
    "Want to see me?",
    "Can I send you my picture?",
    "Let me show you a photo",
    "Willst du ein Foto von mir sehen?",
    "Kann ich dir ein Bild von mir schicken?",
  ];
  for (const text of variations) {
    const decision = decideText(text);
    assert.equal(decision.signal.mediaInterest, false, `Failed on: ${text}`);
    assert.equal(decision.signal.explicitMediaRequest, false, `Failed on: ${text}`);
    assert.equal(decision.decision, "NO_OFFER", `Failed on: ${text}`);
    assert.equal(decision.candidateMediaAssetId, null, `Failed on: ${text}`);
  }
});

test("a private photo request selects the active offer", () => {
  const decision = decideText("do you have any private pics?");
  assert.equal(decision.signal.intent, "PREMIUM_MEDIA_REQUEST");
  assert.equal(decision.signal.commercialReadiness, "HIGH");
  assert.equal(decision.decision, "PAID_OFFER");
  assert.equal(decision.candidateSlug, "shower-time");
});

test("a price question selects the active offer", () => {
  const decision = decideText("how much are your private pics?");
  assert.equal(decision.signal.intent, "PURCHASE_DISCUSSION");
  assert.equal(decision.signal.commercialReadiness, "HIGH");
  assert.equal(decision.decision, "PAID_OFFER");
  assert.equal(decision.candidateSlug, "shower-time");
});

test("a purchase refusal suppresses a paid offer", () => {
  const decision = decideText("no thanks, not buying");
  assert.equal(decision.decision, "SUPPRESS");
  assert.equal(decision.reasonCode, "user_declined");
  assert.equal(decision.candidateOfferId, null);
});

test("distress suppresses monetization and leaves no candidate", () => {
  const decision = decideText("i want to die. do you have any private pics?");
  assert.equal(decision.signal.emotionalState, "DISTRESSED");
  assert.equal(decision.decision, "NO_OFFER");
  assert.equal(decision.reasonCode, "distress");
  assert.equal(decision.candidateOfferId, null);
  assert.equal(decision.candidateMediaAssetId, null);
});

test("paid selection follows priority and ignores tags, contexts, and unsellable offers", () => {
  const later = { ...showerOffer(), id: "offer-later", slug: "later-pack", tags: [], contexts: [], priority: 2 };
  const first = { ...showerOffer(), id: "offer-first", slug: "first-pack", tags: [], contexts: [], priority: 1 };
  const droppOnly = { ...showerOffer(), id: "offer-dropp", slug: "dropp-only", tags: ["private"], contexts: ["flirty"], priority: 0, hasActivePrice: false };
  const decision = decideText("do you have any private pics?", { offers: [later, droppOnly, first] });
  assert.equal(decision.decision, "PAID_OFFER");
  assert.equal(decision.candidateSlug, "first-pack");
});

test("a cooled offer is skipped for the next sellable offer once the global gap has passed", () => {
  const first = { ...showerOffer(), id: "offer-first", slug: "first-pack", priority: 1 };
  const second = { ...showerOffer(), id: "offer-second", slug: "second-pack", tags: [], contexts: [], priority: 2 };
  const decision = decideText("do you have any private pics?", {
    offers: [first, second],
    interactions: [{ offerId: "offer-first", type: "SHOWN", createdAt: new Date(NOW.getTime() - 5 * 60 * 60 * 1000) }],
  });
  assert.equal(decision.decision, "PAID_OFFER");
  assert.equal(decision.candidateSlug, "second-pack");
});

test("a purchased offer is excluded", () => {
  const decision = decideText("do you have any private pics?", { purchasedOfferIds: new Set(["offer-shower"]) });
  assert.equal(decision.decision, "NO_OFFER");
  assert.equal(decision.reasonCode, "already_purchased");
  assert.equal(decision.candidateOfferId, null);
});

test("a recently shown unpaid offer is suppressed", () => {
  const decision = decideText("do you have any private pics?", {
    interactions: [{ offerId: "offer-shower", type: "SHOWN", createdAt: new Date(NOW.getTime() - 60 * 60 * 1000) }],
  });
  assert.equal(decision.decision, "SUPPRESS");
  assert.equal(decision.reasonCode, "recent_same_offer");
});

test("another paid offer inside four hours suppresses a new one", () => {
  const decision = decideText("do you have any private pics?", {
    interactions: [{ offerId: "other-offer", type: "SHOWN", createdAt: new Date(NOW.getTime() - 60 * 60 * 1000) }],
  });
  assert.equal(decision.decision, "SUPPRESS");
  assert.equal(decision.reasonCode, "recent_paid_offer");
});

test("the paid offer daily cap suppresses another offer", () => {
  const interactions: OfferInteractionFact[] = [
    { offerId: "other-a", type: "SHOWN", createdAt: new Date(NOW.getTime() - 5 * 60 * 60 * 1000) },
    { offerId: "other-b", type: "SHOWN", createdAt: new Date(NOW.getTime() - 6 * 60 * 60 * 1000) },
  ];
  const decision = decideText("how much are your private pics?", { interactions });
  assert.equal(decision.decision, "SUPPRESS");
  assert.equal(decision.reasonCode, "paid_daily_cap");
});

test("ordinary flirting stays below HIGH commercial readiness", () => {
  const reading = readSalesSignal(["you're so pretty"]);
  assert.equal(reading.intent, "FLIRT");
  assert.equal(reading.commercialReadiness, "LOW");
  const forced = decideText("you're so pretty", {
    signal: { ...reading, commercialReadiness: "HIGH" },
    declinedNow: false,
  });
  assert.equal(forced.signal.commercialReadiness, "LOW");
  assert.equal(forced.decision, "NO_OFFER");
  assert.equal(capOrdinaryFlirt({ ...reading, commercialReadiness: "HIGH" }).commercialReadiness, "LOW");
});

test("no matching active offer is not invented", () => {
  const decision = decideText("do you have any private pics?", { offers: [] });
  assert.equal(decision.decision, "NO_OFFER");
  assert.equal(decision.reasonCode, "no_relevant_offer");
  assert.equal(decision.candidateOfferId, null);
  assert.equal(decision.candidateSlug, null);
});

test("a sales failure does not change Amy's reply", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { processTextBurst } = await import("@/services/messageProcessor/runTurn");
  const telegramUserId = uniqueId();
  const user = await prisma.user.create({ data: { telegramUserId, firstName: "Test" } });
  const conversation = await prisma.conversation.create({
    data: { userId: user.id, platform: "telegram", platformConversationId: telegramUserId },
  });
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      userId: user.id,
      direction: "INBOUND",
      sender: "USER",
      type: "TEXT",
      text: "send me a pic",
      telegramMessageId: `${telegramUserId}-1`,
      metadata: { kind: "text", processed: false },
    },
  });
  try {
    await processTextBurst(user.id, {
      generate: async () => ["just talking"],
      send: async () => ({ messageId: "sent-1" }),
      sleep: async () => undefined,
      delayMs: () => 0,
      observeSales: async () => {
        throw new Error("sales down");
      },
    });
    const outbound = await prisma.message.findMany({ where: { userId: user.id, direction: "OUTBOUND" } });
    assert.deepEqual(outbound.map((message) => message.text), ["just talking"]);
    assert.equal(await prisma.salesDecision.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.paymentIntent.count({ where: { userId: user.id } }), 0);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
});

test("shadow mode records a decision without a payment or a shown event", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { observeSalesTurn } = await import("@/services/sales/observe");
  const telegramUserId = uniqueId();
  const user = await prisma.user.create({ data: { telegramUserId } });
  const conversation = await prisma.conversation.create({
    data: { userId: user.id, platform: "telegram-business", platformConversationId: telegramUserId, businessConnectionId: "conn-shadow" },
  });
  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      userId: user.id,
      direction: "INBOUND",
      sender: "USER",
      type: "TEXT",
      text: "do you have any private pics?",
      telegramMessageId: `${telegramUserId}-1`,
      metadata: { kind: "text", processed: true },
    },
  });
  const offer = await prisma.paymentOffer.create({
    data: {
      slug: `sales-shadow-${telegramUserId}`,
      title: "Shadow fixture",
      description: "test",
      kind: "PAID_CONTENT",
      tags: ["private", "shower"],
      contexts: ["flirty", "shower", "private_photos"],
      flirtLevel: 2,
      active: true,
      prices: { create: { provider: "TELEGRAM_STARS", amount: 420, currency: "XTR", active: true } },
    },
  });
  try {
    await observeSalesTurn(
      {
        userId: user.id,
        conversationId: conversation.id,
        triggerMessageId: message.id,
        userTexts: ["do you have any private pics?"],
        amyTexts: ["just talking"],
      },
      {
        mode: "shadow",
        loadCatalog: async () => ({
          assets: [],
          offers: [{
            id: offer.id,
            slug: "shower-time",
            tags: ["private", "shower"],
            contexts: ["flirty", "shower", "private_photos"],
            flirtLevel: 2,
            active: true,
            hasActivePrice: true, priority: 1,
          }],
          purchasedOfferIds: [],
          interactions: [],
          priorFreeMediaAt: null,
          mediaDeliveries: [],
          dynamic: "EQUAL",
          dynamicConfidence: 0.9,
        }),
      },
    );
    const row = await prisma.salesDecision.findFirstOrThrow({ where: { userId: user.id } });
    assert.equal(row.mode, "SHADOW");
    assert.equal(row.decision, "PAID_OFFER");
    assert.equal(row.candidateOfferId, offer.id);
    assert.equal(row.reasonSummary?.includes("private pics"), false);
    assert.equal(await prisma.paymentIntent.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.payment.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.userOfferInteraction.count({ where: { userId: user.id } }), 0);
    const formatted = formatSalesDecision({
      createdAt: row.createdAt,
      decision: row.decision,
      intent: row.intent,
      commercialReadiness: row.commercialReadiness,
      confidence: row.confidence,
      desiredContexts: row.desiredContexts,
      reasonSummary: row.reasonSummary,
      candidateOfferSlug: "shower-time",
      candidateMediaId: null,
      candidateMediaCategory: null,
    });
    assert.match(formatted, /Decision: PAID_OFFER/);
    assert.match(formatted, /Candidate: shower-time/);
    assert.doesNotMatch(formatted, /private pics\?/);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
    await prisma.paymentOfferPrice.deleteMany({ where: { offerId: offer.id } });
    await prisma.paymentOffer.delete({ where: { id: offer.id } }).catch(() => undefined);
  }
});

test("off mode stores nothing", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { observeSalesTurn } = await import("@/services/sales/observe");
  const telegramUserId = uniqueId();
  const user = await prisma.user.create({ data: { telegramUserId } });
  const conversation = await prisma.conversation.create({
    data: { userId: user.id, platform: "telegram", platformConversationId: telegramUserId },
  });
  try {
    await observeSalesTurn(
      {
        userId: user.id,
        conversationId: conversation.id,
        triggerMessageId: null,
        userTexts: ["send me a pic"],
        amyTexts: ["hey"],
      },
      { mode: "off" },
    );
    assert.equal(await prisma.salesDecision.count({ where: { userId: user.id } }), 0);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
});

test("inspection text stays compact and omits chat text", () => {
  const when = new Date("2026-09-25T18:05:00.000Z");
  const recent = formatSalesRecent([
    {
      createdAt: when,
      decision: "SUPPRESS",
      intent: "PREMIUM_MEDIA_REQUEST",
      commercialReadiness: "HIGH",
      confidence: 0.92,
      desiredContexts: ["flirty"],
      reasonSummary: "recent paid offer",
      candidateOfferSlug: null,
      candidateMediaId: null,
      candidateMediaCategory: null,
    },
  ]);
  assert.match(recent, /SUPPRESS/);
  assert.match(recent, /recent paid offer/);
  assert.equal(recent.includes("\n\n"), false);
});

test("invalid sales mode is off and only shadow is enabled", () => {
  assert.equal(salesEngineMode(undefined), "off");
  assert.equal(salesEngineMode(""), "off");
  assert.equal(salesEngineMode("live"), "off");
  assert.equal(salesEngineMode("shadow"), "shadow");
});

test("OWNER_TEST interactions are ignored by sales cooldowns and guards", () => {
  const signal = {
    mediaInterest: true,
    explicitMediaRequest: true,
    premiumInterest: true,
    intent: "PREMIUM_MEDIA_REQUEST" as const,
    flirtLevel: 3,
    desiredContexts: ["flirty", "private_photos"],
    commercialReadiness: "HIGH" as const,
    emotionalState: "NORMAL" as const,
    confidence: 0.92,
    evidence: ["hotter"],
    declinedNow: false,
  };

  // 1. Same-offer cooldown ignored for OWNER_TEST
  const sameOfferTest: OfferInteractionFact[] = [
    { offerId: "offer-shower", type: "SHOWN", source: "OWNER_TEST", createdAt: new Date(NOW.getTime() - 60 * 60 * 1000) },
  ];
  const decisionSame = decideSales({
    signal,
    declinedNow: false,
    assets: [homeSelfie()],
    offers: [showerOffer()],
    purchasedOfferIds: new Set<string>(),
    interactions: sameOfferTest,
    priorFreeMediaAt: null,
    dynamic: "UNKNOWN",
    dynamicConfidence: 0,
    now: NOW,
  });
  assert.equal(decisionSame.decision, "PAID_OFFER");
  assert.equal(decisionSame.candidateOfferId, "offer-shower");

  // 2. Global interval (4h) ignored for OWNER_TEST
  const globalTest: OfferInteractionFact[] = [
    { offerId: "other-offer", type: "SHOWN", source: "OWNER_TEST", createdAt: new Date(NOW.getTime() - 30 * 60 * 1000) },
  ];
  const decisionGlobal = decideSales({
    signal,
    declinedNow: false,
    assets: [homeSelfie()],
    offers: [showerOffer()],
    purchasedOfferIds: new Set<string>(),
    interactions: globalTest,
    priorFreeMediaAt: null,
    dynamic: "UNKNOWN",
    dynamicConfidence: 0,
    now: NOW,
  });
  assert.equal(decisionGlobal.decision, "PAID_OFFER");

  // 3. Paid daily cap (2/24h) ignored for OWNER_TEST
  const dailyCapTest: OfferInteractionFact[] = [
    { offerId: "other-1", type: "SHOWN", source: "OWNER_TEST", createdAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000) },
    { offerId: "other-2", type: "SHOWN", source: "OWNER_TEST", createdAt: new Date(NOW.getTime() - 5 * 60 * 60 * 1000) },
  ];
  const decisionCap = decideSales({
    signal,
    declinedNow: false,
    assets: [homeSelfie()],
    offers: [showerOffer()],
    purchasedOfferIds: new Set<string>(),
    interactions: dailyCapTest,
    priorFreeMediaAt: null,
    dynamic: "UNKNOWN",
    dynamicConfidence: 0,
    now: NOW,
  });
  assert.equal(decisionCap.decision, "PAID_OFFER");

  // 4. DECLINED cooldown ignored for OWNER_TEST
  const declinedTest: OfferInteractionFact[] = [
    { offerId: "offer-shower", type: "DECLINED", source: "OWNER_TEST", createdAt: new Date(NOW.getTime() - 60 * 60 * 1000) },
  ];
  const decisionDeclined = decideSales({
    signal,
    declinedNow: false,
    assets: [homeSelfie()],
    offers: [showerOffer()],
    purchasedOfferIds: new Set<string>(),
    interactions: declinedTest,
    priorFreeMediaAt: null,
    dynamic: "UNKNOWN",
    dynamicConfidence: 0,
    now: NOW,
  });
  assert.equal(decisionDeclined.decision, "PAID_OFFER");

  // 5. paidOfferGuard ignores OWNER_TEST rows
  assert.equal(paidOfferGuard({
    offerId: "offer-shower",
    purchased: false,
    interactions: sameOfferTest,
    confidence: 0.9,
    emotionalState: "NORMAL",
    declinedNow: false,
    now: NOW,
  }), null);

  assert.equal(paidOfferGuard({
    offerId: "offer-shower",
    purchased: false,
    interactions: globalTest,
    confidence: 0.9,
    emotionalState: "NORMAL",
    declinedNow: false,
    now: NOW,
  }), null);

  assert.equal(paidOfferGuard({
    offerId: "offer-shower",
    purchased: false,
    interactions: dailyCapTest,
    confidence: 0.9,
    emotionalState: "NORMAL",
    declinedNow: false,
    now: NOW,
  }), null);

  assert.equal(paidOfferGuard({
    offerId: "offer-shower",
    purchased: false,
    interactions: declinedTest,
    confidence: 0.9,
    emotionalState: "NORMAL",
    declinedNow: false,
    now: NOW,
  }), null);

  // 6. Real non-OWNER_TEST rows (SALES_ENGINE) still block as expected
  const realSameOffer: OfferInteractionFact[] = [
    { offerId: "offer-shower", type: "SHOWN", source: "SALES_ENGINE", createdAt: new Date(NOW.getTime() - 60 * 60 * 1000) },
  ];
  assert.equal(paidOfferGuard({
    offerId: "offer-shower",
    purchased: false,
    interactions: realSameOffer,
    confidence: 0.9,
    emotionalState: "NORMAL",
    declinedNow: false,
    now: NOW,
  }), "recent_same_offer");

  const realDailyCap: OfferInteractionFact[] = [
    { offerId: "other-1", type: "SHOWN", source: "SALES_ENGINE", createdAt: new Date(NOW.getTime() - 5 * 60 * 60 * 1000) },
    { offerId: "other-2", type: "SHOWN", source: "SALES_ENGINE", createdAt: new Date(NOW.getTime() - 6 * 60 * 60 * 1000) },
  ];
  assert.equal(paidOfferGuard({
    offerId: "offer-shower",
    purchased: false,
    interactions: realDailyCap,
    confidence: 0.9,
    emotionalState: "NORMAL",
    declinedNow: false,
    now: NOW,
  }), "paid_daily_cap");
});

function decideText(
  text: string,
  extra: Partial<Parameters<typeof decideSales>[0]> = {},
) {
  const reading = readSalesSignal([text]);
  return decideSales({
    signal: extra.signal ?? reading,
    declinedNow: extra.declinedNow ?? reading.declinedNow,
    assets: extra.assets ?? [homeSelfie()],
    offers: extra.offers ?? [showerOffer()],
    purchasedOfferIds: extra.purchasedOfferIds ?? new Set<string>(),
    interactions: extra.interactions ?? [],
    priorFreeMediaAt: extra.priorFreeMediaAt ?? null,
    mediaDeliveries: extra.mediaDeliveries,
    dynamic: extra.dynamic ?? "UNKNOWN",
    dynamicConfidence: extra.dynamicConfidence ?? 0,
    now: extra.now ?? NOW,
  });
}

function showerOffer(): OfferCandidate {
  return {
    id: "offer-shower",
    slug: "shower-time",
    tags: ["private", "shower"],
    contexts: ["flirty", "shower", "private_photos"],
    flirtLevel: 2,
    active: true,
    hasActivePrice: true, priority: 1,
  };
}

function homeSelfie(): MediaCandidate {
  return {
    id: "media-home",
    category: "selfie",
    tags: ["casual_selfie"],
    mood: "relaxed",
    flirtLevel: 1,
    contexts: ["casual_selfie", "at_home"],
    active: true,
  };
}

function commandUpdate(id: string, text: string): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: Number(id), type: "private" },
      from: { id: Number(id), is_bot: false },
      text,
    },
  };
}

function uniqueId(): string {
  return String(7_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
}
