import { z } from "zod";

export const SALES_INTENTS = [
  "NONE",
  "MEDIA_REQUEST",
  "PREMIUM_MEDIA_REQUEST",
  "FLIRT",
  "REACTION_TO_MEDIA",
  "PURCHASE_DISCUSSION",
  "TIP_DISCUSSION",
] as const;

export const COMMERCIAL_READINESS = ["LOW", "MEDIUM", "HIGH"] as const;
export const EMOTIONAL_STATES = ["NORMAL", "SENSITIVE", "DISTRESSED"] as const;

export const salesSignalSchema = z.object({
  mediaInterest: z.boolean(),
  explicitMediaRequest: z.boolean(),
  premiumInterest: z.boolean(),
  intent: z.enum(SALES_INTENTS),
  flirtLevel: z.number().int().min(0).max(5),
  desiredContexts: z.array(z.string().trim().min(1).max(40)).max(8),
  commercialReadiness: z.enum(COMMERCIAL_READINESS),
  emotionalState: z.enum(EMOTIONAL_STATES),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().trim().min(1).max(80)).max(5),
});

export type SalesSignal = z.infer<typeof salesSignalSchema>;

export function emptySalesSignal(): SalesSignal {
  return {
    mediaInterest: false,
    explicitMediaRequest: false,
    premiumInterest: false,
    intent: "NONE",
    flirtLevel: 0,
    desiredContexts: [],
    commercialReadiness: "LOW",
    emotionalState: "NORMAL",
    confidence: 0.4,
    evidence: [],
  };
}

export function normalizeContextTerm(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

export function parseSalesSignal(raw: unknown): SalesSignal {
  const value = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  const parsed = salesSignalSchema.parse(normalizeSignalInput(value));
  return capOrdinaryFlirt(parsed);
}

function normalizeSignalInput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const desiredContexts = Array.isArray(record.desiredContexts)
    ? [...new Set(record.desiredContexts.map((item) => (typeof item === "string" ? normalizeContextTerm(item) : "")).filter(Boolean))].slice(0, 8)
    : record.desiredContexts;
  const evidence = Array.isArray(record.evidence)
    ? record.evidence
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().replace(/\s+/g, " ").slice(0, 80))
        .filter(Boolean)
        .slice(0, 5)
    : record.evidence;
  return { ...record, desiredContexts, evidence };
}

/** Ordinary flirting is not purchase intent. A flirt-only HIGH score is lowered. */
export function capOrdinaryFlirt(signal: SalesSignal): SalesSignal {
  const purchaseTalk =
    signal.premiumInterest ||
    signal.intent === "PREMIUM_MEDIA_REQUEST" ||
    signal.intent === "PURCHASE_DISCUSSION" ||
    signal.intent === "TIP_DISCUSSION";
  if (purchaseTalk || signal.commercialReadiness !== "HIGH") return signal;
  if (signal.explicitMediaRequest || signal.intent === "MEDIA_REQUEST") {
    return { ...signal, commercialReadiness: "MEDIUM" };
  }
  return { ...signal, commercialReadiness: "LOW" };
}
