import { prisma } from "@/lib/db/prisma";
import { getEnv } from "@/lib/env";
import { sendTextMessage } from "@/lib/telegram/client";
import type { TelegramUpdate } from "@/lib/telegram/types";

type InspectDecision = {
  createdAt: Date;
  decision: string;
  intent: string;
  commercialReadiness: string;
  confidence: number;
  desiredContexts: unknown;
  reasonSummary: string | null;
  candidateOfferSlug: string | null;
  candidateMediaId: string | null;
  candidateMediaCategory: string | null;
};

export function classifySalesAdminCommand(
  update: TelegramUpdate,
  ownerTelegramId: string,
): { chatId: string; recent: boolean } | null {
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
  if (parts.length !== 1) return null;
  if (token === "/sales_last") return { chatId: String(message.chat.id), recent: false };
  if (token === "/sales_recent") return { chatId: String(message.chat.id), recent: true };
  return null;
}

export async function processSalesAdminCommand(
  update: TelegramUpdate,
  ownerTelegramId: string,
  send: (chatId: string, text: string) => Promise<void> = async (chatId, text) => {
    await sendTextMessage(chatId, text);
  },
): Promise<void> {
  const command = classifySalesAdminCommand(update, ownerTelegramId);
  if (!command) return;
  const text = command.recent ? await salesRecentText() : await salesLastText();
  await send(command.chatId, text);
}

export function formatSalesDecision(row: InspectDecision): string {
  const contexts = contextList(row.desiredContexts);
  const candidate = row.candidateOfferSlug ?? mediaLabel(row);
  const lines = [
    `Decision: ${row.decision}`,
    `Intent: ${row.intent}`,
    `Readiness: ${row.commercialReadiness}`,
    `Confidence: ${row.confidence.toFixed(2)}`,
  ];
  if (contexts.length > 0) lines.push(`Contexts: ${contexts.join(", ")}`);
  if (candidate) lines.push(`Candidate: ${candidate}`);
  if (row.reasonSummary) lines.push(`Reason: ${row.reasonSummary}`);
  return lines.join("\n");
}

export function formatSalesRecent(rows: InspectDecision[], timeZone = "America/Cancun"): string {
  if (rows.length === 0) return "No sales decisions yet.";
  return rows
    .slice(0, 10)
    .map((row) => {
      const candidate = row.candidateOfferSlug ?? mediaLabel(row) ?? "-";
      const reason = row.reasonSummary ?? "-";
      return `${formatWhen(row.createdAt, timeZone)}  ${row.decision}  ${row.intent}  ${row.confidence.toFixed(2)}  ${candidate}  ${reason}`;
    })
    .join("\n");
}

async function salesLastText(): Promise<string> {
  const row = await prisma.salesDecision.findFirst({
    orderBy: { createdAt: "desc" },
    include: {
      candidateOffer: { select: { slug: true } },
      candidateMedia: { select: { id: true, category: true } },
    },
  });
  if (!row) return "No sales decisions yet.";
  return formatSalesDecision(toInspect(row));
}

async function salesRecentText(): Promise<string> {
  const rows = await prisma.salesDecision.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
    include: {
      candidateOffer: { select: { slug: true } },
      candidateMedia: { select: { id: true, category: true } },
    },
  });
  let timeZone = "America/Cancun";
  try {
    timeZone = getEnv().APP_TIMEZONE;
  } catch {
    timeZone = "America/Cancun";
  }
  return formatSalesRecent(rows.map(toInspect), timeZone);
}

function toInspect(row: {
  createdAt: Date;
  decision: string;
  intent: string;
  commercialReadiness: string;
  confidence: number;
  desiredContexts: unknown;
  reasonSummary: string | null;
  candidateOffer: { slug: string } | null;
  candidateMedia: { id: string; category: string } | null;
}): InspectDecision {
  return {
    createdAt: row.createdAt,
    decision: row.decision,
    intent: row.intent,
    commercialReadiness: row.commercialReadiness,
    confidence: row.confidence,
    desiredContexts: row.desiredContexts,
    reasonSummary: row.reasonSummary,
    candidateOfferSlug: row.candidateOffer?.slug ?? null,
    candidateMediaId: row.candidateMedia?.id ?? null,
    candidateMediaCategory: row.candidateMedia?.category ?? null,
  };
}

function mediaLabel(row: Pick<InspectDecision, "candidateMediaId" | "candidateMediaCategory">): string | null {
  if (!row.candidateMediaId) return null;
  return row.candidateMediaCategory ? `${row.candidateMediaCategory} ${row.candidateMediaId}` : row.candidateMediaId;
}

function contextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function formatWhen(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}
