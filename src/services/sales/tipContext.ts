import { emptySalesSignal, type SalesSignal } from "@/services/sales/schema";
import { readSalesSignal, type SignalReading } from "@/services/sales/signals";

export const TIP_CONTEXT_WINDOW_MS = 10 * 60 * 1000;
export const TIP_CONTEXT_MAX_USER_TURNS = 6;

const EXPLICIT_TIP =
  /\b(?:tip|donate|donation)\b|support you|send you (?:money|something)|leave you a tip|чаев\w*|поддержать|задонатить|донат|propina|donaci[oó]n|apoyarte|enviarte dinero|mandarte dinero/i;
const SUPPORT_REQUEST =
  /можно.{0,48}(?:чаевые|поддержать)|как(?:\s+тебя)?\s+поддержать|куда(?:\s+тебе)?\s+отправить\s+чаевые|can i (?:tip|donate)|how (?:can|do) i (?:tip|support|donate)|leave (?:you )?a tip|te puedo dejar una propina|c[oó]mo (?:te |puedo )?apoyarte/i;
const FOLLOW_UP =
  /^(?:кидай|давай|хочу|отправь|скинь|где кнопка|send it|send me the link|do it|yes|yeah|yep|dale|hazlo|m[aá]ndalo|env[ií]alo|env[ií]ame|p[aá]samelo|s[ií])$/i;
const HOW_WHERE_RU =
  /^(?:как|куда)(?:\s+(?:это|тогда|же|мне|тебе|сейчас))?(?:\s+(?:сделать|отправить|скинуть|кинуть))?$/;
const HOW_WHERE_EN =
  /^(?:how|where)(?:\s+(?:do|can)\s+i(?:\s+(?:do|send)(?:\s+(?:it|that|this))?)?)?$/;
const HOW_WHERE_ES =
  /^(?:c[oó]mo|d[oó]nde)(?:\s+(?:te\s+lo|lo|te))?(?:\s+puedo)?(?:\s+(?:hacerlo|hago|env[ií]o))?$/;
const LEAD_IN = /^(?:а|и|ну|and|so|y)\s+/;
const CONTENT_CONDITION =
  /(?:^|\s)(?:если|if|si)(?:\s)[\s\S]{0,80}(?:фото|фотк|photo|pics?|пришл|send)/i;
const TIP_DECLINE =
  /^(?:не[, ]+забей|не[, ]+передумал|передумал|забей|не хочу|не буду|forget it|never mind|no thanks|olv[ií]dalo|no quiero|d[eé]jalo)$/i;
