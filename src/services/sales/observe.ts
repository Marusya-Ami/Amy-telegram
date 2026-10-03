import type { InteractionDynamic } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import type { StarsInvoiceLinkRequest } from "@/lib/telegram/client";
import { purchaseAwareness } from "@/services/payments/offers";
import { salesConfig } from "@/services/sales/config";
import { decideSales, commercialReplyContext, type MediaCandidate, type OfferCandidate, type OfferInteractionFact } from "@/services/sales/decide";
import { extractSalesSignal } from "@/services/sales/extract";
import { salesEngineMode } from "@/services/sales/mode";
import { readSalesSignal, type SalesContext, type SignalReading } from "@/services/sales/signals";
import { executeFreeMedia, freeMediaMode, type FreePhotoSend } from "@/services/media/executeFreeMedia";
import { freeSelectableAssetWhere } from "@/services/media/eligibility";
import { executePaidOffer, paidOfferMode, type PaidOfferSend } from "@/services/payments/paidOffer";
import { donationUrl, maybeSendTipLink, tipLinkOnCooldown, tipMode, type TipDelivery } from "@/services/sales/tip";
import { contextualTipReading, TIP_CONTEXT_WINDOW_MS, type TipContextMessage } from "@/services/sales/tipContext";

export type SalesTurnInput = {
  userId: string;
  conversationId: string;
  triggerMessageId: string | null;
  userTexts: string[];
  amyTexts: string[];
  replyMessageId?: string | null;
};

type Catalog = {
  assets: MediaCandidate[];
  offers: OfferCandidate[];
  purchasedOfferIds: string[];
  interactions: OfferInteractionFact[];
  priorFreeMediaAt: Date | null;
  mediaDeliveries: { mediaAssetId: string; sentAt: Date }[];
  dynamic: InteractionDynamic;
  dynamicConfidence: number;
};

