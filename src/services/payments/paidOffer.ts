import { randomBytes, randomUUID } from "node:crypto";
import type { UserOfferInteractionSource } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { isUniqueConstraintError } from "@/lib/db/errors";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  sendPaidMediaMessage,
  sendTextMessage,
  safeTelegramDescription,
  TelegramRequestError,
  type StarsInvoiceLinkRequest,
} from "@/lib/telegram/client";
import type { TelegramUpdate } from "@/lib/telegram/types";
import { readFreePhoto } from "@/services/media/library";
import { loadDeliverables } from "@/services/payments/fulfillPaidContent";
import { hasPurchasedOffer } from "@/services/payments/offers";
import { salesConfig } from "@/services/sales/config";
import { decideSales, paidOfferGuard, type OfferCandidate, type OfferInteractionFact } from "@/services/sales/decide";
import { readSalesSignal } from "@/services/sales/signals";
import { type TipLanguage } from "@/services/sales/tip";

const STALE_CLAIM_MS = 2 * 60 * 1000;
const PREMIUM_PROBE = "do you have any private pics?";

const BUTTON_LABEL: Record<TipLanguage, (amount: number) => string> = {
  ru: (amount) => `⭐ Открыть за ${amount} Stars`,
  en: (amount) => `⭐ Unlock for ${amount} Stars`,
  es: (amount) => `⭐ Desbloquear por ${amount} Stars`,
};

export type PaidOfferOutcome =
  | "shadow"
  | "sent"
  | "duplicate"
  | "distress"
  | "user_declined"
  | "already_purchased"
  | "recent_same_offer"
  | "recent_paid_offer"
  | "paid_daily_cap"
  | "suppressed"
  | "no_offer"
  | "invalid_business_connection"
  | "invoice_failed"
  | "send_failed";

export type PaidOfferSend = (input: {
  chatId: string;
  businessConnectionId: string;
  starCount: number;
  payload: string;
  caption: string;
  media: Array<{ assetId: string; bytes: Buffer }>;
}) => Promise<{ telegramMessageId: string }>;

type Claim = {
  kind: "go";
  id: string;
  telegramMessageId: string | null;
  paymentIntentId: string | null;
  offerId: string | null;
};

export function paidOfferMode(raw = process.env["PAID_OFFER_MODE"]): "shadow" | "live" {
  return raw?.trim() === "live" ? "live" : "shadow";
}

export function paidOfferButtonLabel(language: TipLanguage, amount: number): string {
  return BUTTON_LABEL[language](amount);
}

/** Backend card. The invoice URL stays on the button and is never part of the text. */
export function paidOfferPresentation(input: {
  title: string;
  description: string | null;
  amount: number;
  language: TipLanguage;
}): { text: string; buttonText: string } {
  const lines = [`🔒 ${input.title.trim()}`];
  const description = input.description?.trim() ?? "";
  if (description) lines.push(description);
  return {
    text: lines.join("\n"),
    buttonText: paidOfferButtonLabel(input.language, input.amount),
  };
}

