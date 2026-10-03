import { prisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import { editMessageReplyMarkup, sendTextMessage } from "@/lib/telegram/client";
import type { TelegramUpdate } from "@/lib/telegram/types";
import { salesConfig } from "@/services/sales/config";
import type { SalesDecisionName } from "@/services/sales/decide";

const INVENTED_URL = /https?:\/\/[^\s<>"']+/gi;
const SPANISH = /[¿¡ñáéíóúü]|\b(?:propina|apoyarte|apoyar|donaci[oó]n|enviarte|mandarte|hola|gracias|puedo|quiero|dejar)\b/i;
const WEAK_TURN = /^(?:[\s\p{Emoji_Presentation}\p{Extended_Pictographic}!.?]+|ok|okay|k|lol|lmao|hey|hi|hello|yes|no|yeah|yep|nah|sup|thx|thanks)[.!?]*$/iu;

export type TipLanguage = "ru" | "en" | "es";

export type TipDelivery = {
  chatId: string;
  businessConnectionId: string;
  text: string;
  buttonText: string;
  buttonUrl: string;
  /** When set, the button is added to this already delivered message. No new text is sent. */
  attachToMessageId?: string | null;
};

const BUTTON_LABEL: Record<TipLanguage, string> = {
  ru: "Оставить чаевые 🤍",
  en: "Leave a tip 🤍",
  es: "Dejar una propina 🤍",
};

const CARRIER_TEXT: Record<TipLanguage, string> = {
  ru: "вот",
  en: "here",
  es: "aquí",
};

export function tipMode(raw = process.env["TIP_MODE"]): "shadow" | "live" {
  return raw?.trim().toLowerCase() === "live" ? "live" : "shadow";
}

export function donationUrl(raw = process.env["DROPP_DONATION_URL"]): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || !parsed.hostname) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function stripInventedLinks(bubbles: string[]): string[] {
  return bubbles
    .map((bubble) => bubble.replace(INVENTED_URL, "").replace(/[ \t]{2,}/g, " ").trim())
    .filter(Boolean);
}

export function conversationLanguage(text: string): TipLanguage | null {
  const trimmed = text.trim();
  if (!trimmed || WEAK_TURN.test(trimmed)) return null;
  if (/[а-яё]/i.test(trimmed)) return "ru";
  if (SPANISH.test(trimmed)) return "es";
  if (/\b[a-z]{3,}\b/i.test(trimmed)) return "en";
  return null;
}

/** Latest clear conversation turn wins. Telegram's UI language code is not used. */
export function tipLanguage(input: { texts?: string[] }): TipLanguage {
  const texts = input.texts ?? [];
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    const language = conversationLanguage(texts[index] ?? "");
    if (language) return language;
  }
  return "en";
}

export function tipButtonLabel(language: TipLanguage): string {
  return BUTTON_LABEL[language];
}

export function tipCarrierText(language: TipLanguage, preceding: string[] = []): string {
  const carrier = CARRIER_TEXT[language];
  const last = preceding.map((line) => line.trim()).filter(Boolean).at(-1)?.toLowerCase();
  if (last === carrier.toLowerCase()) return "🤍";
  return carrier;
}

export function tipPresentation(input: { url: string; language: TipLanguage; preceding?: string[] }): {
  text: string;
  buttonText: string;
  buttonUrl: string;
} {
  return {
    text: tipCarrierText(input.language, input.preceding),
    buttonText: tipButtonLabel(input.language),
    buttonUrl: input.url,
  };
}

export async function tipDeliveryAvailable(userId: string, now = new Date()): Promise<boolean> {
  if (tipMode() !== "live" || !donationUrl()) return false;
  return !(await tipLinkOnCooldown(userId, now));
}

