import assert from "node:assert/strict";
import test from "node:test";
import type { InteractionDynamic } from "@prisma/client";
import { buildReplyMessages } from "@/services/amyBrain";
import { commercialAction, decideSales, PAID_OFFER_REPLY_HINT, paidOfferReplyContext, type MediaCandidate, type OfferCandidate, type OfferInteractionFact } from "@/services/sales/decide";
import { replyCommercialHint } from "@/services/sales/observe";
import { readSalesSignal, type SalesContext } from "@/services/sales/signals";
import { contextualTipReading, type TipContextMessage } from "@/services/sales/tipContext";

const NOW = new Date("2026-10-01T18:00:00.000Z");

type Scenario = {
  name: string;
  text: string;
  context?: SalesContext;
  dynamic?: InteractionDynamic;
  purchased?: boolean;
  interactions?: OfferInteractionFact[];
  priorFreeMediaAt?: Date | null;
  offers?: OfferCandidate[];
  tipHistory?: TipContextMessage[];
  expected: "NONE" | "FREE_MEDIA" | "PAID_OFFER" | "TIP";
  reason: string;
  slug: string | null;
};

const bridge: SalesContext = { recentFreePhoto: true, recentTexts: ["just a flirty one 😏"] };
const scenarios: Scenario[] = [
  { name: "ordinary pic", text: "send me a pic", expected: "FREE_MEDIA", reason: "explicit_media_request", slug: null },
  { name: "see you", text: "can i see you?", expected: "FREE_MEDIA", reason: "explicit_media_request", slug: null },
  { name: "wearing", text: "what are you wearing?", expected: "FREE_MEDIA", reason: "contextual_media", slug: null },
  { name: "russian ordinary", text: "покажешь себя?", expected: "FREE_MEDIA", reason: "explicit_media_request", slug: null },
  { name: "russian photo", text: "пришли фотку", expected: "FREE_MEDIA", reason: "explicit_media_request", slug: null },
  { name: "spanish photo", text: "mándame una foto", expected: "FREE_MEDIA", reason: "explicit_media_request", slug: null },
  { name: "private pics", text: "do you have anything more private?", expected: "PAID_OFFER", reason: "premium_request", slug: "shower-time" },
  { name: "hotter", text: "got anything hotter?", expected: "PAID_OFFER", reason: "premium_request", slug: "shower-time" },
  { name: "russian hotter", text: "есть что-нибудь погорячее?", expected: "PAID_OFFER", reason: "premium_request", slug: "shower-time" },
  { name: "russian private", text: "покажи что-нибудь приватное", expected: "PAID_OFFER", reason: "premium_request", slug: "shower-time" },
  { name: "sell pics", text: "do you sell pics?", expected: "PAID_OFFER", reason: "premium_request", slug: "shower-time" },
  { name: "private pics short", text: "private pics?", expected: "PAID_OFFER", reason: "premium_request", slug: "shower-time" },
  { name: "spanish private", text: "tienes algo más privado?", expected: "PAID_OFFER", reason: "premium_request", slug: "shower-time" },
  { name: "more without photo", text: "more?", expected: "NONE", reason: "no_commercial_signal", slug: null },
  { name: "more after photo", text: "more?", context: bridge, expected: "PAID_OFFER", reason: "premium_request", slug: "shower-time" },
  { name: "show more without photo", text: "show me more", expected: "FREE_MEDIA", reason: "explicit_media_request", slug: null },
  { name: "show more after photo", text: "show me more", context: bridge, expected: "PAID_OFFER", reason: "premium_request", slug: "shower-time" },
  { name: "what else without photo", text: "what else do you have?", expected: "NONE", reason: "no_commercial_signal", slug: null },
  { name: "what else after photo", text: "what else do you have?", context: bridge, expected: "PAID_OFFER", reason: "premium_request", slug: "shower-time" },
  { name: "mild compliment", text: "you look beautiful", context: bridge, expected: "NONE", reason: "no_commercial_signal", slug: null },
  { name: "cute", text: "cute", context: bridge, expected: "NONE", reason: "no_commercial_signal", slug: null },
  { name: "nice pic", text: "nice pic", context: bridge, expected: "NONE", reason: "no_commercial_signal", slug: null },
  { name: "love cute pic", text: "love that cute pic", context: bridge, expected: "FREE_MEDIA", reason: "contextual_media", slug: null },
  { name: "hot after photo", text: "you look so hot", context: bridge, expected: "PAID_OFFER", reason: "premium_request", slug: "shower-time" },
  { name: "hot without photo", text: "you look so hot", expected: "NONE", reason: "no_commercial_signal", slug: null },
  { name: "damn after photo", text: "damn 😍", context: bridge, expected: "PAID_OFFER", reason: "premium_request", slug: "shower-time" },
  { name: "damn alone", text: "damn", expected: "NONE", reason: "no_commercial_signal", slug: null },
  { name: "something better after photo", text: "you have something better?", context: bridge, expected: "PAID_OFFER", reason: "premium_request", slug: "shower-time" },
  { name: "neutral", text: "hey, how was work?", expected: "NONE", reason: "no_commercial_signal", slug: null },
  { name: "distress", text: "i want to die. do you have any private pics?", expected: "NONE", reason: "distress", slug: null },
  { name: "russian distress", text: "мне очень плохо", expected: "NONE", reason: "distress", slug: null },
  { name: "tip", text: "can I tip you?", expected: "TIP", reason: "tip_request", slug: null },
  { name: "support", text: "how can I support you?", expected: "TIP", reason: "tip_request", slug: null },
  { name: "spoil", text: "let me spoil you", expected: "TIP", reason: "tip_request", slug: null },
  { name: "russian tip", text: "хочу тебя поддержать", expected: "TIP", reason: "tip_request", slug: null },
  { name: "russian tip where", text: "куда тебе чаевые?", expected: "TIP", reason: "tip_request", slug: null },
  { name: "spanish tip", text: "te puedo dejar una propina", expected: "TIP", reason: "tip_request", slug: null },
  { name: "tip is not a photo payment", text: "I'll tip if you send me a private photo", expected: "PAID_OFFER", reason: "premium_request", slug: "shower-time" },
  {
    name: "tip follow-up",
    text: "send it",
    tipHistory: [{ createdAt: new Date(NOW.getTime() - 60 * 1000), sender: "USER", text: "can I tip you?" }],
    expected: "TIP",
    reason: "tip_request",
    slug: null,
  },
  {
    name: "paid cooldown",
    text: "private pics?",
    interactions: [{ offerId: "offer-shower", type: "SHOWN", createdAt: new Date(NOW.getTime() - 60 * 60 * 1000) }],
    expected: "NONE",
    reason: "recent_same_offer",
    slug: null,
  },
  {
    name: "already purchased",
    text: "got anything hotter?",
    purchased: true,
    expected: "NONE",
    reason: "already_purchased",
    slug: null,
  },
  { name: "decline", text: "no thanks, not buying", expected: "NONE", reason: "user_declined", slug: null },
  {
    name: "recent decline",
    text: "private pics?",
    interactions: [{ offerId: "offer-shower", type: "DECLINED", createdAt: new Date(NOW.getTime() - 60 * 60 * 1000) }],
    expected: "NONE",
    reason: "user_declined",
    slug: null,
  },
  {
    name: "repeat photo inside cooldown blocked",
    text: "send me a pic",
    priorFreeMediaAt: new Date(NOW.getTime() - 5 * 60 * 1000),
    expected: "NONE",
    reason: "free_media_cooldown",
    slug: null,
  },
  {
    name: "repeat photo after cooldown allowed",
    text: "send me a pic",
    priorFreeMediaAt: new Date(NOW.getTime() - 20 * 60 * 1000),
    expected: "FREE_MEDIA",
    reason: "explicit_media_request",
    slug: null,
  },
  { name: "dominant amy", text: "private pics?", dynamic: "DOMINANT_AMY", expected: "PAID_OFFER", reason: "premium_request", slug: "shower-time" },
  { name: "dominant user", text: "send me a pic", dynamic: "DOMINANT_USER", expected: "FREE_MEDIA", reason: "explicit_media_request", slug: null },
  { name: "equal dynamic", text: "hey, how was work?", dynamic: "EQUAL", expected: "NONE", reason: "no_commercial_signal", slug: null },
  { name: "unknown dynamic compliment", text: "you're so pretty", dynamic: "UNKNOWN", expected: "NONE", reason: "no_commercial_signal", slug: null },
];