export async function observeSalesTurn(
  input: SalesTurnInput,
  options?: {
    mode?: "off" | "shadow";
    extract?: (userLines: string[], amyLines: string[], context?: SalesContext) => Promise<SignalReading>;
    loadCatalog?: (userId: string) => Promise<Catalog>;
    now?: Date;
    tipMode?: "shadow" | "live";
    donationUrl?: string | null;
    sendTip?: (delivery: TipDelivery) => Promise<void>;
    freeMediaMode?: "shadow" | "live";
    sendFreePhoto?: FreePhotoSend;
    paidOfferMode?: "shadow" | "live";
    createPaidInvoice?: (request: StarsInvoiceLinkRequest) => Promise<string>;
    sendPaidOffer?: PaidOfferSend;
    tipHistory?: TipContextMessage[];
    linkSentAt?: Date | null;
  },
): Promise<void> {
  const mode = options?.mode ?? salesEngineMode();
  if (mode !== "shadow") return;

  try {
    const now = options?.now ?? new Date();
    const history = options?.tipHistory ?? await loadTipHistory(input.conversationId, now, input.userTexts, input.amyTexts);
    const linkSentAt = options?.linkSentAt === undefined ? await latestTipLinkAt(input.userId) : options.linkSentAt;
    const contextual = contextualTipReading({
      now,
      currentUserLines: input.userTexts,
      history,
      linkSentAt,
    });
    const catalog = await (options?.loadCatalog ?? loadCatalog)(input.userId);
    const context = salesTurnContext(catalog, history, now);
    const reading = contextual ?? await (options?.extract ?? extractSalesSignal)(input.userTexts, input.amyTexts, context);
    const amyTipOnCooldown = await tipLinkOnCooldown(input.userId, now, "amy_initiated_tip");
    let decision = decideSales({
      signal: reading,
      declinedNow: reading.declinedNow,
      noMoney: reading.noMoney,
      tipCandidate: reading.tipCandidate,
      amyTipCooldown: amyTipOnCooldown,
      assets: catalog.assets,
      offers: catalog.offers,
      purchasedOfferIds: new Set(catalog.purchasedOfferIds),
      interactions: catalog.interactions,
      priorFreeMediaAt: catalog.priorFreeMediaAt,
      mediaDeliveries: catalog.mediaDeliveries,
      dynamic: catalog.dynamic,
      dynamicConfidence: catalog.dynamicConfidence,
      now,
    });
    const activeTipMode = options?.tipMode ?? tipMode();
    const activeDonationUrl = options?.donationUrl === undefined ? donationUrl() : options.donationUrl;
    if (decision.decision === "TIP" && activeTipMode === "live" && !activeDonationUrl) {
      decision = { ...decision, reasonCode: "tip_unconfigured", reasonSummary: "donation url is not configured" };
    } else if (decision.decision === "TIP" && activeTipMode === "live") {
      const isCooldown = await tipLinkOnCooldown(
        input.userId,
        now,
        decision.reasonCode === "amy_initiated_tip" ? "amy_initiated_tip" : "tip_request",
      );
      if (isCooldown) {
        decision = {
          ...decision,
          reasonCode: decision.reasonCode === "amy_initiated_tip" ? "amy_tip_cooldown" : "tip_cooldown",
          reasonSummary: "donation link sent recently",
        };
      }
    }

    await prisma.salesDecision.create({
      data: {
        userId: input.userId,
        conversationId: input.conversationId,
        triggerMessageId: input.triggerMessageId,
        mode: "SHADOW",
        decision: decision.decision,
        confidence: decision.signal.confidence,
        intent: decision.signal.intent,
        flirtLevel: decision.signal.flirtLevel,
        commercialReadiness: decision.signal.commercialReadiness,
        emotionalState: decision.signal.emotionalState,
        desiredContexts: decision.signal.desiredContexts,
        candidateMediaAssetId: decision.candidateMediaAssetId,
        candidateOfferId: decision.candidateOfferId,
        reasonCode: decision.reasonCode,
        reasonSummary: decision.reasonSummary.slice(0, 200),
      },
    });
    logger.info("sales.shadow_recorded", {
      userId: input.userId,
      decision: decision.decision,
      intent: decision.signal.intent,
      reasonCode: decision.reasonCode,
    });
    if (decision.decision === "TIP" && (decision.reasonCode === "tip_request" || decision.reasonCode === "amy_initiated_tip")) {
      await maybeSendTipLink({
        userId: input.userId,
        conversationId: input.conversationId,
        triggerMessageId: input.triggerMessageId,
        decision: decision.decision,
        reasonCode: decision.reasonCode,
        mode: activeTipMode,
        url: activeDonationUrl,
        now,
        userTexts: input.userTexts,
        amyTexts: input.amyTexts,
        replyMessageId: input.replyMessageId,
        send: options?.sendTip,
      });
    }
    if (decision.decision === "FREE_MEDIA") {
      await executeFreeMedia({
        mode: options?.freeMediaMode ?? freeMediaMode(),
        userId: input.userId,
        conversationId: input.conversationId,
        triggerMessageId: input.triggerMessageId,
        mediaAssetId: decision.candidateMediaAssetId,
        explicitMediaRequest: reading.explicitMediaRequest,
        emotionalState: reading.emotionalState,
        declinedNow: reading.declinedNow,
        now,
        sendPhoto: options?.sendFreePhoto,
      });
    }
    if (decision.decision === "PAID_OFFER") {
      await executePaidOffer({
        mode: options?.paidOfferMode ?? paidOfferMode(),
        userId: input.userId,
        conversationId: input.conversationId,
        triggerKey: input.triggerMessageId,
        offerId: decision.candidateOfferId,
        confidence: decision.signal.confidence,
        emotionalState: reading.emotionalState,
        declinedNow: reading.declinedNow,
        userTexts: input.userTexts,
        source: "SALES_ENGINE",
        now,
        createInvoiceLink: options?.createPaidInvoice,
        sendOffer: options?.sendPaidOffer,
      });
    }
  } catch (error) {
    logger.error("sales.observe_failed", {
      userId: input.userId,
      name: error instanceof Error ? error.name : "Error",
    });
  }
}

const PHOTO_BRIDGE_MS = 2 * 60 * 60 * 1000;

export async function replyCommercialHint(input: {
  userId: string;
  conversationId: string;
  userTexts: string[];
  now?: Date;
  mode?: "shadow" | "live";
}): Promise<string | null> {
  const liveOffer = (input.mode ?? paidOfferMode()) === "live";
  const liveTip = (input.mode ?? tipMode()) === "live";
  if (!liveOffer && !liveTip) return null;
  try {
    const now = input.now ?? new Date();
    const catalog = await loadCatalog(input.userId);
    const history = await loadTipHistory(input.conversationId, now, input.userTexts, []);
    const reading = readSalesSignal(input.userTexts, salesTurnContext(catalog, history, now));
    const amyTipCooldown = await tipLinkOnCooldown(input.userId, now, "amy_initiated_tip");
    const decision = decideSales({
      signal: reading,
      declinedNow: reading.declinedNow,
      noMoney: reading.noMoney,
      tipCandidate: reading.tipCandidate,
      amyTipCooldown,
      assets: catalog.assets,
      offers: catalog.offers,
      purchasedOfferIds: new Set(catalog.purchasedOfferIds),
      interactions: catalog.interactions,
      priorFreeMediaAt: catalog.priorFreeMediaAt,
      mediaDeliveries: catalog.mediaDeliveries,
      dynamic: catalog.dynamic,
      dynamicConfidence: catalog.dynamicConfidence,
      now,
    });
    if (decision.decision === "PAID_OFFER" && liveOffer) {
      return commercialReplyContext(decision.decision, decision.reasonCode, "live");
    }
    if (decision.decision === "TIP" && decision.reasonCode === "amy_initiated_tip" && liveTip) {
      return commercialReplyContext(decision.decision, decision.reasonCode, "live");
    }
    return null;
  } catch (error) {
    logger.error("sales.hint_failed", {
      userId: input.userId,
      name: error instanceof Error ? error.name : "Error",
    });
    return null;
  }
}

