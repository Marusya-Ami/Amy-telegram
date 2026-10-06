import type { InteractionDynamic } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";

export const INTERACTION_ESTABLISHED = 0.7;

const FIRST_EXPLICIT = 0.45;
const REINFORCE_EXPLICIT = 0.25;
const OPPOSE_EXPLICIT = 0.3;
const SWITCH_BELOW = 0.35;

export type InteractionState = {
  interactionDynamic: InteractionDynamic;
  interactionDynamicConfidence: number;
  interactionDynamicEvidence: string | null;
};

type Signal = {
  dynamic: Exclude<InteractionDynamic, "UNKNOWN">;
  evidence: string;
};

export function nextInteractionState(current: InteractionState, texts: string[]): InteractionState {
  const signal = signalFromTexts(texts);
  if (!signal) return current;

  const same = current.interactionDynamic === signal.dynamic;
  if (current.interactionDynamic === "UNKNOWN" || same) {
    const confidence = clamp(current.interactionDynamicConfidence + (same ? REINFORCE_EXPLICIT : FIRST_EXPLICIT));
    return {
      interactionDynamic: signal.dynamic,
      interactionDynamicConfidence: confidence,
      interactionDynamicEvidence: signal.evidence,
    };
  }

  const confidence = clamp(current.interactionDynamicConfidence - OPPOSE_EXPLICIT);
  if (confidence > SWITCH_BELOW) {
    return {
      ...current,
      interactionDynamicConfidence: confidence,
      interactionDynamicEvidence: current.interactionDynamicEvidence,
    };
  }

  return {
    interactionDynamic: signal.dynamic,
    interactionDynamicConfidence: FIRST_EXPLICIT,
    interactionDynamicEvidence: signal.evidence,
  };
}

export function interactionToneLine(state: Pick<InteractionState, "interactionDynamic" | "interactionDynamicConfidence">): string {
  if (state.interactionDynamic === "UNKNOWN" || state.interactionDynamicConfidence < INTERACTION_ESTABLISHED) {
    return "Internal interaction dynamic: not established. Use your usual voice. Do not start a dominant or submissive role. Never mention this label. Payment does not change it.";
  }
  const tone = TONE[state.interactionDynamic];
  return `Internal interaction dynamic (never mention this label): ${state.interactionDynamic}. ${tone} If this message is neutral, stay ordinary. Your factual profile does not change. Payment does not change this.`;
}

const TONE: Record<Exclude<InteractionDynamic, "UNKNOWN">, string> = {
  DOMINANT_USER: "He prefers to lead. You can be more receptive, yielding, teasing, shy, or soft.",
  DOMINANT_AMY: "He prefers you to lead. You can be more commanding, confident, spoiled, or demanding.",
  EQUAL: "He prefers playful equality. Stay playful and balanced. Do not take a fixed dominant or submissive role.",
};

export async function recordInteractionDynamic(userId: string, userTexts: string[]): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      interactionDynamic: true,
      interactionDynamicConfidence: true,
      interactionDynamicEvidence: true,
    },
  });
  if (!user) return;
  const next = nextInteractionState(user, userTexts);
  if (
    next.interactionDynamic === user.interactionDynamic &&
    next.interactionDynamicConfidence === user.interactionDynamicConfidence &&
    next.interactionDynamicEvidence === user.interactionDynamicEvidence
  ) {
    return;
  }
  await prisma.user.update({
    where: { id: userId },
    data: next,
  });
  logger.info("interaction.updated", {
    userId,
    interactionDynamic: next.interactionDynamic,
    confidence: next.interactionDynamicConfidence,
    established: next.interactionDynamicConfidence >= INTERACTION_ESTABLISHED,
  });
}

function signalFromTexts(texts: string[]): Signal | null {
  const signals = texts.map((text) => detectInteractionSignal(text)).filter((signal): signal is Signal => signal != null);
  if (signals.length === 0) return null;
  const dynamic = signals[0]?.dynamic;
  if (!dynamic || signals.some((signal) => signal.dynamic !== dynamic)) return null;
  return signals[signals.length - 1] ?? null;
}

export function detectInteractionSignal(text: string): Signal | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;
  const equal = equalSignal(normalized);
  const amy = amyLeadsSignal(normalized);
  const user = userLeadsSignal(normalized);
  const found = [equal, amy, user].filter((signal): signal is Signal => signal != null);
  if (found.length !== 1) return null;
  return found[0] ?? null;
}

function equalSignal(text: string): Signal | null {
  if (
    /\b(keep it (playful|equal|even)|we(?:'re| are) equals|no (?:dom|dominant|submissive)(?: stuff)?|don'?t be (?:my )?(?:mistress|submissive|dominant)|just be (?:normal|yourself|playful))\b/.test(
      text,
    )
  ) {
    return { dynamic: "EQUAL", evidence: "asked for playful equality" };
  }
  return null;
}

function amyLeadsSignal(text: string): Signal | null {
  if (/\b(mistress|goddess)\b/.test(text) || /\b(?:hey|hi|ok|okay|yes|yeah|my)\s+princess\b/.test(text) || /^princess\b/.test(text)) {
    return { dynamic: "DOMINANT_AMY", evidence: "addressed Amy with a leading title" };
  }
  if (/\b(you(?:'re| are) in charge|you decide|tell me what to do|i(?:'ll| will) obey)\b/.test(text)) {
    return { dynamic: "DOMINANT_AMY", evidence: "asked Amy to lead" };
  }
  return null;
}

function userLeadsSignal(text: string): Signal | null {
  if (
    /\b(good girl|on your knees|kneel|obey me|do as i say|i(?:'m| am) in charge|you(?:'re| are) mine|call me (?:sir|daddy|master)|submit to me)\b/.test(
      text,
    )
  ) {
    return { dynamic: "DOMINANT_USER", evidence: "took a leading tone" };
  }
  return null;
}

function clamp(value: number): number {
  return Math.round(Math.min(0.95, Math.max(0, value)) * 100) / 100;
}