export async function tipLinkOnCooldown(
  userId: string,
  now = new Date(),
  forReason: "tip_request" | "amy_initiated_tip" = "tip_request",
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - salesConfig.tipLinkCooldownMs);
  const recentLinks = await prisma.tipLink.findMany({
    where: {
      userId,
      status: "LINK_SENT",
      createdAt: { gt: cutoff },
    },
    select: { id: true, triggerMessageId: true },
  });
  if (recentLinks.length === 0) return false;

  if (forReason === "amy_initiated_tip") {
    return true;
  }

  const amyDecisions = await prisma.salesDecision.findMany({
    where: {
      userId,
      decision: "TIP",
      reasonCode: "amy_initiated_tip",
      createdAt: { gt: cutoff },
    },
    select: { triggerMessageId: true },
  });
  const amyTriggerIds = new Set(
    amyDecisions.map((d) => d.triggerMessageId).filter((id): id is string => Boolean(id)),
  );

  return recentLinks.some(
    (link) => !link.triggerMessageId || !amyTriggerIds.has(link.triggerMessageId),
  );
}

export async function maybeSendTipLink(input: {
  userId: string;
  conversationId: string;
  triggerMessageId: string | null;
  decision: SalesDecisionName;
  reasonCode?: string | null;
  mode?: "shadow" | "live";
  url?: string | null;
  now?: Date;
  userTexts?: string[];
  amyTexts?: string[];
  replyMessageId?: string | null;
  send?: (delivery: TipDelivery) => Promise<void>;
}): Promise<"skipped" | "unconfigured" | "cooldown" | "sent" | "no_conversation"> {
  if (input.decision !== "TIP") return "skipped";
  if ((input.mode ?? tipMode()) !== "live") return "skipped";
  const url = input.url === undefined ? donationUrl() : input.url;
  if (!url) return "unconfigured";
  const now = input.now ?? new Date();

  if (input.triggerMessageId) {
    const existing = await prisma.tipLink.findFirst({
      where: {
        userId: input.userId,
        triggerMessageId: input.triggerMessageId,
        status: "LINK_SENT",
      },
      select: { id: true },
    });
    if (existing) return "skipped";
  }

  const cooldownReason = input.reasonCode === "amy_initiated_tip" ? "amy_initiated_tip" : "tip_request";
  if (await tipLinkOnCooldown(input.userId, now, cooldownReason)) return "cooldown";

  const conversation = await prisma.conversation.findUnique({
    where: { id: input.conversationId },
    select: { platformConversationId: true, businessConnectionId: true },
  });
  if (!conversation?.businessConnectionId) return "no_conversation";

  const explicit = (input.userTexts ?? []).map((text) => text.trim()).filter(Boolean);
  let texts = explicit;
  if (!explicit.some((text) => conversationLanguage(text))) {
    const recent = await prisma.message.findMany({
      where: {
        conversationId: input.conversationId,
        direction: "INBOUND",
        sender: "USER",
        text: { not: null },
      },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: { text: true },
    });
    const history = recent.map((message) => message.text?.trim() ?? "").filter(Boolean).reverse();
    texts = [...history, ...explicit];
  }
  const presentation = tipPresentation({
    url,
    language: tipLanguage({ texts }),
    preceding: input.amyTexts,
  });
  const attachToMessageId = input.replyMessageId?.trim() || null;
  const delivery: TipDelivery = {
    chatId: conversation.platformConversationId,
    businessConnectionId: conversation.businessConnectionId,
    text: attachToMessageId ? "" : presentation.text,
    buttonText: presentation.buttonText,
    buttonUrl: presentation.buttonUrl,
    attachToMessageId,
  };
  const send = input.send ?? sendTipDelivery;
  await send(delivery);
  await prisma.tipLink.create({
    data: {
      userId: input.userId,
      conversationId: input.conversationId,
      triggerMessageId: input.triggerMessageId,
      status: "LINK_SENT",
    },
  });
  logger.info("tip.link_sent", { userId: input.userId, status: "LINK_SENT" });
  return "sent";
}

