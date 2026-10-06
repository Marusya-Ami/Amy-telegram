import OpenAI from "openai";
import { ZodError } from "zod";
import { getEnv } from "@/lib/env";
import { AUXILIARY_OPENAI_MODEL } from "@/lib/openaiModels";
import { logger } from "@/lib/logger";
import { withRetry } from "@/lib/retry";
import { MEDIA_CATEGORIES, parseMediaAnalysis, type MediaAnalysis } from "@/services/media/schema";

let client: OpenAI | null = null;

function openai(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: getEnv().OPENAI_API_KEY });
  return client;
}

export class MediaAnalysisError extends Error {
  constructor() {
    super("Media analysis failed");
    this.name = "MediaAnalysisError";
  }
}

export const MEDIA_ANALYSIS_PROMPT = `You catalog one photo for retrieval inside Amy's own media library. Return JSON only.

The owner uploaded this photo into Amy's library. If a person is the visible subject, call her Amy in the description. That is library context, not facial identification. Luna is Amy's small white Pomeranian; set hasLuna only when a small white dog is visible. Do not name any other person. Do not invent locations, events, relationships, weather, or activities that are not visually supported. Mention time of day only when the image supports it.

The metadata must answer: which existing Amy photo would naturally fit this exact conversation right now?

Fields:
- category: one of ${MEDIA_CATEGORIES.join(", ")}
- description: one factual sentence about Amy's visible situation. Name clothing, setting, and what she is doing when those are visible. Do not write generic computer-vision prose such as "a young woman takes a selfie indoors."
- tags: 4 to 8 lowercase snake_case labels for visible clothing or style, specific setting, and activity or pose. Useful examples include pajamas, casual_outfit, work_outfit, cosplay, dress, bedroom, living_room, kitchen, outdoors, car, bathroom, sitting, lying_down, mirror_selfie, getting_ready, eating, relaxing. Never use generic tags such as woman, person, photo, lighting, or indoor.
- mood: a short retrieval mood such as relaxed, playful, sleepy, happy, cozy, or teasing. Combine two only when both are visible.
- flirtLevel: integer 0 through 5 for how suggestive the image itself is
- peopleCount: integer count of people visible
- hasAmy: true when the library subject is visible
- hasLuna: true only when Luna is visible
- contexts: 2 to 6 snake_case retrieval labels for a conversation. Use one only when it fits, for example at_home, relaxing, morning, evening, good_night, getting_ready, what_are_you_doing, casual_selfie, work, luna, cosplay, food, going_out, flirty. Do not add a context that the image does not support.

Example description style: "Amy taking a relaxed selfie at home in light pajamas, sitting in the living room and smiling at the camera."`;

export async function analyzeFreePhoto(bytes: Buffer, mimeType: string): Promise<MediaAnalysis> {
  try {
    return await withRetry("openai.media", () => requestAnalysis(bytes, mimeType), {
      attempts: 3,
      isRetryable: (error) => {
        if (error instanceof ZodError || error instanceof SyntaxError) return true;
        const status = (error as { status?: number }).status;
        return status === 429 || (status != null && status >= 500);
      },
    });
  } catch (error) {
    logger.warn("media.analysis_failed", {
      name: error instanceof Error ? error.name : "Error",
    });
    if (error instanceof MediaAnalysisError) throw error;
    if (error instanceof ZodError || error instanceof SyntaxError) throw new MediaAnalysisError();
    throw error;
  }
}

async function requestAnalysis(bytes: Buffer, mimeType: string): Promise<MediaAnalysis> {
  const completion = await openai().chat.completions.create({
    model: AUXILIARY_OPENAI_MODEL,
    temperature: 0.2,
    max_tokens: 700,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: MEDIA_ANALYSIS_PROMPT },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${bytes.toString("base64")}` } },
        ],
      },
    ],
  });
  const content = completion.choices[0]?.message?.content;
  if (!content) throw new MediaAnalysisError();
  return parseMediaAnalysis(content);
}
