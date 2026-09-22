import type { Message, User } from "@prisma/client";
import OpenAI from "openai";
import { ZodError } from "zod";
import { amyProfilePrompt } from "@/prompts/amy-profile";
import { AMY_PERSONALITY_PROMPT } from "@/prompts/amy-personality";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { withRetry } from "@/lib/retry";
import { parseAmyReply } from "@/services/amyBrain/schema";

const HISTORY_LIMIT = 20;
const FALLBACK_MESSAGES = ["wait i lost that lol", "say it again?"];

let client: OpenAI | null = null;

function openai(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: getEnv().OPENAI_API_KEY });
  return client;
}

export async function generateReply(input: {
  user: Pick<User, "id" | "relationshipStage" | "conversationSummary" | "firstName">;
  history: Pick<Message, "direction" | "sender" | "text">[];
  currentMessages: string[];
}): Promise<string[]> {
  const history = input.history.slice(-HISTORY_LIMIT);
  const currentMessages = input.currentMessages.map((message) => message.trim()).filter(Boolean);
  const messages = buildMessages(input.user, history, currentMessages);
  const started = Date.now();

  try {
    const reply = await withRetry("openai.chat", () => requestReply(messages), {
      attempts: 3,
      isRetryable: (error) => {
        const status = errorStatus(error);
        if (status === 429 || (status != null && status >= 500)) return true;
        return error instanceof ZodError || error instanceof SyntaxError;
      },
    });

    logger.info("openai.request", {
      userId: input.user.id,
      model: getEnv().OPENAI_MODEL,
      historyCount: history.length,
      durationMs: Date.now() - started,
    });

    return reply;
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

async function requestReply(messages: OpenAI.Chat.ChatCompletionMessageParam[]): Promise<string[]> {
  const completion = await openai().chat.completions.create({
    model: getEnv().OPENAI_MODEL,
    temperature: 0.8,
    max_tokens: 500,
    response_format: { type: "json_object" },
    messages,
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned an empty message");

  try {
    return parseAmyReply(content).messages;
  } catch (error) {
    logger.warn("openai.invalid_output", {
      name: error instanceof Error ? error.name : "ValidationError",
    });
    throw error;
  }
}

function buildMessages(
  user: Pick<User, "relationshipStage" | "conversationSummary" | "firstName">,
  history: Pick<Message, "direction" | "sender" | "text">[],
  currentMessages: string[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const summary = user.conversationSummary?.trim();
  const system = [
    AMY_PERSONALITY_PROMPT,
    amyProfilePrompt(),
    `Internal relationship stage (never mention this label to them): ${user.relationshipStage}.`,
    user.firstName ? `The person's first name, if they have shared it with Telegram: ${user.firstName}.` : "",
    summary ? `Earlier conversation summary:\n${summary}` : "There is no earlier conversation summary yet.",
    currentMessages.length > 1
      ? "The latest user messages are one burst. Respond once, to the whole burst."
      : "",
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

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}