export async function sendTipDelivery(delivery: TipDelivery): Promise<void> {
  const replyMarkup = { inline_keyboard: [[{ text: delivery.buttonText, url: delivery.buttonUrl }]] };
  if (delivery.attachToMessageId) {
    await editMessageReplyMarkup(delivery.chatId, delivery.attachToMessageId, {
      businessConnectionId: delivery.businessConnectionId,
      replyMarkup,
    });
    return;
  }
  await sendTextMessage(delivery.chatId, delivery.text, {
    businessConnectionId: delivery.businessConnectionId,
    disableLinkPreview: true,
    replyMarkup,
  });
}

export async function clearTipCooldown(userId: string): Promise<number> {
  const removed = await prisma.tipLink.deleteMany({ where: { userId, status: "LINK_SENT" } });
  logger.info("tip.cooldown_reset", { userId, removed: removed.count });
  return removed.count;
}

export function classifyTipAdminCommand(
  update: TelegramUpdate,
  ownerTelegramId: string,
): { chatId: string; telegramUserId: string; action: "test" | "reset" } | null {
  const owner = ownerTelegramId.trim();
  if (!owner) return null;
  const message = update.message;
  if (!message?.from || message.from.is_bot) return null;
  if (message.chat?.type !== "private") return null;
  if (message.business_connection_id) return null;
  if (String(message.from.id) !== owner) return null;
  const text = typeof message.text === "string" ? message.text.trim() : "";
  const parts = text.split(/\s+/);
  const token = parts[0]?.split("@")[0]?.toLowerCase();
  if ((token !== "/tip_test" && token !== "/tip_reset") || parts.length !== 2 || !/^\d+$/.test(parts[1] ?? "")) return null;
  return {
    chatId: String(message.chat.id),
    telegramUserId: parts[1] ?? "",
    action: token === "/tip_reset" ? "reset" : "test",
  };
}

export async function processTipAdminCommand(
  update: TelegramUpdate,
  ownerTelegramId: string,
  deps: {
    sendOwner?: (chatId: string, text: string) => Promise<void>;
    sendTip?: (delivery: TipDelivery) => Promise<void>;
    url?: string | null;
  } = {},
): Promise<void> {
  const command = classifyTipAdminCommand(update, ownerTelegramId);
  if (!command) return;
  const sendOwner = deps.sendOwner ?? (async (chatId: string, text: string) => {
    await sendTextMessage(chatId, text);
  });
  if (command.action === "reset") {
    const user = await prisma.user.findUnique({ where: { telegramUserId: command.telegramUserId } });
    if (!user) {
      await sendOwner(command.chatId, "No Amy Business conversation is available.");
      return;
    }
    const removed = await clearTipCooldown(user.id);
    await sendOwner(command.chatId, removed > 0 ? "Tip cooldown cleared." : "No tip cooldown to clear.");
    return;
  }
  const url = deps.url === undefined ? donationUrl() : deps.url;
  if (!url) {
    await sendOwner(command.chatId, "Donation URL is not configured.");
    return;
  }

  const user = await prisma.user.findUnique({ where: { telegramUserId: command.telegramUserId } });
  const conversation = user
    ? await prisma.conversation.findFirst({
        where: {
          userId: user.id,
          platform: "telegram-business",
          active: true,
          businessConnectionId: { not: null },
        },
        orderBy: { updatedAt: "desc" },
      })
    : null;
  if (!user || !conversation?.businessConnectionId) {
    await sendOwner(command.chatId, "No Amy Business conversation is available.");
    return;
  }

  const result = await maybeSendTipLink({
    userId: user.id,
    conversationId: conversation.id,
    triggerMessageId: null,
    decision: "TIP",
    mode: "live",
    url,
    send: deps.sendTip,
  });
  const ownerText: Record<typeof result, string> = {
    sent: "Sent the donation link.",
    cooldown: "A donation link was sent recently.",
    unconfigured: "Donation URL is not configured.",
    no_conversation: "No Amy Business conversation is available.",
    skipped: "Donation link was not sent.",
  };
  await sendOwner(command.chatId, ownerText[result]);
}
