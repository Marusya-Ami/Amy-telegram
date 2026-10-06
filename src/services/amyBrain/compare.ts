import type { InteractionDynamic, Message, Prisma, RelationshipStage } from "@prisma/client";
import type OpenAI from "openai";
import { prisma } from "@/lib/db/prisma";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { sendTextMessage } from "@/lib/telegram/client";
import type { TelegramUpdate } from "@/lib/telegram/types";
import { asksAboutPhotos, replyBreaksPhotoCapability } from "@/services/amyBrain/capability";
import { buildReplyMessages, createChatCompletion, replyCompletionBody } from "@/services/amyBrain";
import { parseAmyReply } from "@/services/amyBrain/schema";
import { rankMemories } from "@/services/memory/store";

export const COMPARISON_CANDIDATE_MODEL = "gpt-5.6-luna";

const HISTORY_LIMIT = 20;

export type CompareCommand =
  | { chatId: string; kind: "reply"; text: string }
  | { chatId: string; kind: "last" }
  | { chatId: string; kind: "probe" };

export type OpenAIErrorDetails = {
  status: number | null;
  type: string | null;
  code: string | null;
  param: string | null;
  message: string;
  requestId: string | null;
};

type ReplyUser = {
  id: string;
  relationshipStage: RelationshipStage;
  conversationSummary: string | null;
  firstName: string | null;
  interactionDynamic?: InteractionDynamic;
  interactionDynamicConfidence?: number;
};

export type CompareContext = {
  user: ReplyUser;
  history: Pick<Message, "direction" | "sender" | "text">[];
  currentMessages: string[];
  memories: Array<{ key: string; value: string }>;
};

export type ModelSample = {
  label: "A" | "B";
  model: string;
  messages: string[];
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  guard: "clear" | "flagged" | "would replace" | "unparsed";
  error: OpenAIErrorDetails | null;
};

type CompletionResult = {
  content: string;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
};

export function classifyCompareCommand(update: TelegramUpdate, ownerTelegramId: string): CompareCommand | null {
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
  if (token === "/compare_probe" && parts.length === 1) return { chatId: String(message.chat.id), kind: "probe" };
  if (token === "/compare_last" && parts.length === 1) return { chatId: String(message.chat.id), kind: "last" };
  if (token === "/compare_reply") {
    const sample = parts.slice(1).join(" ").trim();
    if (!sample) return { chatId: String(message.chat.id), kind: "reply", text: "" };
    return { chatId: String(message.chat.id), kind: "reply", text: sample };
  }
  return null;
}

export async function processCompareAdminCommand(
  update: TelegramUpdate,
  ownerTelegramId: string,
  deps: {
    loadContext?: (ownerTelegramId: string, command: CompareCommand) => Promise<CompareContext | null>;
    complete?: (model: string, messages: OpenAI.Chat.ChatCompletionMessageParam[]) => Promise<CompletionResult>;
    send?: (chatId: string, text: string) => Promise<void>;
    productionModel?: string;
    completeRaw?: typeof createChatCompletion;
  } = {},
): Promise<void> {
  const command = classifyCompareCommand(update, ownerTelegramId);
  if (!command) return;
  const send = deps.send ?? (async (chatId: string, text: string) => {
    await sendTextMessage(chatId, text);
  });
  if (command.kind === "probe") {
    const report = await probeLuna(deps.completeRaw ?? createChatCompletion);
    await send(command.chatId, report);
    return;
  }
  if (command.kind === "reply" && !command.text) {
    await send(command.chatId, "Usage: /compare_reply <text>");
    return;
  }
  try {
    const context = await (deps.loadContext ?? loadCompareContext)(ownerTelegramId, command);
    if (!context) {
      await send(command.chatId, "No Amy Business conversation is available.");
      return;
    }
    const productionModel = deps.productionModel ?? getEnv().OPENAI_MODEL;
    const samples = await compareReplies(context, {
      models: [
        { label: "A", model: productionModel },
        { label: "B", model: COMPARISON_CANDIDATE_MODEL },
      ],
      complete: deps.complete ?? ((model, messages) => createChatCompletion(comparisonCompletionBody(model, messages))),
    });
    for (const sample of samples) {
      logger.info("reply.compare", {
        label: sample.label,
        model: sample.model,
        latencyMs: sample.latencyMs,
        prompt: sample.promptTokens,
        completion: sample.completionTokens,
        guard: sample.guard,
        failed: Boolean(sample.error),
      });
    }
    for (const part of formatComparison(context.currentMessages.join("\n"), samples)) {
      await send(command.chatId, part);
    }
  } catch (error) {
    logger.error("reply.compare_failed", { name: error instanceof Error ? error.name : "Error" });
    await send(command.chatId, "Couldn't compare replies.");
  }
}

