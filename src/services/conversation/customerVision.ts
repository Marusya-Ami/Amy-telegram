import OpenAI from "openai";
import { z } from "zod";
import { getEnv } from "@/lib/env";
import { AUXILIARY_OPENAI_MODEL } from "@/lib/openaiModels";
import { logger } from "@/lib/logger";

const customerPhotoSchema = z.object({
  subject: z.string().trim().min(1).max(120),
  setting: z.string().trim().max(80).default(""),
  activity: z.string().trim().max(80).default(""),
  details: z.array(z.string().trim().min(1).max(40)).max(4).default([]),
  visibleText: z.string().trim().max(80).default(""),
  captionFit: z.enum(["yes", "no", "unclear", "no_caption"]).default("unclear"),
});

export type CustomerPhotoContext = z.infer<typeof customerPhotoSchema>;

const VISION_PROMPT = `Describe one photo a person sent in a chat. Return JSON only.

Fields:
- subject: the main visible object or scene, one short factual phrase
- setting: the visible place type, or empty
- activity: what is visibly happening, or empty
- details: up to 4 short visible details
- visibleText: text you can actually read in the image, or empty
- captionFit: yes, no, unclear, or no_caption when no caption was provided

The caption is the sender's words. Use it only to set captionFit. Do not treat the caption as something visible in the image.
Do not infer identity, name, exact location, occupation, relationships, health, or intent.
Do not write a chat reply.`;

let client: OpenAI | null = null;

function openai(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: getEnv().OPENAI_API_KEY });
  return client;
}

export function formatCustomerPhotoContext(facts: CustomerPhotoContext): string {
  const parts = [`subject: ${facts.subject}`];
  if (facts.setting) parts.push(`setting: ${facts.setting}`);
  if (facts.activity) parts.push(`activity: ${facts.activity}`);
  if (facts.details.length > 0) parts.push(`details: ${facts.details.join(", ")}`);
  if (facts.visibleText) parts.push(`visible text: ${facts.visibleText}`);
  parts.push(`caption fit: ${facts.captionFit}`);
  return parts.join("; ").slice(0, 500);
}

export function visualTurnNote(
  summary: string | null,
  hasText: boolean,
  form: "photo" | "image_file" | "video" | "animation" = "photo",
): string {
  const sent = form === "video" ? "a video" : form === "animation" ? "an animation" : form === "image_file" ? "an image file" : "a photo";
  const still = form === "video" || form === "animation" ? "A factual still, not his words" : "Factual visible context, not his words";
  if (summary) {
    return `He sent ${sent}. ${still}: ${summary}. Reply as someone who saw it. Do not mention analysis, models, or being unable to see.`;
  }
  if (hasText) {
    return `He also sent ${sent}. You do not have reliable visible facts for it. Do not invent what it shows. Do not say you cannot see or that you can only text. Respond to his words.`;
  }
  return `He sent ${sent} and no caption. You do not have reliable visible facts. Do not invent what it shows. Do not say you cannot see or that you can only text. Reply briefly in the language of the chat.`;
}

export async function describeCustomerPhoto(input: {
  bytes: Buffer;
  mimeType: string;
  caption: string | null;
  complete?: (messages: OpenAI.Chat.ChatCompletionMessageParam[]) => Promise<string>;
}): Promise<CustomerPhotoContext | null> {
  try {
    const content = input.complete
      ? await input.complete(visionMessages(input.bytes, input.mimeType, input.caption))
      : await requestVision(input.bytes, input.mimeType, input.caption);
    const parsed = customerPhotoSchema.parse(JSON.parse(content));
    if (!input.caption?.trim()) parsed.captionFit = "no_caption";
    return parsed;
  } catch (error) {
    logger.warn("customer_photo.vision_failed", {
      name: error instanceof Error ? error.name : "Error",
    });
    return null;
  }
}

function visionMessages(bytes: Buffer, mimeType: string, caption: string | null): OpenAI.Chat.ChatCompletionMessageParam[] {
  const captionLine = caption?.trim() ? `Caption: ${caption.trim().slice(0, 300)}` : "Caption: none";
  return [
    {
      role: "user",
      content: [
        { type: "text", text: `${VISION_PROMPT}\n\n${captionLine}` },
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${bytes.toString("base64")}` } },
      ],
    },
  ];
}

async function requestVision(bytes: Buffer, mimeType: string, caption: string | null): Promise<string> {
  const completion = await openai().chat.completions.create({
    model: AUXILIARY_OPENAI_MODEL,
    temperature: 0.2,
    max_tokens: 300,
    response_format: { type: "json_object" },
    messages: visionMessages(bytes, mimeType, caption),
  });
  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("Empty vision response");
  return content;
}
