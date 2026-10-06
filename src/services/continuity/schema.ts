import { z } from "zod";

const memoryType = z.enum([
  "PERSONAL_FACT",
  "PREFERENCE",
  "INTEREST",
  "RELATIONSHIP",
  "WORK",
  "LOCATION",
  "PET",
  "ROUTINE",
  "OTHER",
]);

export const continuityExtractionSchema = z.object({
  memories: z
    .array(
      z.object({
        type: memoryType,
        key: z.string().trim().min(1).max(80),
        value: z.string().trim().min(1).max(500),
        confidence: z.number().min(0).max(1),
        importance: z.number().min(0).max(1),
        replacesKey: z.string().trim().min(1).max(80).nullable(),
      }),
    )
    .max(8),
  events: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(120),
        description: z.string().trim().max(500).nullable(),
        relativeDay: z.enum(["today", "tomorrow", "tonight", "next_week"]).nullable(),
        weekday: z.enum(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]).nullable(),
        explicitDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
        hour: z.number().int().min(0).max(23).nullable(),
        minute: z.number().int().min(0).max(59).nullable(),
        status: z.enum(["UPCOMING", "PAST", "CANCELLED", "UNKNOWN"]),
        emotionalContext: z.string().trim().max(200).nullable(),
        followUpEligible: z.boolean(),
        replacesTitle: z.string().trim().max(120).nullable(),
      }),
    )
    .max(4),
  promises: z
    .array(
      z.object({
        madeBy: z.enum(["USER", "AMY"]),
        text: z.string().trim().min(1).max(300),
        relativeDay: z.enum(["today", "tomorrow", "tonight", "next_week"]).nullable(),
        weekday: z.enum(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]).nullable(),
        explicitDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
        hour: z.number().int().min(0).max(23).nullable(),
        minute: z.number().int().min(0).max(59).nullable(),
      }),
    )
    .max(3),
  timezone: z.string().trim().min(1).max(80).nullable(),
});

export type ContinuityExtraction = z.infer<typeof continuityExtractionSchema>;

const MEMORY_TYPES = new Set([
  "PERSONAL_FACT",
  "PREFERENCE",
  "INTEREST",
  "RELATIONSHIP",
  "WORK",
  "LOCATION",
  "PET",
  "ROUTINE",
  "OTHER",
]);

const TYPE_ALIASES: Record<string, ContinuityExtraction["memories"][number]["type"]> = {
  NAME: "PERSONAL_FACT",
  PREFERRED_NAME: "PERSONAL_FACT",
  OCCUPATION: "WORK",
  JOB: "WORK",
  CAREER: "WORK",
  PET_NAME: "PET",
};

export function parseContinuityExtraction(payload: unknown): ContinuityExtraction {
  const record = typeof payload === "string" ? JSON.parse(stripFence(payload)) : payload;
  const source = record && typeof record === "object" ? (record as Record<string, unknown>) : {};
  return continuityExtractionSchema.parse({
    memories: arrayOf(source.memories).map(coerceMemory).filter(Boolean),
    events: arrayOf(source.events).map(coerceEvent).filter(Boolean),
    promises: arrayOf(source.promises).map(coercePromise).filter(Boolean),
    timezone: nullableString(source.timezone),
  });
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function coerceMemory(value: unknown): ContinuityExtraction["memories"][number] | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const rawType = String(item.type ?? "").trim().toUpperCase();
  const type = MEMORY_TYPES.has(rawType) ? rawType : TYPE_ALIASES[rawType];
  const valueText = nullableString(item.value);
  if (!type || !valueText) return null;
  let key = String(item.key ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  if (key === "preferred_name" || key === "full_name") key = "name";
  if (key === "job" || key === "work" || key === "career") key = "occupation";
  if (type === "PET" && (key === "dog" || key === "cat" || key === "pet_name")) key = "pet";
  if (!key) return null;
  const explicit = key === "name" || key === "occupation" || key === "pet";
  return {
    type: type as ContinuityExtraction["memories"][number]["type"],
    key,
    value: valueText,
    confidence: numberInRange(item.confidence, explicit ? 0.9 : 0),
    importance: numberInRange(item.importance, explicit ? 0.8 : 0),
    replacesKey: nullableString(item.replacesKey),
  };
}

function coerceEvent(value: unknown): ContinuityExtraction["events"][number] | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const title = nullableString(item.title);
  if (!title) return null;
  const status = String(item.status ?? "UPCOMING").trim().toUpperCase();
  return {
    title,
    description: nullableString(item.description),
    relativeDay: relativeDay(item.relativeDay),
    weekday: weekday(item.weekday),
    explicitDate: dateString(item.explicitDate),
    hour: clockPart(item.hour, 23),
    minute: clockPart(item.minute, 59),
    status: status === "PAST" || status === "CANCELLED" || status === "UNKNOWN" ? status : "UPCOMING",
    emotionalContext: nullableString(item.emotionalContext),
    followUpEligible: item.followUpEligible !== false,
    replacesTitle: nullableString(item.replacesTitle),
  };
}

function coercePromise(value: unknown): ContinuityExtraction["promises"][number] | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const text = nullableString(item.text);
  const madeBy = String(item.madeBy ?? "").trim().toUpperCase();
  if (!text || (madeBy !== "USER" && madeBy !== "AMY")) return null;
  return {
    madeBy,
    text,
    relativeDay: relativeDay(item.relativeDay),
    weekday: weekday(item.weekday),
    explicitDate: dateString(item.explicitDate),
    hour: clockPart(item.hour, 23),
    minute: clockPart(item.minute, 59),
  };
}

function nullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function numberInRange(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(1, Math.max(0, parsed));
}

function clockPart(value: unknown, max: number): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) return null;
  return parsed;
}

function relativeDay(value: unknown): ContinuityExtraction["events"][number]["relativeDay"] {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (text === "today" || text === "tomorrow" || text === "tonight" || text === "next_week") return text;
  return null;
}

function weekday(value: unknown): ContinuityExtraction["events"][number]["weekday"] {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (
    text === "sunday" ||
    text === "monday" ||
    text === "tuesday" ||
    text === "wednesday" ||
    text === "thursday" ||
    text === "friday" ||
    text === "saturday"
  ) {
    return text;
  }
  return null;
}

function dateString(value: unknown): string | null {
  const text = nullableString(value);
  return text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function stripFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced?.[1]?.trim() || trimmed;
}

export const emptyExtraction = (): ContinuityExtraction => ({
  memories: [],
  events: [],
  promises: [],
  timezone: null,
});
