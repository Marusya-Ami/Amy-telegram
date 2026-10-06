import OpenAI from "openai";
import { ZodError } from "zod";
import { getEnv } from "@/lib/env";
import { AUXILIARY_OPENAI_MODEL } from "@/lib/openaiModels";
import { logger } from "@/lib/logger";
import { salesConfig } from "@/services/sales/config";
import { parseSalesSignal, type SalesSignal } from "@/services/sales/schema";
import { readSalesSignal, type SalesContext, type SignalReading } from "@/services/sales/signals";

let client: OpenAI | null = null;

function openai(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: getEnv().OPENAI_API_KEY });
  return client;
}

export function boundedSalesLines(lines: string[]): string[] {
  return lines
    .map((line) => line.trim().replace(/\s+/g, " ").slice(0, salesConfig.contextLineMaxChars))
    .filter(Boolean)
    .slice(-salesConfig.contextMessageLimit);
}

export async function extractSalesSignal(userLines: string[], amyLines: string[] = [], context: SalesContext = {}): Promise<SignalReading> {
  const deterministic = readSalesSignal(boundedSalesLines(userLines), context);
  if (deterministic.confidence >= 0.8) return deterministic;

  try {
    const llm = await requestSignal(boundedSalesLines(userLines), boundedSalesLines(amyLines));
    return mergeSignal(deterministic, llm);
  } catch (error) {
    logger.error("sales.extract_failed", {
      name: error instanceof Error ? error.name : "Error",
    });
    return deterministic;
  }
}

function mergeSignal(deterministic: SignalReading, llm: SalesSignal): SignalReading {
  const emotionalState = deterministic.emotionalState === "DISTRESSED" ? "DISTRESSED" : llm.emotionalState;
  const premiumInterest = deterministic.premiumInterest || llm.premiumInterest;
  const explicitMediaRequest = deterministic.explicitMediaRequest || llm.explicitMediaRequest;
  return {
    ...llm,
    emotionalState,
    premiumInterest,
    explicitMediaRequest,
    mediaInterest: deterministic.mediaInterest || llm.mediaInterest || explicitMediaRequest || premiumInterest,
    declinedNow: deterministic.declinedNow,
    evidence: llm.evidence.length > 0 ? llm.evidence : deterministic.evidence,
  };
}

async function requestSignal(userLines: string[], amyLines: string[]): Promise<SalesSignal> {
  const completion = await openai().chat.completions.create({
    model: AUXILIARY_OPENAI_MODEL,
    temperature: 0,
    max_tokens: 400,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Classify whether this chat turn contains media or purchase interest. Return JSON only.
Keys: mediaInterest, explicitMediaRequest, premiumInterest, intent, flirtLevel, desiredContexts, commercialReadiness, emotionalState, confidence, evidence.
intent is NONE, MEDIA_REQUEST, PREMIUM_MEDIA_REQUEST, FLIRT, REACTION_TO_MEDIA, PURCHASE_DISCUSSION, or TIP_DISCUSSION.
A voluntary tip, donation, or "how can I support you" is TIP_DISCUSSION. It is not a photo request and not PURCHASE_DISCUSSION.
Do not invent a payment URL.
commercialReadiness is LOW, MEDIUM, or HIGH.
emotionalState is NORMAL, SENSITIVE, or DISTRESSED.
flirtLevel is an integer 0-5. confidence is 0-1.
desiredContexts are lowercase snake_case scene words such as casual_selfie, at_home, relaxing, morning, evening, good_night, getting_ready, work, luna, cosplay, food, going_out, flirty. Use only contexts the turn supports. Do not invent one to force a match.
evidence is at most 5 short labels, each under 80 characters. Do not copy the conversation.
Ordinary compliments and normal flirting are not HIGH commercial readiness.
A photo request is not automatically a paid-offer request.
Private, exclusive, premium, hotter, or price talk can be HIGH.
Wanting more right after a flirty photo can be PREMIUM_MEDIA_REQUEST.
A compliment alone is not HIGH and is not a photo request.
Distress or an acute personal crisis is DISTRESSED.`,
      },
      { role: "user", content: JSON.stringify({ user: userLines, amy: amyLines }) },
    ],
  });
  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("Empty sales signal");
  try {
    return parseSalesSignal(content);
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) throw error;
    throw error;
  }
}
