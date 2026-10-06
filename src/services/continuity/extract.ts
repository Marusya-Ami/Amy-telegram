import OpenAI from "openai";
import { ZodError } from "zod";
import { getEnv } from "@/lib/env";
import { AUXILIARY_OPENAI_MODEL } from "@/lib/openaiModels";
import { logger } from "@/lib/logger";
import { withRetry } from "@/lib/retry";
import { prepareExtraction, type UpcomingHint } from "@/services/continuity/classify";
import { emptyExtraction, parseContinuityExtraction, type ContinuityExtraction } from "@/services/continuity/schema";

let client: OpenAI | null = null;

function openai(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: getEnv().OPENAI_API_KEY });
  return client;
}

export async function extractContinuity(input: {
  userId: string;
  userTexts: string[];
  amyTexts: string[];
  existingMemories: Array<{ key: string; value: string }>;
  recentUserTexts?: string[];
  upcomingEvents?: UpcomingHint[];
}): Promise<ContinuityExtraction> {
  const started = Date.now();
  let llm = emptyExtraction();
  try {
    llm = await withRetry("openai.extract", () => requestExtraction(input), {
      attempts: 2,
      isRetryable: (error) => {
        const status = error && typeof error === "object" && "status" in error ? (error as { status?: number }).status : undefined;
        return status === 429 || (status != null && status >= 500) || error instanceof ZodError || error instanceof SyntaxError;
      },
    });
    logger.info("openai.request", {
      userId: input.userId,
      purpose: "extraction",
      durationMs: Date.now() - started,
    });
  } catch (error) {
    logger.error("extraction.failure", {
      userId: input.userId,
      name: error instanceof Error ? error.name : "ExtractionError",
      durationMs: Date.now() - started,
    });
  }
  return prepareExtraction({
    llm,
    userTexts: input.userTexts,
    recentUserTexts: input.recentUserTexts,
    upcomingEvents: input.upcomingEvents,
  });
}

async function requestExtraction(input: {
  userTexts: string[];
  amyTexts: string[];
  existingMemories: Array<{ key: string; value: string }>;
  recentUserTexts?: string[];
  upcomingEvents?: UpcomingHint[];
}): Promise<ContinuityExtraction> {
  const completion = await openai().chat.completions.create({
    model: AUXILIARY_OPENAI_MODEL,
    temperature: 0,
    max_tokens: 700,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Extract only future-useful facts about the USER, not about Amy. Return JSON with keys memories, events, promises, timezone.
Memory types must be exactly PERSONAL_FACT, PREFERENCE, INTEREST, RELATIONSHIP, WORK, LOCATION, PET, ROUTINE, or OTHER.
Example: {"memories":[{"type":"PERSONAL_FACT","key":"name","value":"Alex","confidence":0.95,"importance":0.9,"replacesKey":null}],"events":[],"promises":[],"timezone":null}
Rules:
- "my name is Alex", "I'm Alex", and "call me Alex" are PERSONAL_FACT key "name", confidence at least 0.9, importance at least 0.8.
- "I work in real estate", "I'm a realtor", and "I work as a designer" are WORK key "occupation", confidence at least 0.9. Being at a place is not a job.
- A named pet is one PET memory, key "pet". Include breed and name in the value when both were said, such as "golden retriever named Charlie".
- Empty arrays are correct for small talk. Do not store "lol", "bored", "yes", "okay", or momentary actions.
- Do not infer sensitive attributes.
- Extract events only from what the current user lines actually say. Do not invent an event type.
- If they add a detail or a feeling about "it", set replacesTitle to the matching upcoming event instead of creating a new one.
- hour and minute only when a clock time was stated. Leave them null for a date with no time.
- relativeDay, weekday, and explicitDate only from what was said.
- timezone only if they explicitly name one.
- Corrections set replacesKey. Cancelled or moved events set status or replacesTitle.
- Amy promises only if she explicitly committed to doing something later.`,
      },
      {
        role: "user",
        content: JSON.stringify({
          existingMemories: input.existingMemories,
          recentUserLines: input.recentUserTexts ?? [],
          upcomingEvents: input.upcomingEvents ?? [],
          currentUserLines: input.userTexts,
          amy: input.amyTexts,
        }),
      },
    ],
  });
  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("Empty extraction");
  return parseContinuityExtraction(content);
}