export async function executePaidOffer(input: {
  mode?: "shadow" | "live";
  userId: string;
  conversationId: string;
  triggerKey: string | null;
  offerId: string | null;
  confidence: number;
  emotionalState: string;
  declinedNow: boolean;
  userTexts?: string[];
  source?: UserOfferInteractionSource;
  now?: Date;
  /** Manual owner test. Ignored unless source is OWNER_TEST. Does not skip purchase checks. */
  bypassShownCooldown?: boolean;
  createInvoiceLink?: (request: StarsInvoiceLinkRequest) => Promise<string>;
  sendOffer?: PaidOfferSend;
}): Promise<PaidOfferOutcome> {
  const mode = input.mode ?? paidOfferMode();
  if (mode !== "live") {
    logOutcome(input, "shadow");
    return "shadow";
  }
  if (!input.triggerKey) {
    logOutcome(input, "suppressed");
    return "suppressed";
  }

  const now = input.now ?? new Date();
  const claim = await claimExecution({
    triggerKey: input.triggerKey,
    userId: input.userId,
    conversationId: input.conversationId,
    offerId: input.offerId,
    now,
  });
  if (claim.kind === "duplicate") {
    logOutcome(input, "duplicate");
    return "duplicate";
  }

  try {
    if (claim.telegramMessageId) {
      await completePresentation(
        claim,
        input.source ?? "SALES_ENGINE",
        input.bypassShownCooldown === true && input.source === "OWNER_TEST",
      );
      logOutcome(input, "sent");
      return "sent";
    }
    if (claim.paymentIntentId) {
      await cancelPendingIntent(claim.paymentIntentId);
    }
    const outcome = await presentOffer(input, claim, now);
    logOutcome(input, outcome);
    return outcome;
  } catch (error) {
    await prisma.paidOfferExecution.updateMany({
      where: { id: claim.id, status: "CLAIMED" },
      data: { status: "FAILED" },
    });
    logger.error("paid_offer.execution_failed", {
      userId: input.userId,
      conversationId: input.conversationId,
      name: error instanceof Error ? error.name : "Error",
    });
    logOutcome(input, "send_failed");
    return "send_failed";
  }
}

async function presentOffer(
  input: {
    userId: string;
    conversationId: string;
    offerId: string | null;
    confidence: number;
    emotionalState: string;
    declinedNow: boolean;
    userTexts?: string[];
    source?: UserOfferInteractionSource;
    bypassShownCooldown?: boolean;
    createInvoiceLink?: (request: StarsInvoiceLinkRequest) => Promise<string>;
    sendOffer?: PaidOfferSend;
  },
  claim: Claim,
  now: Date,
): Promise<PaidOfferOutcome> {
  const [user, conversation, interactions, purchased] = await Promise.all([
    prisma.user.findUnique({ where: { id: input.userId }, select: { aiEnabled: true } }),
    prisma.conversation.findUnique({
      where: { id: input.conversationId },
      select: { platform: true, platformConversationId: true, businessConnectionId: true, active: true },
    }),
    loadInteractions(input.userId, now),
    input.offerId ? hasPurchasedOffer(input.userId, input.offerId) : Promise.resolve(false),
  ]);

  if (!user?.aiEnabled || !conversation?.active) {
    await finishClaim(claim.id, "SKIPPED");
    return "suppressed";
  }
  const businessConnectionId = conversation.businessConnectionId?.trim() ?? "";
  if (conversation.platform !== "telegram-business" || !businessConnectionId) {
    await finishClaim(claim.id, "SKIPPED");
    return "invalid_business_connection";
  }
  if (!input.offerId) {
    await finishClaim(claim.id, "SKIPPED");
    return "no_offer";
  }

  const ownerForced = input.bypassShownCooldown === true && input.source === "OWNER_TEST";
  const guard = paidOfferGuard({
    offerId: input.offerId,
    purchased,
    interactions,
    confidence: input.confidence,
    emotionalState: input.emotionalState,
    declinedNow: input.declinedNow,
    now,
    skipShownCooldown: ownerForced,
  });
  if (guard) {
    await finishClaim(claim.id, "SKIPPED");
    return guardOutcome(guard);
  }

  const selected = await loadStarsOffer(input.offerId);
  if (!selected) {
    await finishClaim(claim.id, "SKIPPED");
    return "no_offer";
  }
  const album = await loadPaidAlbum(selected.offer.id);
  if (album.length === 0) {
    await finishClaim(claim.id, "SKIPPED");
    return "no_offer";
  }

  const payload = randomBytes(16).toString("hex");
  const intent = await prisma.paymentIntent.create({
    data: {
      provider: "TELEGRAM_STARS",
      userId: input.userId,
      conversationId: input.conversationId,
      offerId: selected.offer.id,
      status: "PENDING",
      amount: selected.price.amount,
      currency: selected.price.currency,
      providerInvoicePayload: payload,
    },
  });
  await prisma.paidOfferExecution.update({
    where: { id: claim.id },
    data: { paymentIntentId: intent.id, offerId: selected.offer.id },
  });

  let sent: { telegramMessageId: string };
  try {
    sent = await (input.sendOffer ?? defaultSendOffer)({
      chatId: conversation.platformConversationId,
      businessConnectionId,
      starCount: selected.price.amount,
      payload,
      caption: selected.offer.title.trim(),
      media: album,
    });
  } catch (error) {
    await prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: "CANCELLED" } });
    await finishClaim(claim.id, "FAILED");
    logger.error("paid_offer.send_failed", {
      userId: input.userId,
      offerId: selected.offer.id,
      name: error instanceof Error ? error.name : "Error",
      status: error instanceof TelegramRequestError ? error.status : undefined,
      description: error instanceof TelegramRequestError ? safeTelegramDescription(error.description) : undefined,
    });
    return "send_failed";
  }

  await prisma.paidOfferExecution.update({
    where: { id: claim.id },
    data: { telegramMessageId: sent.telegramMessageId },
  });
  await completePresentation(
    { ...claim, telegramMessageId: sent.telegramMessageId, offerId: selected.offer.id },
    input.source ?? "SALES_ENGINE",
    ownerForced,
  );
  return "sent";
}

