import type { InteractionDynamic, UserOfferInteractionSource } from "@prisma/client";
import { salesConfig } from "@/services/sales/config";
import { capOrdinaryFlirt, type SalesSignal } from "@/services/sales/schema";
import { hasSpecificMediaContext } from "@/services/media/context";

export type SalesDecisionName = "NO_OFFER" | "FREE_MEDIA" | "PAID_OFFER" | "SUPPRESS" | "TIP";

export type CommercialAction = "NONE" | "FREE_MEDIA" | "PAID_OFFER" | "TIP";

/** Launch label. Cooldowns stay SUPPRESS internally and still mean no send. */
export function commercialAction(decision: SalesDecisionName): CommercialAction {
  if (decision === "FREE_MEDIA" || decision === "PAID_OFFER" || decision === "TIP") return decision;
  return "NONE";
}

export const PAID_OFFER_REPLY_HINT =
  "You may naturally offer to share a private photo set, in your own words. You can say you want to show some pics, that this is one of your favorite sets, or that you took some photos you love. The backend chooses the set and may present it after your reply. Do not mention price, payment, links, how many photos there are, or what the photos show.";

export const TIP_REPLY_HINT =
  "Contextually and playfully, you may suggest spoiling you or leaving a tip in one natural sentence, in your own words (in the chat's language and tone, e.g. playful 'you know you can spoil me a little if you want 😏' or similar). Never beg, demand, guilt, or pressure. Do not make it a condition to continue talking. Do not mention payment links, buttons, providers, or amounts.";

export function commercialReplyContext(
  decision: SalesDecisionName,
  reasonCode: string | null | undefined,
  mode: "shadow" | "live",
): string | null {
  if (mode !== "live") return null;
  if (decision === "PAID_OFFER") return PAID_OFFER_REPLY_HINT;
  if (decision === "TIP" && reasonCode === "amy_initiated_tip") return TIP_REPLY_HINT;
  return null;
}

export function paidOfferReplyContext(decision: SalesDecisionName, mode: "shadow" | "live"): string | null {
  return commercialReplyContext(decision, null, mode);
}

export type MediaCandidate = {
  id: string;
  category: string;
  tags: string[];
  mood: string;
  flirtLevel: number;
  contexts: string[];
  active: boolean;
  /** Omitted means free-safe. Locked and deliverable assets set this false. */
  freeEligible?: boolean;
  hasLuna?: boolean;
};

export type OfferCandidate = {
  id: string;
  slug: string;
  tags: string[];
  contexts: string[];
  flirtLevel: number | null;
  active: boolean;
  /** Active Telegram Stars price. A Dropp USD price does not make an offer sellable here. */
  hasActivePrice: boolean;
  /** Lower numbers are offered first. */
  priority: number;
};

export type OfferInteractionFact = {
  offerId: string;
  type: "SHOWN" | "OPENED" | "PURCHASED" | "DECLINED";
  source?: UserOfferInteractionSource;
  createdAt: Date;
};

function cleanInteractions(interactions: OfferInteractionFact[]): OfferInteractionFact[] {
  return interactions.filter((item) => item.source !== "OWNER_TEST");
}

export type MediaDeliveryFact = {
  mediaAssetId: string;
  sentAt: Date;
};

export type SalesDecisionDraft = {
  decision: SalesDecisionName;
  signal: SalesSignal;
  candidateMediaAssetId: string | null;
  candidateOfferId: string | null;
  candidateSlug: string | null;
  reasonCode: string;
  reasonSummary: string;
};

