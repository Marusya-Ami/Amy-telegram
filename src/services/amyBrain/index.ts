import type { Message, User } from "@prisma/client";
import OpenAI from "openai";
import { ZodError } from "zod";
import { amyProfilePrompt } from "@/prompts/amy-profile";
import { AMY_PERSONALITY_PROMPT } from "@/prompts/amy-personality";
import { getEnv } from "@/lib/env";
import { REPLY_LUNA_MODEL } from "@/lib/openaiModels";
import { logger } from "@/lib/logger";
import { withRetry } from "@/lib/retry";
import {
  asksAboutPhotos,
  CAPABILITY_RETRY_NOTE,
  TEXT_ONLY_RETRY_NOTE,
  replyBreaksPhotoCapability,
  replyInventsTextOnlyLimitation,
} from "@/services/amyBrain/capability";
import { FILLER_RETRY_NOTE, recentFillerNote, replyRepeatsTerminalFiller } from "@/services/amyBrain/voice";
import { parseAmyReply } from "@/services/amyBrain/schema";
import { interactionToneLine } from "@/services/interaction/dynamic";

const HISTORY_LIMIT = 20;
const FALLBACK_MESSAGES = ["wait i lost that", "say it again?"];

let client: OpenAI | null = null;

function openai(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: getEnv().OPENAI_API_KEY });
  return client;
}

type ReplyUser = Pick<User, "id" | "relationshipStage" | "conversationSummary" | "firstName"> &
  Partial<Pick<User, "interactionDynamic" | "interactionDynamicConfidence">>;

export type ReplyCompletion = (messages: OpenAI.Chat.ChatCompletionMessageParam[]) => Promise<string>;

export async function generateReply(
  input: {
    user: ReplyUser;
    history: Pick<Message, "direction" | "sender" | "text">[];
    currentMessages: string[];
    memories?: Array<{ key: string; value: string }>;
    visualContext?: string | null;
    commercialContext?: string | null;
  },
  complete: ReplyCompletion = completeWithModel,
): Promise<string[]> {
  const history = input.history.slice(-HISTORY_LIMIT);
  const currentMessages = input.currentMessages.map((message) => message.trim()).filter(Boolean);
  const messages = buildReplyMessages(
    input.user,
    history,
    currentMessages,
    input.memories ?? [],
    "",
    input.visualContext ?? "",
    input.commercialContext ?? "",
  );
  const started = Date.now();

  try {
    const reply = await withRetry("openai.chat", () => requestReply(messages, complete), {
      attempts: 3,
      isRetryable: (error) => {
        const status = errorStatus(error);
        if (status === 429 || (status != null && status >= 500)) return true;
        return error instanceof ZodError || error instanceof SyntaxError;
      },
    });
    const checked = await keepNaturalReply(currentMessages, reply, messages, complete, history);

    logger.info("openai.request", {
      userId: input.user.id,
      model: getEnv().OPENAI_MODEL,
      historyCount: history.length,
      durationMs: Date.now() - started,
    });

    return checked;
  } catch (error) {
    logger.error("openai.failure", {
      userId: input.user.id,
      model: getEnv().OPENAI_MODEL,
      status: errorStatus(error) ?? null,
      durationMs: Date.now() - started,
      message: error instanceof Error ? error.name : "OpenAIError",
    });
    return FALLBACK_MESSAGES;
  }
}

export async function createChatCompletion(
  body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
): Promise<{ content: string; latencyMs: number; promptTokens: number | null; completionTokens: number | null }> {
  const started = Date.now();
  const completion = await openai().chat.completions.create(body);
  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned an empty message");
  return {
    content,
    latencyMs: Date.now() - started,
    promptTokens: completion.usage?.prompt_tokens ?? null,
    completionTokens: completion.usage?.completion_tokens ?? null,
  };
}

export function replyCompletionBody(
  model: string,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
  if (model === REPLY_LUNA_MODEL) {
    return {
      model,
      messages,
      max_completion_tokens: 500,
      response_format: { type: "json_object" },
    };
  }
  return {
    model,
    messages,
    temperature: 0.8,
    max_tokens: 500,
    response_format: { type: "json_object" },
  };
}