async function completePresentation(claim: Claim, source: UserOfferInteractionSource, forced = false): Promise<void> {
  const execution = await prisma.paidOfferExecution.findUnique({ where: { id: claim.id } });
  const offerId = execution?.offerId ?? claim.offerId;
  const telegramMessageId = execution?.telegramMessageId ?? claim.telegramMessageId;
  if (!execution?.userId || !offerId || !telegramMessageId) return;
  await prisma.$transaction(async (tx) => {
    const finished = await tx.paidOfferExecution.updateMany({
      where: { id: claim.id, status: { in: ["CLAIMED", "FAILED"] } },
      data: { status: "SENT", telegramMessageId, offerId },
    });
    const existing = await tx.userOfferInteraction.findFirst({
      where: {
        userId: execution.userId,
        offerId,
        type: "SHOWN",
        metadata: { path: ["executionId"], equals: claim.id },
      },
      select: { id: true },
    });
    if (existing || finished.count !== 1) return;
    await tx.userOfferInteraction.create({
      data: {
        userId: execution.userId,
        offerId,
        conversationId: execution.conversationId,
        type: "SHOWN",
        source,
        metadata: forced ? { executionId: claim.id, forced: true } : { executionId: claim.id },
      },
    });
  });
}

async function loadStarsOffer(offerId: string): Promise<{
  offer: { id: string; slug: string; title: string; description: string | null };
  price: { amount: number; currency: string };
} | null> {
  const offer = await prisma.paymentOffer.findUnique({
    where: { id: offerId },
    select: {
      id: true,
      slug: true,
      title: true,
      description: true,
      active: true,
      prices: {
        where: { provider: "TELEGRAM_STARS", currency: "XTR", active: true },
        select: { amount: true, currency: true },
      },
    },
  });
  const price = offer?.prices[0];
  if (!offer?.active || !price || !Number.isInteger(price.amount) || price.amount < 1 || price.currency !== "XTR") {
    return null;
  }
  return { offer, price };
}

async function loadInteractions(userId: string, now: Date): Promise<OfferInteractionFact[]> {
  return prisma.userOfferInteraction.findMany({
    where: {
      userId,
      source: { not: "OWNER_TEST" },
      createdAt: { gte: new Date(now.getTime() - salesConfig.sameOfferReshowAfterMs) },
    },
    select: { offerId: true, type: true, source: true, createdAt: true },
  });
}