export function decideSales(input: {
  signal: SalesSignal;
  declinedNow?: boolean;
  noMoney?: boolean;
  tipCandidate?: boolean;
  amyTipCooldown?: boolean;
  assets: MediaCandidate[];
  offers: OfferCandidate[];
  purchasedOfferIds: ReadonlySet<string>;
  interactions: OfferInteractionFact[];
  priorFreeMediaAt: Date | null;
  mediaDeliveries?: MediaDeliveryFact[];
  dynamic?: InteractionDynamic;
  dynamicConfidence?: number;
  now?: Date;
}): SalesDecisionDraft {
  const signal = capOrdinaryFlirt(input.signal);
  const paid = wantsPaid(signal);
  const free = wantsFree(signal);
  const noMoney = Boolean(
    input.noMoney ||
    signal.evidence.some((e) => e.toLowerCase().includes("no money")),
  );

  if (signal.emotionalState === "DISTRESSED") {
    return draft(signal, "NO_OFFER", "distress", "distress or crisis");
  }

  if (input.declinedNow) {
    return draft(signal, "SUPPRESS", "user_declined", "user declined a paid offer");
  }

  if (noMoney) {
    return draft(signal, "SUPPRESS", "no_money", "user stated no money");
  }

  if (wantsTip(signal)) {
    if (signal.confidence < salesConfig.paidOfferMinConfidence) {
      return draft(signal, "SUPPRESS", "low_confidence", "confidence below tip threshold");
    }
    return draft(signal, "TIP", "tip_request", "explicit tip or support request");
  }

  if (paid) {
    if (signal.confidence < salesConfig.paidOfferMinConfidence) {
      return draft(signal, "SUPPRESS", "low_confidence", "confidence below paid threshold");
    }
    const paidDecision = decidePaid(signal, {
      offers: input.offers ?? [],
      purchasedOfferIds: input.purchasedOfferIds ?? new Set(),
      interactions: input.interactions ?? [],
      now: input.now ?? new Date(),
    });
    if (paidDecision) return paidDecision;
  }

  if (free) {
    return decideFree(signal, {
      assets: input.assets ?? [],
      priorFreeMediaAt: input.priorFreeMediaAt ?? null,
      mediaDeliveries: input.mediaDeliveries,
      dynamic: input.dynamic ?? "UNKNOWN",
      dynamicConfidence: input.dynamicConfidence ?? 0,
      now: input.now ?? new Date(),
    });
  }

  if (isAmyTipCandidate(signal, input)) {
    if (input.amyTipCooldown) {
      return draft(signal, "SUPPRESS", "amy_tip_cooldown", "amy-initiated tip cooldown active");
    }
    return draft(signal, "TIP", "amy_initiated_tip", "natural amy-initiated tip opportunity");
  }

  return draft(signal, "NO_OFFER", "no_commercial_signal", "no media or purchase signal");
}

function isAmyTipCandidate(
  signal: SalesSignal,
  input: {
    declinedNow?: boolean;
    noMoney?: boolean;
    tipCandidate?: boolean;
  },
): boolean {
  if (signal.emotionalState !== "NORMAL") return false;
  if (input.declinedNow) return false;
  if (input.noMoney) return false;
  if (signal.mediaInterest || signal.explicitMediaRequest || signal.premiumInterest) return false;
  if (
    signal.intent === "TIP_DISCUSSION" ||
    signal.intent === "PURCHASE_DISCUSSION" ||
    signal.intent === "PREMIUM_MEDIA_REQUEST" ||
    signal.intent === "MEDIA_REQUEST"
  ) {
    return false;
  }
  return Boolean(
    input.tipCandidate ||
    signal.desiredContexts.includes("affectionate") ||
    signal.evidence.some((e) => e.includes("strong affection") || e.includes("strong compliment")),
  );
}

function decidePaid(
  signal: SalesSignal,
  input: {
    offers: OfferCandidate[];
    purchasedOfferIds: ReadonlySet<string>;
    interactions: OfferInteractionFact[];
    now: Date;
  },
): SalesDecisionDraft | null {
  const sellable = orderedSellableOffers(input.offers);
  if (sellable.length === 0) {
    return draft(signal, "NO_OFFER", "no_relevant_offer", "no active relevant offer");
  }

  const available = sellable.filter((offer) => !input.purchasedOfferIds.has(offer.id));
  if (available.length === 0) {
    return draft(signal, "NO_OFFER", "already_purchased", "offer already purchased");
  }

  const interactions = cleanInteractions(input.interactions);
  const open = available.filter((offer) => !offerBlocked(offer.id, interactions, input.now));
  if (open.length === 0) {
    const first = available[0];
    if (first && recentInteraction(interactions, first.id, "DECLINED", salesConfig.declineSuppressMs, input.now)) {
      return draft(signal, "SUPPRESS", "user_declined", "user declined a paid offer");
    }
    return draft(signal, "SUPPRESS", "recent_same_offer", "same offer shown recently");
  }
  if (anyRecentShown(interactions, salesConfig.paidOfferMinIntervalMs, input.now)) {
    return draft(signal, "SUPPRESS", "recent_paid_offer", "recent paid offer");
  }
  if (shownCount(interactions, salesConfig.paidOfferWindowMs, input.now) >= salesConfig.paidOfferMaxPer24h) {
    return draft(signal, "SUPPRESS", "paid_daily_cap", "paid offer daily cap");
  }

  const best = open[0];
  const reasonCode = signal.intent === "PURCHASE_DISCUSSION" ? "purchase_discussion" : "premium_request";
  const reasonSummary = signal.intent === "PURCHASE_DISCUSSION" ? "asked about price" : "explicit premium photo request";
  return draft(signal, "PAID_OFFER", reasonCode, reasonSummary, { candidateOfferId: best.id, candidateSlug: best.slug });
}