export async function compareReplies(
  context: CompareContext,
  options: {
    models: Array<{ label: "A" | "B"; model: string }>;
    complete: (model: string, messages: OpenAI.Chat.ChatCompletionMessageParam[]) => Promise<CompletionResult>;
  },
): Promise<ModelSample[]> {
  const messages = buildReplyMessages(
    context.user,
    context.history,
    context.currentMessages,
    context.memories,
  );
  return Promise.all(options.models.map((entry) => sampleModel(entry, messages, context.currentMessages, options.complete)));
}

export function comparisonCompletionBody(
  model: string,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
  return replyCompletionBody(model, messages);
}

export function describeOpenAIError(error: unknown): OpenAIErrorDetails {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const nested = record.error && typeof record.error === "object" ? (record.error as Record<string, unknown>) : {};
  const requestId = firstString(record.request_id, record.requestID);
  return {
    status: typeof record.status === "number" ? record.status : null,
    type: firstString(nested.type, record.type),
    code: firstString(nested.code, record.code),
    param: firstString(nested.param, record.param),
    message: clip(firstString(nested.message, record.message) ?? "Error", 500),
    requestId,
  };
}

export function formatComparison(userText: string, samples: ModelSample[]): string[] {
  const header = [`Compare`, `User: ${clip(userText, 240)}`, ``];
  const blocks = samples.map((sample) => formatSample(sample));
  const text = [...header, blocks.join("\n\n")].join("\n");
  if (text.length <= 3900) return [text];
  return blocks.map((block, index) => `${index === 0 ? header.join("\n") : "Compare continued"}\n${block}`);
}

async function sampleModel(
  entry: { label: "A" | "B"; model: string },
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  currentMessages: string[],
  complete: (model: string, messages: OpenAI.Chat.ChatCompletionMessageParam[]) => Promise<CompletionResult>,
): Promise<ModelSample> {
  const started = Date.now();
  try {
    const result = await complete(entry.model, messages);
    const parsed = parseAmyReply(result.content).messages;
    const flagged = replyBreaksPhotoCapability(parsed);
    return {
      ...entry,
      messages: parsed,
      latencyMs: result.latencyMs,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      guard: !flagged ? "clear" : asksAboutPhotos(currentMessages) ? "would replace" : "flagged",
      error: null,
    };
  } catch (error) {
    const details = describeOpenAIError(error);
    logger.warn("reply.compare_model_failed", {
      label: entry.label,
      model: entry.model,
      status: details.status,
      type: details.type,
      code: details.code,
      param: details.param,
      requestId: details.requestId,
    });
    return {
      ...entry,
      messages: [],
      latencyMs: Date.now() - started,
      promptTokens: null,
      completionTokens: null,
      guard: "unparsed",
      error: details,
    };
  }
}

function formatSample(sample: ModelSample): string {
  if (sample.error) {
    return [
      `${sample.label} ${sample.model}`,
      "FAILED",
      `status: ${sample.error.status ?? "-"}`,
      `type: ${sample.error.type ?? "-"}`,
      `code: ${sample.error.code ?? "-"}`,
      `param: ${sample.error.param ?? "-"}`,
      `message: ${sample.error.message}`,
      sample.error.requestId ? `request: ${sample.error.requestId}` : "",
    ].filter(Boolean).join("\n");
  }
  const usage = `${sample.latencyMs}ms · ${sample.promptTokens ?? "-"}/${sample.completionTokens ?? "-"} tokens`;
  return [`${sample.label} ${sample.model}`, usage, `guard: ${sample.guard}`, clip(sample.messages.join("\n"), 1400)].join("\n");
}