async function recentUserTexts(conversationId: string): Promise<string[]> {
  const rows = await prisma.message.findMany({
    where: { conversationId, sender: "USER", text: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 6,
    select: { text: true },
  });
  return rows.map((row) => row.text?.trim() ?? "").filter(Boolean).reverse();
}

async function cancelPendingIntent(intentId: string): Promise<void> {
  await prisma.paymentIntent.updateMany({
    where: { id: intentId, status: "PENDING" },
    data: { status: "CANCELLED" },
  });
}

async function claimExecution(input: {
  triggerKey: string;
  userId: string;
  conversationId: string;
  offerId: string | null;
  now: Date;
}): Promise<Claim | { kind: "duplicate" }> {
  try {
    const created = await prisma.paidOfferExecution.create({
      data: {
        triggerKey: input.triggerKey,
        userId: input.userId,
        conversationId: input.conversationId,
        offerId: input.offerId,
        status: "CLAIMED",
      },
    });
    return { kind: "go", id: created.id, telegramMessageId: null, paymentIntentId: null, offerId: created.offerId };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
  }

  const existing = await prisma.paidOfferExecution.findUnique({ where: { triggerKey: input.triggerKey } });
  if (!existing || existing.status === "SENT" || existing.status === "SKIPPED") return { kind: "duplicate" };
  if (existing.telegramMessageId) {
    return {
      kind: "go",
      id: existing.id,
      telegramMessageId: existing.telegramMessageId,
      paymentIntentId: existing.paymentIntentId,
      offerId: existing.offerId,
    };
  }
  const freshClaim = existing.status === "CLAIMED" && input.now.getTime() - existing.updatedAt.getTime() < STALE_CLAIM_MS;
  if (freshClaim) return { kind: "duplicate" };
  const taken = await prisma.paidOfferExecution.updateMany({
    where: { id: existing.id, status: existing.status, updatedAt: existing.updatedAt },
    data: { status: "CLAIMED", updatedAt: input.now },
  });
  if (taken.count !== 1) return { kind: "duplicate" };
  return {
    kind: "go",
    id: existing.id,
    telegramMessageId: existing.telegramMessageId,
    paymentIntentId: existing.paymentIntentId,
    offerId: existing.offerId,
  };
}

async function finishClaim(id: string, status: "FAILED" | "SKIPPED"): Promise<void> {
  await prisma.paidOfferExecution.update({ where: { id }, data: { status } });
}

function guardOutcome(guard: string): PaidOfferOutcome {
  if (
    guard === "distress" ||
    guard === "user_declined" ||
    guard === "already_purchased" ||
    guard === "recent_same_offer" ||
    guard === "recent_paid_offer" ||
    guard === "paid_daily_cap"
  ) {
    return guard;
  }
  return "suppressed";
}

function logOutcome(
  input: {
    userId: string;
    conversationId: string;
    triggerKey: string | null;
    offerId: string | null;
    bypassShownCooldown?: boolean;
    source?: UserOfferInteractionSource;
  },
  outcome: PaidOfferOutcome,
): void {
  const forced = input.bypassShownCooldown === true && input.source === "OWNER_TEST";
  logger.info("paid_offer.execution", {
    userId: input.userId,
    conversationId: input.conversationId,
    offerId: input.offerId,
    outcome,
    ...(forced ? { forced: true } : {}),
  });
}

async function loadPaidAlbum(offerId: string): Promise<Array<{ assetId: string; bytes: Buffer }>> {
  const rows = await loadDeliverables(offerId);
  const album: Array<{ assetId: string; bytes: Buffer }> = [];
  for (const row of rows) {
    const bytes = await readFreePhoto(row.storagePath).catch(() => null);
    if (!bytes?.length) continue;
    album.push({ assetId: row.mediaAssetId, bytes });
  }
  return album;
}

async function defaultSendOffer(input: {
  chatId: string;
  businessConnectionId: string;
  starCount: number;
  payload: string;
  caption: string;
  media: Array<{ assetId: string; bytes: Buffer }>;
}): Promise<{ telegramMessageId: string }> {
  const sent = await sendPaidMediaMessage({
    chatId: input.chatId,
    businessConnectionId: input.businessConnectionId,
    starCount: input.starCount,
    payload: input.payload,
    caption: input.caption,
    media: input.media.map((item) => item.bytes),
  });
  return { telegramMessageId: sent.messageId };
}

export function classifyPaidOfferTestCommand(
  update: TelegramUpdate,
  ownerTelegramId: string,
): { chatId: string; telegramUserId: string; slug: string | null; force: boolean } | null {
  const parsed = ownerCommand(update, ownerTelegramId, "/paid_offer_test");
  if (!parsed) return null;
  let parts = parsed.parts;
  const force = parts[parts.length - 1] === "--force";
  if (force) parts = parts.slice(0, -1);
  if (parts.length < 2 || parts.length > 3) return null;
  if (!/^\d+$/.test(parts[1] ?? "")) return null;
  const slug = parts[2] ?? null;
  if (slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
  return { chatId: parsed.chatId, telegramUserId: parts[1] ?? "", slug, force };
}

export function classifyOfferHistoryCommand(
  update: TelegramUpdate,
  ownerTelegramId: string,
): { chatId: string; telegramUserId: string } | null {
  const parsed = ownerCommand(update, ownerTelegramId, "/offer_history");
  if (!parsed || parsed.parts.length !== 2 || !/^\d+$/.test(parsed.parts[1] ?? "")) return null;
  return { chatId: parsed.chatId, telegramUserId: parsed.parts[1] ?? "" };
}

export async function processPaidOfferTestCommand(
  update: TelegramUpdate,
  ownerTelegramId: string,
  deps: {
    sendOwner?: (chatId: string, text: string) => Promise<void>;
    createInvoiceLink?: (request: StarsInvoiceLinkRequest) => Promise<string>;
    sendOffer?: PaidOfferSend;
    now?: Date;
  } = {},
): Promise<void> {
  const command = classifyPaidOfferTestCommand(update, ownerTelegramId);
  if (!command) return;
  const sendOwner = deps.sendOwner ?? (async (chatId: string, text: string) => {
    await sendTextMessage(chatId, text);
  });
    await sendOwner(
    command.chatId,
    await ownerPaidOfferTest(command.telegramUserId, command.slug, deps, command.force),
  );
}

export async function processOfferHistoryCommand(
  update: TelegramUpdate,
  ownerTelegramId: string,
  deps: { sendOwner?: (chatId: string, text: string) => Promise<void> } = {},
): Promise<void> {
  const command = classifyOfferHistoryCommand(update, ownerTelegramId);
  if (!command) return;
  const sendOwner = deps.sendOwner ?? (async (chatId: string, text: string) => {
    await sendTextMessage(chatId, text);
  });
  await sendOwner(command.chatId, await offerHistoryText(command.telegramUserId));
}

async function ownerPaidOfferTest(
  telegramUserId: string,
  slug: string | null,
  deps: {
    createInvoiceLink?: (request: StarsInvoiceLinkRequest) => Promise<string>;
    sendOffer?: PaidOfferSend;
    now?: Date;
  },
  force = false,
): Promise<string> {
  const target = await businessTarget(telegramUserId);
  if (!target) return "No Amy Business conversation is available.";
  const now = deps.now ?? new Date();
  const recent = await recentUserTexts(target.conversationId);
  const reading = readSalesSignal(recent);
  const catalog = await ownerCatalog(target.userId, now);
  let offerId: string | null = null;
  let confidence = 0.93;
  if (slug) {
    const offer = catalog.offers.find((item) => item.slug === slug && item.active && item.hasActivePrice);
    if (!offer) return "No active paid offer is available.";
    offerId = offer.id;
  } else {
    const decision = decideSales({
      signal: readSalesSignal([PREMIUM_PROBE]),
      declinedNow: false,
      assets: [],
      offers: catalog.offers,
      purchasedOfferIds: new Set(catalog.purchasedOfferIds),
      interactions: catalog.interactions,
      priorFreeMediaAt: null,
      dynamic: "EQUAL",
      dynamicConfidence: 0,
      now,
    });
    if (decision.decision !== "PAID_OFFER" || !decision.candidateOfferId) {
      return `Not sent.\n${decision.reasonCode}`;
    }
    offerId = decision.candidateOfferId;
    confidence = decision.signal.confidence;
  }

  const outcome = await executePaidOffer({
    mode: "live",
    userId: target.userId,
    conversationId: target.conversationId,
    triggerKey: `owner-test:${randomUUID()}`,
    offerId,
    confidence,
    emotionalState: reading.emotionalState,
    declinedNow: reading.declinedNow,
    userTexts: recent.length > 0 ? recent : [PREMIUM_PROBE],
    source: "OWNER_TEST",
    bypassShownCooldown: force,
    now,
    createInvoiceLink: deps.createInvoiceLink,
    sendOffer: deps.sendOffer,
  });
  if (outcome !== "sent" || !offerId) return `Not sent.\n${outcome}`;
  const selected = await loadStarsOffer(offerId);
  const sent = selected
    ? `Sent.\n${selected.offer.slug}\n${selected.offer.title}\n${selected.price.amount} ${selected.price.currency}`
    : "Sent.";
  return force ? `${sent}\nforced` : sent;
}

async function offerHistoryText(telegramUserId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { telegramUserId }, select: { id: true } });
  if (!user) return "No paid offer history.";
  const [shown, purchased] = await Promise.all([
    prisma.userOfferInteraction.findMany({
      where: { userId: user.id, type: "SHOWN" },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        createdAt: true,
        offer: {
          select: {
            slug: true,
            prices: {
              where: { provider: "TELEGRAM_STARS", currency: "XTR" },
              select: { amount: true, currency: true, active: true },
              orderBy: { updatedAt: "desc" },
            },
          },
        },
      },
    }),
    prisma.payment.findMany({
      where: { userId: user.id, status: "PAID" },
      orderBy: { paidAt: "desc" },
      take: 8,
      select: { amount: true, currency: true, paidAt: true, offer: { select: { slug: true } } },
    }),
  ]);
  if (shown.length === 0 && purchased.length === 0) return "No paid offer history.";
  let timeZone = "America/Cancun";
  try {
    timeZone = getEnv().APP_TIMEZONE;
  } catch {
    timeZone = "America/Cancun";
  }
  const lines: string[] = [];
  for (const row of shown) {
    const price = row.offer.prices.find((item) => item.active) ?? row.offer.prices[0];
    lines.push(["SHOWN", row.offer.slug, price ? `${price.amount} ${price.currency}` : row.offer.slug, formatWhen(row.createdAt, timeZone)].join("\n"));
  }
  for (const row of purchased) {
    lines.push(["PAID", row.offer.slug, `${row.amount} ${row.currency}`, formatWhen(row.paidAt, timeZone)].join("\n"));
  }
  return lines.join("\n\n");
}