function decideFree(
  signal: SalesSignal,
  input: {
    assets: MediaCandidate[];
    priorFreeMediaAt: Date | null;
    mediaDeliveries?: MediaDeliveryFact[];
    dynamic: InteractionDynamic;
    dynamicConfidence: number;
    now: Date;
  },
): SalesDecisionDraft {
  if (
    input.priorFreeMediaAt &&
    input.now.getTime() - input.priorFreeMediaAt.getTime() < salesConfig.freeMediaMinIntervalMs
  ) {
    return draft(signal, "SUPPRESS", "free_media_cooldown", "free photo sent recently");
  }

  const asset = selectFreeMedia(signal, input.assets, input.dynamic, input.dynamicConfidence, input.mediaDeliveries ?? []);
  if (!asset) {
    return draft(signal, "NO_OFFER", "no_matching_media", "no matching free photo");
  }
  return draft(
    signal,
    "FREE_MEDIA",
    signal.explicitMediaRequest ? "explicit_media_request" : "contextual_media",
    signal.explicitMediaRequest ? "explicit photo request" : "contextual photo match",
    { candidateMediaAssetId: asset.id },
  );
}

const RELEVANCE_BAND = 1;

/**
 * Picks an active library photo. History is successful deliveries only.
 * Unseen assets rotate inside the same relevance band. A clearly better
 * contextual match stays ahead of an unseen weaker photo.
 */
export function selectFreeMedia(
  signal: SalesSignal,
  assets: MediaCandidate[],
  dynamic: InteractionDynamic = "UNKNOWN",
  dynamicConfidence = 0,
  history: MediaDeliveryFact[] = [],
): MediaCandidate | null {
  const sent = deliveryStats(history);
  const ranked = assets
    .filter((asset) => asset.active && asset.freeEligible !== false && !sent.has(asset.id))
    .map((asset) => ({ asset, ...scoreMedia(signal, asset, dynamic, dynamicConfidence) }))
    .filter((item) => item.score > 0);
  if (ranked.length === 0) return null;
  const bestTopical = Math.max(...ranked.map((item) => item.topical));
  const pool = ranked.filter((item) => item.topical >= bestTopical - RELEVANCE_BAND);
  pool.sort((a, b) => b.score - a.score || a.asset.id.localeCompare(b.asset.id));
  return pool[0]?.asset ?? null;
}

export function selectPaidOffer(_signal: SalesSignal, offers: OfferCandidate[], purchasedOfferIds: ReadonlySet<string>): OfferCandidate | null {
  return orderedSellableOffers(offers).find((offer) => !purchasedOfferIds.has(offer.id)) ?? null;
}

function orderedSellableOffers(offers: OfferCandidate[]): OfferCandidate[] {
  return offers
    .filter((offer) => offer.active && offer.hasActivePrice)
    .sort((a, b) => a.priority - b.priority || a.slug.localeCompare(b.slug));
}

function offerBlocked(offerId: string, interactions: OfferInteractionFact[], now: Date): boolean {
  return (
    recentInteraction(interactions, offerId, "DECLINED", salesConfig.declineSuppressMs, now) ||
    recentInteraction(interactions, offerId, "SHOWN", salesConfig.sameOfferReshowAfterMs, now)
  );
}

function scoreMedia(
  signal: SalesSignal,
  asset: MediaCandidate,
  dynamic: InteractionDynamic,
  dynamicConfidence: number,
): { topical: number; score: number } {
  const wantsLuna = signal.desiredContexts.some(
    (c) => c.toLowerCase() === "luna" || c.toLowerCase() === "pet" || c.toLowerCase() === "dog",
  );
  if (wantsLuna) {
    const isLuna =
      asset.hasLuna === true ||
      asset.category === "luna" ||
      asset.tags.some((t) => t.toLowerCase() === "luna") ||
      asset.contexts.some((c) => c.toLowerCase() === "luna");
    if (!isLuna) {
      return { topical: 0, score: 0 };
    }
  }

  const contexts = overlap(signal.desiredContexts, asset.contexts);
  const tags = overlap(signal.desiredContexts, asset.tags);
  const category = signal.desiredContexts.some((context) => context.includes(asset.category) || asset.category.includes(context.replace(/_.*/, ""))) ? 3 : 0;
  const mood = signal.desiredContexts.some((context) => asset.mood.toLowerCase().includes(context)) ? 1 : 0;
  const topical = contexts * 5 + tags * 2 + category + mood;
  if (topical === 0) {
    if (
      !wantsLuna &&
      !hasSpecificMediaContext(signal.desiredContexts) &&
      signal.explicitMediaRequest &&
      ["selfie", "casual", "cute", "flirty", "home"].includes(asset.category)
    ) {
      return { topical: 0, score: 1 };
    }
    return { topical: 0, score: 0 };
  }
  const flirt = Math.abs(asset.flirtLevel - signal.flirtLevel) <= 1 ? 2 : 0;
  return { topical, score: topical + flirt + dynamicBoost(asset, dynamic, dynamicConfidence) };
}