function salesTurnContext(
  catalog: Catalog,
  history: TipContextMessage[],
  now: Date,
): SalesContext {
  return {
    recentFreePhoto: catalog.mediaDeliveries.some((item) => now.getTime() - item.sentAt.getTime() < PHOTO_BRIDGE_MS),
    recentTexts: history.map((item) => item.text?.trim() ?? "").filter(Boolean).slice(-6),
  };
}

async function latestTipLinkAt(userId: string): Promise<Date | null> {
  const link = await prisma.tipLink.findFirst({
    where: { userId, status: "LINK_SENT" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return link?.createdAt ?? null;
}

async function loadTipHistory(
  conversationId: string,
  now: Date,
  currentUserLines: string[],
  currentAmyLines: string[],
): Promise<TipContextMessage[]> {
  const rows = await prisma.message.findMany({
    where: { conversationId, createdAt: { gte: new Date(now.getTime() - TIP_CONTEXT_WINDOW_MS) } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true, sender: true, text: true },
  });
  const history: TipContextMessage[] = rows
    .filter((row) => row.sender === "USER" || row.sender === "AMY")
    .map((row) => ({ createdAt: row.createdAt, sender: row.sender as "USER" | "AMY", text: row.text }));
  return stripCurrentTurn(history, currentUserLines, currentAmyLines);
}

function stripCurrentTurn(history: TipContextMessage[], userLines: string[], amyLines: string[]): TipContextMessage[] {
  const copy = [...history];
  for (const line of [...amyLines].reverse()) {
    const last = copy.at(-1);
    if (last?.sender === "AMY" && last.text?.trim() === line.trim()) copy.pop();
  }
  for (const line of [...userLines].reverse()) {
    const last = copy.at(-1);
    if (last?.sender === "USER" && last.text?.trim() === line.trim()) copy.pop();
  }
  return copy;
}

async function loadCatalog(userId: string): Promise<Catalog> {
  const [user, assets, offers, purchases, interactions, deliveries] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { interactionDynamic: true, interactionDynamicConfidence: true },
    }),
    prisma.mediaAsset.findMany({
      where: freeSelectableAssetWhere(),
      select: { id: true, category: true, tags: true, mood: true, flirtLevel: true, contexts: true, active: true, hasLuna: true },
    }),
    prisma.paymentOffer.findMany({
      where: { active: true },
      select: {
        id: true,
        slug: true,
        tags: true,
        contexts: true,
        flirtLevel: true,
        priority: true,
        active: true,
        prices: { where: { provider: "TELEGRAM_STARS", currency: "XTR", active: true }, select: { id: true } },
      },
    }),
    purchaseAwareness(userId),
    prisma.userOfferInteraction.findMany({
      where: {
        userId,
        source: { not: "OWNER_TEST" },
        createdAt: { gte: new Date(Date.now() - salesConfig.sameOfferReshowAfterMs) },
      },
      select: { offerId: true, type: true, source: true, createdAt: true },
    }),
    prisma.mediaSent.findMany({
      where: { userId },
      orderBy: { sentAt: "desc" },
      select: { mediaAssetId: true, sentAt: true },
    }),
  ]);

  return {
    assets,
    offers: offers.map((offer) => ({
      id: offer.id,
      slug: offer.slug,
      tags: offer.tags,
      contexts: offer.contexts,
      flirtLevel: offer.flirtLevel,
      priority: offer.priority,
      active: offer.active,
      hasActivePrice: offer.prices.length > 0,
    })),
    purchasedOfferIds: purchases.purchasedOfferIds,
    interactions,
    priorFreeMediaAt: deliveries[0]?.sentAt ?? null,
    mediaDeliveries: deliveries,
    dynamic: user?.interactionDynamic ?? "UNKNOWN",
    dynamicConfidence: user?.interactionDynamicConfidence ?? 0,
  };
}