async function probeLuna(complete: typeof createChatCompletion): Promise<string> {
  const ping = [{ role: "user" as const, content: "Reply with the word pong." }];
  const layers = [
    { name: "plain", body: { model: COMPARISON_CANDIDATE_MODEL, messages: ping } },
    {
      name: "json",
      body: {
        model: COMPARISON_CANDIDATE_MODEL,
        messages: [{ role: "user" as const, content: 'Return JSON {"ok":true}' }],
        max_completion_tokens: 32,
        response_format: { type: "json_object" as const },
      },
    },
  ];
  const lines = ["Luna probe", COMPARISON_CANDIDATE_MODEL];
  for (const layer of layers) {
    try {
      const result = await complete(layer.body);
      lines.push(`${layer.name}: ok ${result.latencyMs}ms chars ${result.content.length}`);
    } catch (error) {
      const details = describeOpenAIError(error);
      logger.warn("reply.compare_probe_failed", {
        layer: layer.name,
        status: details.status,
        type: details.type,
        code: details.code,
        param: details.param,
        requestId: details.requestId,
      });
      lines.push(`${layer.name}: FAILED`);
      lines.push(`status: ${details.status ?? "-"}`);
      lines.push(`type: ${details.type ?? "-"}`);
      lines.push(`code: ${details.code ?? "-"}`);
      lines.push(`param: ${details.param ?? "-"}`);
      lines.push(`message: ${details.message}`);
    }
  }
  return lines.join("\n");
}

async function loadCompareContext(ownerTelegramId: string, command: CompareCommand): Promise<CompareContext | null> {
  const conversation = await prisma.conversation.findFirst({
    where: {
      platform: "telegram-business",
      businessConnectionId: { not: null },
      active: true,
      user: { telegramUserId: { not: ownerTelegramId } },
    },
    orderBy: { updatedAt: "desc" },
    include: {
      user: {
        select: {
          id: true,
          relationshipStage: true,
          conversationSummary: true,
          firstName: true,
          interactionDynamic: true,
          interactionDynamicConfidence: true,
        },
      },
    },
  });
  if (!conversation) return null;

  if (command.kind === "reply") {
    const history = await recentHistory(conversation.id, null);
    const memories = await readMemories(conversation.userId, [command.text]);
    return { user: conversation.user, history, currentMessages: [command.text], memories };
  }

  const inbound = await prisma.message.findFirst({
    where: {
      conversationId: conversation.id,
      direction: "INBOUND",
      sender: "USER",
      type: "TEXT",
      text: { not: "" },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!inbound?.text?.trim()) return null;

  const reply = await prisma.message.findFirst({
    where: {
      conversationId: conversation.id,
      direction: "OUTBOUND",
      sender: "AMY",
      createdAt: { gte: inbound.createdAt },
    },
    orderBy: { createdAt: "asc" },
  });
  const respondingToIds = jsonIds(reply?.metadata);
  const currentRows = respondingToIds.includes(inbound.id)
    ? await prisma.message.findMany({ where: { id: { in: respondingToIds } }, orderBy: { createdAt: "asc" } })
    : [inbound];
  const currentMessages = currentRows.map((message) => message.text?.trim() ?? "").filter(Boolean);
  if (currentMessages.length === 0) return null;
  const history = await recentHistory(conversation.id, currentRows[0]?.createdAt ?? inbound.createdAt);
  const memories = await readMemories(conversation.userId, currentMessages);
  return { user: conversation.user, history, currentMessages, memories };
}

async function recentHistory(conversationId: string, before: Date | null): Promise<Pick<Message, "direction" | "sender" | "text">[]> {
  const rows = await prisma.message.findMany({
    where: {
      conversationId,
      ...(before ? { createdAt: { lt: before } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
    select: { direction: true, sender: true, text: true },
  });
  return rows.reverse();
}

async function readMemories(userId: string, texts: string[]): Promise<Array<{ key: string; value: string }>> {
  const active = await prisma.userMemory.findMany({
    where: { userId, active: true },
    orderBy: [{ importance: "desc" }, { lastConfirmedAt: "desc" }],
    take: 40,
  });
  return rankMemories(active, texts).map((memory) => ({ key: memory.key, value: memory.value }));
}

function jsonIds(value: Prisma.JsonValue | null | undefined): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const ids = (value as { respondingToIds?: unknown }).respondingToIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === "string");
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function clip(value: string, max: number): string {
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