function deliveryStats(history: MediaDeliveryFact[]): Map<string, { count: number; lastSentAt: number }> {
  const stats = new Map<string, { count: number; lastSentAt: number }>();
  for (const item of history) {
    const current = stats.get(item.mediaAssetId) ?? { count: 0, lastSentAt: 0 };
    current.count += 1;
    current.lastSentAt = Math.max(current.lastSentAt, item.sentAt.getTime());
    stats.set(item.mediaAssetId, current);
  }
  return stats;
}

function dynamicBoost(asset: MediaCandidate, dynamic: InteractionDynamic, confidence: number): number {
  if (confidence < 0.7 || dynamic === "UNKNOWN" || dynamic === "EQUAL") return 0;
  const soft = asset.category === "cute" || asset.category === "casual" || asset.category === "home" || asset.contexts.includes("at_home");
  const confident = asset.category === "flirty" || asset.contexts.includes("flirty");
  if (dynamic === "DOMINANT_USER" && soft) return 1;
  if (dynamic === "DOMINANT_AMY" && confident) return 1;
  return 0;
}

function overlap(wanted: string[], available: string[]): number {
  const set = new Set(available.map((item) => item.toLowerCase()));
  return wanted.filter((item) => set.has(item.toLowerCase())).length;
}

function recentInteraction(
  interactions: OfferInteractionFact[],
  offerId: string,
  type: OfferInteractionFact["type"],
  windowMs: number,
  now: Date,
): boolean {
  return interactions.some((item) => item.offerId === offerId && item.type === type && now.getTime() - item.createdAt.getTime() < windowMs);
}

function anyRecentShown(interactions: OfferInteractionFact[], windowMs: number, now: Date): boolean {
  return interactions.some((item) => item.type === "SHOWN" && now.getTime() - item.createdAt.getTime() < windowMs);
}

function shownCount(interactions: OfferInteractionFact[], windowMs: number, now: Date): number {
  return interactions.filter((item) => item.type === "SHOWN" && now.getTime() - item.createdAt.getTime() < windowMs).length;
}

/** Rechecks one already-selected offer. SHOWN and DECLINED rows are the cooldown source. */
export function paidOfferGuard(input: {
  offerId: string;
  purchased: boolean;
  interactions: OfferInteractionFact[];
  confidence: number;
  emotionalState: string;
  declinedNow: boolean;
  now: Date;
  /** Owner test only. Skips SHOWN windows. Purchase, decline, and distress still block. */
  skipShownCooldown?: boolean;
}): string | null {
  const interactions = cleanInteractions(input.interactions);
  if (input.emotionalState === "DISTRESSED") return "distress";
  if (input.declinedNow) return "user_declined";
  if (input.confidence < salesConfig.paidOfferMinConfidence) return "low_confidence";
  if (input.purchased) return "already_purchased";
  if (recentInteraction(interactions, input.offerId, "DECLINED", salesConfig.declineSuppressMs, input.now)) {
    return "user_declined";
  }
  if (input.skipShownCooldown) return null;
  if (recentInteraction(interactions, input.offerId, "SHOWN", salesConfig.sameOfferReshowAfterMs, input.now)) {
    return "recent_same_offer";
  }
  if (anyRecentShown(interactions, salesConfig.paidOfferMinIntervalMs, input.now)) {
    return "recent_paid_offer";
  }
  if (shownCount(interactions, salesConfig.paidOfferWindowMs, input.now) >= salesConfig.paidOfferMaxPer24h) {
    return "paid_daily_cap";
  }
  return null;
}

function wantsTip(signal: SalesSignal): boolean {
  return signal.intent === "TIP_DISCUSSION";
}

function wantsPaid(signal: SalesSignal): boolean {
  return signal.premiumInterest || signal.intent === "PREMIUM_MEDIA_REQUEST" || signal.intent === "PURCHASE_DISCUSSION";
}

function wantsFree(signal: SalesSignal): boolean {
  return signal.explicitMediaRequest || signal.mediaInterest || signal.intent === "MEDIA_REQUEST" || signal.intent === "REACTION_TO_MEDIA";
}

function draft(
  signal: SalesSignal,
  decision: SalesDecisionName,
  reasonCode: string,
  reasonSummary: string,
  candidate?: { candidateMediaAssetId?: string; candidateOfferId?: string; candidateSlug?: string },
): SalesDecisionDraft {
  return {
    decision,
    signal,
    candidateMediaAssetId: candidate?.candidateMediaAssetId ?? null,
    candidateOfferId: candidate?.candidateOfferId ?? null,
    candidateSlug: candidate?.candidateSlug ?? null,
    reasonCode,
    reasonSummary,
  };
}