export async function completeReplyModel(
  model: string,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): Promise<{ content: string; latencyMs: number; promptTokens: number | null; completionTokens: number | null }> {
  return createChatCompletion(replyCompletionBody(model, messages));
}

async function completeWithModel(messages: OpenAI.Chat.ChatCompletionMessageParam[]): Promise<string> {
  return (await completeReplyModel(getEnv().OPENAI_MODEL, messages)).content;
}

async function requestReply(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  complete: ReplyCompletion,
): Promise<string[]> {
  const content = await complete(messages);

  try {
    return parseAmyReply(content).messages;
  } catch (error) {
    logger.warn("openai.invalid_output", {
      name: error instanceof Error ? error.name : "ValidationError",
    });
    throw error;
  }
}

export async function generateProactive(input: {
  user: ReplyUser;
  history: Pick<Message, "direction" | "sender" | "text">[];
  memories: Array<{ key: string; value: string }>;
  followUpContext: string;
}): Promise<string[]> {
  const messages = buildReplyMessages(input.user, input.history, [], input.memories, input.followUpContext);
  return requestReply(messages, completeWithModel)
    .then((reply) => keepNaturalReply([], reply, messages, completeWithModel, input.history))
    .catch(() => ["heyy"]);
}

async function keepNaturalReply(
  currentMessages: string[],
  reply: string[],
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  complete: ReplyCompletion,
  history: Pick<Message, "direction" | "sender" | "text">[],
): Promise<string[]> {
  const afterCapability = await keepCapabilityReply(currentMessages, reply, messages, complete);
  return keepFillerReply(afterCapability, messages, complete, history);
}

async function keepCapabilityReply(
  currentMessages: string[],
  reply: string[],
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  complete: ReplyCompletion,
): Promise<string[]> {
  const photoAsk = asksAboutPhotos(currentMessages);
  const textOnly = replyInventsTextOnlyLimitation(reply);
  const photoBreak = photoAsk && replyBreaksPhotoCapability(reply);
  if (!textOnly && !photoBreak) return reply;
  logger.warn("reply.capability_denied", { bubbles: reply.length, textOnly, photoBreak });
  const note = textOnly ? TEXT_ONLY_RETRY_NOTE : CAPABILITY_RETRY_NOTE;
  try {
    const retried = await requestReply([...messages, { role: "system", content: note }], complete);
    if (!replyInventsTextOnlyLimitation(retried) && !(photoAsk && replyBreaksPhotoCapability(retried))) {
      return retried;
    }
  } catch (error) {
    logger.warn("reply.capability_retry_failed", {
      name: error instanceof Error ? error.name : "Error",
    });
  }
  logger.warn("reply.capability_denied", { kept: false });
  if (photoAsk) return currentMessages.some((text) => /[а-яё]/i.test(text)) ? ["ну есть"] : ["yeah i do"];
  return currentMessages.some((text) => /[а-яё]/i.test(text)) ? ["хм"] : ["hmm"];
}

async function keepFillerReply(
  reply: string[],
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  complete: ReplyCompletion,
  history: Pick<Message, "direction" | "sender" | "text">[],
): Promise<string[]> {
  if (!replyRepeatsTerminalFiller(reply, history)) return reply;
  logger.warn("reply.filler_repeated", { bubbles: reply.length });
  try {
    const retried = await requestReply([...messages, { role: "system", content: FILLER_RETRY_NOTE }], complete);
    if (!replyRepeatsTerminalFiller(retried, history)) return retried;
    return retried;
  } catch (error) {
    logger.warn("reply.filler_retry_failed", {
      name: error instanceof Error ? error.name : "Error",
    });
    return reply;
  }
}