const DISTRESS =
  /\b(kill myself|killing myself|suicide|suicidal|want to die|wanna die|end my life|self[-\s]?harm|hurt myself|can'?t go on|in crisis|personal crisis|overdose)\b/i;
const AMY_TIP = /чаев\w*|поддержать|кнопк\w*.{0,32}чаев|leave a tip|propina|donaci[oó]n|\btip\b/i;
const WEAK = /^(?:ok|okay|ага|угу|понял|ясно|лол|lol|👍|❤️|🤍)[.!]*$/i;

export type TipContextMessage = {
  createdAt: Date;
  sender: "USER" | "AMY";
  text: string | null;
};

export type TipContextState = {
  active: boolean;
  execute: boolean;
  declined: boolean;
  conditionedOnContent: boolean;
};

export function contextualTipReading(input: {
  now: Date;
  currentUserLines: string[];
  history: TipContextMessage[];
  linkSentAt?: Date | null;
}): SignalReading | null {
  const state = evaluateTipContext(input);
  const lines = input.currentUserLines.map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  if (state.declined) return reading({ intent: "NONE", confidence: 0.93, evidence: ["tip declined"] });
  if (DISTRESS.test(lines.join("\n")) && (state.active || EXPLICIT_TIP.test(lines.join("\n")))) {
    return reading({
      intent: "TIP_DISCUSSION",
      emotionalState: "DISTRESSED",
      confidence: 0.93,
      evidence: ["distress during a tip"],
    });
  }
  if (state.conditionedOnContent) {
    const base = readSalesSignal(lines);
    if (base.intent !== "TIP_DISCUSSION" && base.confidence >= 0.8) return base;
    return reading({ intent: "NONE", confidence: 0.93, evidence: ["tip is not payment for content"] });
  }
  if (state.execute) {
    return reading({
      intent: "TIP_DISCUSSION",
      confidence: 0.93,
      evidence: ["contextual tip follow-up"],
    });
  }
  if (isContextualFollowUp(lines)) {
    return reading({ intent: "NONE", confidence: 0.93, evidence: ["short reply outside tip context"] });
  }
  return null;
}

export function evaluateTipContext(input: {
  now: Date;
  currentUserLines: string[];
  history: TipContextMessage[];
  linkSentAt?: Date | null;
}): TipContextState {
  const current = input.currentUserLines.map((line) => line.trim()).filter(Boolean);
  const priorActive = activeBeforeCurrent(input.history, input.now, input.linkSentAt ?? null);
  if (DISTRESS.test(current.join("\n"))) {
    return { active: priorActive, execute: false, declined: false, conditionedOnContent: false };
  }
  const declined = current.length > 0 && current.every((line) => TIP_DECLINE.test(normalize(line)));
  const conditionedOnContent = CONTENT_CONDITION.test(current.join("\n"));
  const explicit = EXPLICIT_TIP.test(current.join("\n"));
  const follow = isContextualFollowUp(current);
  let active = priorActive;
  if (declined) active = false;
  else if (explicit) active = true;
  else if (priorActive && follow) active = true;
  else if (conditionedOnContent || current.every((line) => WEAK.test(normalize(line)))) active = priorActive;
  else if (current.length > 0) active = false;

  const execute =
    !declined &&
    !conditionedOnContent &&
    !DISTRESS.test(current.join("\n")) &&
    (SUPPORT_REQUEST.test(current.join("\n")) || (priorActive && follow));

  return { active, execute, declined, conditionedOnContent };
}

function activeBeforeCurrent(history: TipContextMessage[], now: Date, linkSentAt: Date | null): boolean {
  const cutoff = now.getTime() - TIP_CONTEXT_WINDOW_MS;
  const recent = history.filter((message) => message.createdAt.getTime() >= cutoff && message.text?.trim());
  const userIndexes = recent.flatMap((message, index) => (message.sender === "USER" ? [index] : []));
  const start = userIndexes.length > TIP_CONTEXT_MAX_USER_TURNS ? userIndexes[userIndexes.length - TIP_CONTEXT_MAX_USER_TURNS] : 0;
  let active = false;
  let activatedAt: number | null = null;
  for (const message of recent.slice(start)) {
    const text = message.text?.trim() ?? "";
    if (message.sender === "AMY") {
      if (AMY_TIP.test(text)) {
        active = true;
        activatedAt = message.createdAt.getTime();
      }
      continue;
    }
    if (TIP_DECLINE.test(normalize(text))) {
      active = false;
      activatedAt = null;
      continue;
    }
    if (EXPLICIT_TIP.test(text)) {
      active = true;
      activatedAt = message.createdAt.getTime();
      continue;
    }
    if (CONTENT_CONDITION.test(text) || isContextualFollowUpLine(text) || WEAK.test(normalize(text))) {
      continue;
    }
    active = false;
    activatedAt = null;
  }
  if (linkSentAt && activatedAt !== null && activatedAt <= linkSentAt.getTime()) return false;
  return active;
}

function isContextualFollowUp(lines: string[]): boolean {
  return lines.length > 0 && lines.every((line) => isContextualFollowUpLine(line));
}

function isContextualFollowUpLine(text: string): boolean {
  let line = normalize(text);
  while (LEAD_IN.test(line)) line = line.replace(LEAD_IN, "");
  return FOLLOW_UP.test(line) || HOW_WHERE_RU.test(line) || HOW_WHERE_EN.test(line) || HOW_WHERE_ES.test(line);
}

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^[¿¡]+/, "")
    .replace(/[?!.,…]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function reading(patch: Partial<SalesSignal> & { evidence: string[] }): SignalReading {
  return {
    ...emptySalesSignal(),
    confidence: 0.93,
    ...patch,
    declinedNow: false,
  };
}