test("launch scenarios choose one commercial action", () => {
  assert.ok(scenarios.length >= 30);
  const misses: string[] = [];
  for (const scenario of scenarios) {
    const history = scenario.tipHistory ?? [];
    const contextual = contextualTipReading({ now: NOW, currentUserLines: [scenario.text], history });
    const reading = contextual ?? readSalesSignal([scenario.text], scenario.context);
    const decision = decideSales({
      signal: reading,
      declinedNow: reading.declinedNow,
      assets: [homeSelfie()],
      offers: scenario.offers ?? [showerOffer()],
      purchasedOfferIds: scenario.purchased ? new Set(["offer-shower"]) : new Set<string>(),
      interactions: scenario.interactions ?? [],
      priorFreeMediaAt: scenario.priorFreeMediaAt ?? null,
      dynamic: scenario.dynamic ?? "UNKNOWN",
      dynamicConfidence: scenario.dynamic && scenario.dynamic !== "UNKNOWN" ? 0.9 : 0,
      now: NOW,
    });
    const action = commercialAction(decision.decision);
    const slug = decision.candidateSlug;
    if (action !== scenario.expected || decision.reasonCode !== scenario.reason || slug !== scenario.slug) {
      misses.push(`${scenario.name}: expected ${scenario.expected}/${scenario.reason}/${scenario.slug} got ${action}/${decision.reasonCode}/${slug}`);
    }
    assert.equal(decision.decision === "FREE_MEDIA" ? decision.candidateOfferId : null, null);
  }
  assert.deepEqual(misses, []);
});

test("a paid reply hint never names a price and stays off in shadow", async () => {
  assert.equal(paidOfferReplyContext("PAID_OFFER", "shadow"), null);
  assert.equal(paidOfferReplyContext("FREE_MEDIA", "live"), null);
  assert.equal(paidOfferReplyContext("PAID_OFFER", "live"), PAID_OFFER_REPLY_HINT);
  assert.match(PAID_OFFER_REPLY_HINT, /Do not mention price/);
  assert.equal(/\b420\b|https?:/i.test(PAID_OFFER_REPLY_HINT), false);
  const messages = buildReplyMessages(
    { relationshipStage: "ENGAGED", conversationSummary: null, firstName: "Mari" },
    [],
    ["got anything hotter?"],
    [],
    "",
    "",
    PAID_OFFER_REPLY_HINT,
  );
  const system = String(messages[0]?.content ?? "");
  assert.match(system, /private photo set/);
  assert.equal(system.includes("420"), false);
  assert.equal(system.includes("http"), false);
  assert.equal(await replyCommercialHint({ userId: "missing", conversationId: "missing", userTexts: ["private pics?"], mode: "shadow" }), null);
});

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

function homeSelfie(): MediaCandidate {
  return {
    id: "media-home",
    category: "selfie",
    tags: ["casual_selfie"],
    mood: "relaxed",
    flirtLevel: 1,
    contexts: ["casual_selfie", "at_home", "flirty"],
    active: true,
  };
}
