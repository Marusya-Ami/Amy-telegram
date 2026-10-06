import type { MediaSentSource } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { getEnv } from "@/lib/env";
import { sendTextMessage } from "@/lib/telegram/client";
import type { TelegramUpdate } from "@/lib/telegram/types";

export type SuccessfulMediaDelivery = {
  userId: string;
  conversationId: string;
  mediaAssetId: string;
  source: MediaSentSource;
  telegramMessageId?: string | null;
  sentAt?: Date;
};

/**
 * Writes history only after the caller already has a successful Telegram send.
 * A throw from `send` leaves no MediaSent row.
 */
export async function deliverMediaThenRecord(
  input: SuccessfulMediaDelivery & {
    send: () => Promise<{ telegramMessageId?: string | null }>;
  },
): Promise<{ id: string; telegramMessageId: string | null }> {
  const sent = await input.send();
  const row = await recordSuccessfulMediaDelivery({
    userId: input.userId,
    conversationId: input.conversationId,
    mediaAssetId: input.mediaAssetId,
    source: input.source,
    telegramMessageId: sent.telegramMessageId ?? null,
    sentAt: input.sentAt,
  });
  return { id: row.id, telegramMessageId: row.telegramMessageId };
}

export async function recordSuccessfulMediaDelivery(input: SuccessfulMediaDelivery) {
  return prisma.mediaSent.create({
    data: {
      userId: input.userId,
      conversationId: input.conversationId,
      mediaAssetId: input.mediaAssetId,
      source: input.source,
      telegramMessageId: input.telegramMessageId ?? null,
      sentAt: input.sentAt,
    },
  });
}

export function classifyMediaSentCommand(
  update: TelegramUpdate,
  ownerTelegramId: string,
): { chatId: string; telegramUserId: string } | null {
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
  if (token !== "/media_sent" || parts.length !== 2 || !/^\d+$/.test(parts[1] ?? "")) return null;
  return { chatId: String(message.chat.id), telegramUserId: parts[1] ?? "" };
}

export async function processMediaSentCommand(
  update: TelegramUpdate,
  ownerTelegramId: string,
  send: (chatId: string, text: string) => Promise<void> = async (chatId, text) => {
    await sendTextMessage(chatId, text);
  },
): Promise<void> {
  const command = classifyMediaSentCommand(update, ownerTelegramId);
  if (!command) return;
  await send(command.chatId, await mediaSentText(command.telegramUserId));
}

export function formatMediaSentHistory(
  rows: Array<{ source: string; label: string; sentAt: Date }>,
  timeZone = "America/Cancun",
): string {
  if (rows.length === 0) return "No media delivery history.";
  return rows
    .map((row) => `${row.source}\n${row.label}\n${formatSentAt(row.sentAt, timeZone)}`)
    .join("\n\n");
}

export function mediaSentLabel(asset: { category: string; id: string }): string {
  return `${asset.category}_${asset.id.slice(-6)}`;
}

async function mediaSentText(telegramUserId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { telegramUserId },
    select: { id: true },
  });
  if (!user) return "No media delivery history.";
  const rows = await prisma.mediaSent.findMany({
    where: { userId: user.id },
    orderBy: { sentAt: "desc" },
    take: 8,
    select: {
      source: true,
      sentAt: true,
      mediaAsset: { select: { id: true, category: true } },
    },
  });
  let timeZone = "America/Cancun";
  try {
    timeZone = getEnv().APP_TIMEZONE;
  } catch {
    timeZone = "America/Cancun";
  }
  return formatMediaSentHistory(
    rows.map((row) => ({
      source: row.source,
      label: mediaSentLabel(row.mediaAsset),
      sentAt: row.sentAt,
    })),
    timeZone,
  );
}

function formatSentAt(date: Date, timeZone: string): string {
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
