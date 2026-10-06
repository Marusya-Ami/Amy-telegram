import { z } from "zod";

export const MEDIA_CATEGORIES = [
  "selfie",
  "home",
  "work",
  "luna",
  "cosplay",
  "morning",
  "night",
  "cute",
  "flirty",
  "casual",
  "other",
] as const;

export type MediaCategoryName = (typeof MEDIA_CATEGORIES)[number];

const GENERIC_TAGS = new Set([
  "woman",
  "man",
  "person",
  "people",
  "photo",
  "picture",
  "image",
  "photograph",
  "lighting",
  "light",
  "lights",
  "indoor",
  "female",
  "male",
  "girl",
  "boy",
  "human",
  "subject",
  "portrait",
  "camera",
]);

const GENERIC_DESCRIPTION = /^(a |an )?(young )?(woman|girl|person|female)\b/i;

export const mediaAnalysisSchema = z
  .object({
    category: z.enum(MEDIA_CATEGORIES),
    description: z.string().trim().min(1).max(300),
    tags: z.array(z.string().trim().min(1).max(40)).min(2).max(12),
    mood: z.string().trim().min(1).max(40),
    flirtLevel: z.number().int().min(0).max(5),
    peopleCount: z.number().int().min(0).max(20),
    hasAmy: z.boolean(),
    hasLuna: z.boolean(),
    contexts: z.array(z.string().trim().min(1).max(80)).min(1).max(8),
  })
  .superRefine((value, context) => {
    if (GENERIC_DESCRIPTION.test(value.description)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["description"],
        message: "Description is too generic for retrieval",
      });
    }
    if (value.hasAmy && !/\bAmy\b/.test(value.description)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["description"],
        message: "Description should state Amy's visible situation",
      });
    }
  });

export type MediaAnalysis = z.infer<typeof mediaAnalysisSchema>;

export function parseMediaAnalysis(raw: unknown): MediaAnalysis {
  const value = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  return mediaAnalysisSchema.parse(normalizeAnalysis(value));
}

function normalizeAnalysis(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const category = typeof record.category === "string" ? record.category.trim().toLowerCase() : record.category;
  const tags = Array.isArray(record.tags) ? cleanTerms(record.tags).filter((tag) => !GENERIC_TAGS.has(tag)) : record.tags;
  const contexts = Array.isArray(record.contexts) ? cleanTerms(record.contexts) : record.contexts;
  const mood = typeof record.mood === "string" ? record.mood.trim().toLowerCase() : record.mood;
  const description = typeof record.description === "string" ? record.description.trim().replace(/\s+/g, " ") : record.description;
  return { ...record, category, tags, contexts, mood, description };
}

function cleanTerms(values: unknown[]): string[] {
  const terms = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/_+/g, "_"))
    .filter(Boolean);
  return [...new Set(terms)];
}