async function businessTarget(telegramUserId: string): Promise<{ userId: string; conversationId: string } | null> {
  const user = await prisma.user.findUnique({ where: { telegramUserId }, select: { id: true } });
  if (!user) return null;
  const conversation = await prisma.conversation.findFirst({
    where: {
      userId: user.id,
      platform: "telegram-business",
      active: true,
      businessConnectionId: { not: null },
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (!conversation) return null;
  return { userId: user.id, conversationId: conversation.id };
}

async function ownerCatalog(userId: string, now: Date): Promise<{
  offers: OfferCandidate[];
  purchasedOfferIds: string[];
  interactions: OfferInteractionFact[];
}> {
  const [offers, purchases, interactions] = await Promise.all([
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
    prisma.payment.findMany({
      where: { userId, status: "PAID" },
      select: { offerId: true },
    }),
    loadInteractions(userId, now),
  ]);
  return {
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
    purchasedOfferIds: [...new Set(purchases.map((row) => row.offerId))],
    interactions,
  };
}

function ownerCommand(
  update: TelegramUpdate,
  ownerTelegramId: string,
  token: string,
): { chatId: string; parts: string[] } | null {
  const owner = ownerTelegramId.trim();
  if (!owner) return null;
  const message = update.message;
  if (!message?.from || message.from.is_bot) return null;
  if (message.chat?.type !== "private") return null;
  if (message.business_connection_id) return null;
  if (String(message.from.id) !== owner) return null;
  const text = typeof message.text === "string" ? message.text.trim() : "";
  const parts = text.split(/\s+/);
  if (parts[0]?.split("@")[0]?.toLowerCase() !== token) return null;
  return { chatId: String(message.chat.id), parts };
}

function formatWhen(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const zone = timeZone === "America/Cancun" ? "Cancun" : timeZone;
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")} ${zone}`;
}