export function buildReplyMessages(
  user: Omit<ReplyUser, "id">,
  history: Pick<Message, "direction" | "sender" | "text">[],
  currentMessages: string[],
  memories: Array<{ key: string; value: string }> = [],
  followUpContext = "",
  visualContext = "",
  commercialContext = "",
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const summary = user.conversationSummary?.trim();
  const system = [
    AMY_PERSONALITY_PROMPT,
    amyProfilePrompt(),
    `Internal relationship stage (never mention this label to them): ${user.relationshipStage}.`,
    interactionToneLine({
      interactionDynamic: user.interactionDynamic ?? "UNKNOWN",
      interactionDynamicConfidence: user.interactionDynamicConfidence ?? 0,
    }),
    user.firstName ? `The person's first name, if they have shared it with Telegram: ${user.firstName}.` : "",
    summary
      ? `Earlier conversation summary:\n${summary}\nBackground only. Do not keep a joke, game, challenge, or open thread alive just because the summary mentions it.`
      : "There is no earlier conversation summary yet.",
    memories.length > 0
      ? `Things you know about them. Use one only if it fits naturally. Never recite the list.\n${memories.map((memory) => `- ${memory.key}: ${memory.value}`).join("\n")}`
      : "",
    followUpContext
      ? `You are texting first. Reason, for you only: ${followUpContext}\nSound like Amy continuing the chat. Never say reminder, following up, before event, after event, or that you remembered a scheduled item. Do not guilt them for silence. Do not mention money.`
      : "",
    currentMessages.length > 1
      ? "The latest user messages are one burst. Respond once, to the whole burst."
      : "",
    visualContext,
    commercialContext,
    "Use emojis sparingly. Check your recent messages and avoid repeating the same emoji or emoji pattern. Many replies should have no emoji. Do not end several messages in a row with an emoji.",
    recentEmojiNote(history),
    "Do not default to ending messages with lol, haha, or lmao. Use that only when this turn is actually funny. Do not repeat the same closer across recent messages.",
    recentFillerNote(history),
    "Never say you can only text or invent a temporary technical reason a photo cannot be sent.",
    "Do not mechanically end replies with questions. Prefer natural variation (reactions, short comments, teases, or statements) without forcing a question.",
    "Never invent or confirm real-world meetings, physical encounters, shared travel, or offline events that did not actually happen. You can remain affectionate, romantic, and playful without treating invented offline history as factual.",
    "Do not promise or claim you will perform unsupported digital or real-world actions (combining/editing photos, posting externally, calling, meeting in person, contacting friends, sending physical items). You can playfully tease, imagine scenarios, or say how something WOULD look or feel hypothetically ('okay wait... us in one frame would actually be ridiculously cute 😭') without promising to execute it, narrating editing tasks, or asserting third-party reactions as facts. Never give robotic AI refusals.",
    "If he is offering a tip or asking where to send one, the whole reply is a short natural acceptance in the language of the chat. Do not refuse, do not mention requisites, and do not describe an app. If he is declining a tip, do not persuade him.",
    "If he asks for a photo or to see you, and he has not asked for private, sexy, nude, or paid content, the whole reply is a short natural response in the language of the chat, as if a normal photo is fine. Do not mention private, personal, or paid photos. If he asked about those, you may acknowledge them. Do not name a price or a link.",
    'Respond with JSON only, shaped as {"messages":["one short text"]}. One bubble is the usual choice. A second bubble only when it continues the same thought. Three is rare. Always 1 to 3 non-empty bubbles.',
  ]
    .filter(Boolean)
    .join("\n\n");

  const prior: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  for (const message of history) {
    const text = message.text?.trim();
    if (!text) continue;
    if (message.sender === "USER" && message.direction === "INBOUND") {
      prior.push({ role: "user", content: text });
    } else if (message.sender === "AMY" && message.direction === "OUTBOUND") {
      prior.push({ role: "assistant", content: text });
    }
  }

  return [
    { role: "system", content: system },
    ...prior.slice(-HISTORY_LIMIT),
    ...currentMessages.map((content) => ({ role: "user" as const, content })),
  ];
}

function recentEmojiNote(history: Pick<Message, "direction" | "sender" | "text">[]): string {
  const recent = history
    .filter((message) => message.sender === "AMY" && message.direction === "OUTBOUND")
    .slice(-6);
  const seen: string[] = [];
  for (const message of recent) {
    for (const emoji of message.text?.match(/\p{Extended_Pictographic}/gu) ?? []) {
      if (!seen.includes(emoji)) seen.push(emoji);
    }
  }
  if (seen.length === 0) return "";
  return `Emojis already used in your recent messages: ${seen.join(" ")}. Do not repeat them in this reply.`;
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}
