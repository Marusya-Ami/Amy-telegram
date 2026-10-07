import type { ContinuityExtraction } from "@/services/continuity/schema";
import { emptyExtraction } from "@/services/continuity/schema";
import { contentTokens, eventCategory } from "@/services/continuity/match";

const NOT_A_NAME = new Set([
  "a",
  "an",
  "the",
  "tired",
  "good",
  "fine",
  "ok",
  "okay",
  "nervous",
  "bored",
  "hungry",
  "busy",
  "home",
  "back",
  "here",
  "sorry",
  "done",
  "late",
  "early",
  "sick",
  "happy",
  "sad",
  "excited",
  "worried",
  "anxious",
  "scared",
  "stressed",
  "free",
  "ready",
  "sure",
  "not",
  "so",
  "just",
  "gonna",
  "going",
  "kinda",
  "kind",
  "really",
  "very",
  "fun",
  "drama",
  "single",
  "normal",
  "nice",
  "bad",
  "cool",
  "super",
  "sweet",
  "smart",
  "dumb",
  "weird",
  "crazy",
  "chill",
]);

const SPECIES = new Set(["dog", "cat", "puppy", "kitten", "bird", "pet", "pup"]);

const FAMILY_WORDS = new Set([
  "mom",
  "mother",
  "dad",
  "father",
  "parent",
  "parents",
  "sister",
  "sisters",
  "brother",
  "brothers",
  "sibling",
  "siblings",
  "son",
  "daughter",
  "grandma",
  "grandmother",
  "grandpa",
  "grandfather",
  "aunt",
  "uncle",
  "cousin",
  "niece",
  "nephew",
  "stepmom",
  "stepdad",
]);

const INVALID_OCCUPATION_WORDS = /\b(dinner|lunch|breakfast|food|meal|snack|break|eating|bought|got|brought)\b/i;

function containsFamilyWord(text: string): boolean {
  return text.toLowerCase().split(/\W+/).some((token) => FAMILY_WORDS.has(token));
}

export type UpcomingHint = {
  title: string;
  eventDate: string | null;
};

export function prepareExtraction(input: {
  llm: ContinuityExtraction | null;
  userTexts: string[];
  recentUserTexts?: string[];
  upcomingEvents?: UpcomingHint[];
}): ContinuityExtraction {
  const llm = input.llm ?? emptyExtraction();
  const current = input.userTexts.map((text) => text.trim()).filter(Boolean);
  const recent = (input.recentUserTexts ?? []).map((text) => text.trim()).filter(Boolean);
  const merged = mergeMemories(explicitMemories(current), llm.memories);
  const memories = normalizeMemories(merged);
  const events = resolveEvents(llm.events, current, recent, input.upcomingEvents ?? []);
  return {
    memories: memories.slice(0, 8),
    events: events.slice(0, 4),
    promises: llm.promises,
    timezone: llm.timezone,
  };
}

function normalizeMemories(memories: ContinuityExtraction["memories"]): ContinuityExtraction["memories"] {
  const result: ContinuityExtraction["memories"] = [];
  for (const mem of memories) {
    let type = mem.type;
    let key = mem.key;
    const { value, confidence, importance } = mem;
    const keyLower = key.toLowerCase();
    const valLower = value.toLowerCase();

    if (keyLower === "name") {
      if (
        NOT_A_NAME.has(valLower) ||
        /\b(?:fun|drama|person|guy|man|woman|boy|girl)\b/i.test(value)
      ) {
        continue;
      }
    }

    const isFamily = containsFamilyWord(keyLower) || containsFamilyWord(valLower);
    if (type === "PET" && isFamily) {
      type = "RELATIONSHIP";
      if (keyLower === "pet" || keyLower === "dog" || keyLower === "cat" || keyLower === "puppy") {
        key = "family";
      }
    }

    if (type === "WORK" && (keyLower === "occupation" || keyLower === "job")) {
      if (INVALID_OCCUPATION_WORDS.test(value) || value.trim().length < 2) {
        continue;
      }
    }

    result.push({ ...mem, type, key, value, confidence, importance });
  }
  return result;
}

export function explicitMemories(texts: string[]): ContinuityExtraction["memories"] {
  const found: ContinuityExtraction["memories"] = [];
  for (const text of texts) {
    const name = explicitName(text);
    if (name) found.push(memory("PERSONAL_FACT", "name", name, 0.95, 0.9));
    const occupation = explicitOccupation(text);
    if (occupation) found.push(memory("WORK", "occupation", occupation, 0.95, 0.85));
    const pet = explicitPet(text);
    if (pet) found.push(memory("PET", "pet", pet, 0.95, 0.8));
  }
  return mergeMemories(found, []);
}

function explicitName(text: string): string | null {
  if (/\b(?:don'?t|do not|never|stop|please don'?t)\s+(?:call me|calling me)\b/i.test(text)) {
    return null;
  }
  const named = text.match(/\bmy name is ([A-Za-z][A-Za-z'-]{1,30})\b/i);
  if (named?.[1] && !NOT_A_NAME.has(named[1].toLowerCase())) return cleanName(named[1]);

  const called = text.match(/\bcall me ([A-Za-z][A-Za-z'-]{1,30})\b/i);
  if (called?.[1]) {
    const candidate = called[1].toLowerCase();
    if (!NOT_A_NAME.has(candidate) && !/\bcall me [A-Za-z'-]+\s+(?:boy|girl|man|woman|guy|dude|baby|sweetheart|names|person)\b/i.test(text)) {
      return cleanName(called[1]);
    }
  }

  const shortened = text.match(/\bi(?:'m| am) ([A-Za-z][A-Za-z'-]{1,30})\b/i);
  if (shortened?.[1]) {
    const candidate = shortened[1].toLowerCase();
    if (!NOT_A_NAME.has(candidate) && !/\bi(?:'m| am)\s+[A-Za-z'-]+\s+(?:person|guy|man|woman|boy|girl|dude|one|human)\b/i.test(text)) {
      return cleanName(shortened[1]);
    }
  }
  return null;
}

function explicitOccupation(text: string): string | null {
  const patterns = [
    /\bi work in ([A-Za-z][A-Za-z\s]{1,40})/i,
    /\bi work as (?:a |an )?([A-Za-z][A-Za-z\s]{1,40})/i,
    /\bi(?:'m| am) (?:a |an )([A-Za-z][A-Za-z\s]{1,40})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const value = match[1].replace(/[.!?,].*$/, "").trim();
    if (value && !NOT_A_NAME.has(value.toLowerCase()) && !INVALID_OCCUPATION_WORDS.test(value)) {
      return value;
    }
  }
  return null;
}

function explicitPet(text: string): string | null {
  const match = text.match(/\b(?:i have (?:a |an )?|my )([A-Za-z][A-Za-z\s]{0,40}?) (?:named|called) ([A-Za-z][A-Za-z'-]{1,30})\b/i);
  if (!match?.[1] || !match[2]) return null;
  const descriptor = match[1].replace(/^(a|an|the)\s+/i, "").trim();
  const name = cleanName(match[2]);
  if (!name || NOT_A_NAME.has(descriptor.toLowerCase())) return null;
  if (SPECIES.has(descriptor.toLowerCase())) return name;
  return `${descriptor} named ${name}`;
}

function resolveEvents(
  events: ContinuityExtraction["events"],
  current: string[],
  recent: string[],
  upcoming: UpcomingHint[],
): ContinuityExtraction["events"] {
  const emotion = emotionIn(current.join(" "));
  const companion = current.map(companionPhrase).find((value): value is string => Boolean(value)) ?? null;
  const introducesEvent = current.some((text) => eventCategory(text) != null);
  let grounded = events.filter((event) => mentions(current, contentTokens(event.title)));
  if ((emotion || companion) && !introducesEvent) {
    const referent = pickReferent(upcoming, recent);
    if (referent) {
      return [
        {
          title: referent.title,
          description: companion ? `with ${companion}` : null,
          relativeDay: null,
          weekday: null,
          explicitDate: null,
          hour: null,
          minute: null,
          status: "UPCOMING",
          emotionalContext: emotion,
          followUpEligible: true,
          replacesTitle: referent.title,
        },
      ];
    }
  }
  if (companion) {
    grounded = grounded.map((event) => (event.description ? event : { ...event, description: `with ${companion}` }));
  }
  return grounded.map((event) => (emotion && !event.emotionalContext ? { ...event, emotionalContext: emotion } : event));
}

function companionPhrase(text: string): string | null {
  const match = text.match(/\b(?:it'?s|it is)?\s*with (?:my )?([A-Za-z][A-Za-z\s]{1,40})/i);
  if (!match?.[1]) return null;
  const value = match[1].replace(/[.!?,].*$/, "").trim();
  return value.length > 1 ? value : null;
}

function pickReferent(upcoming: UpcomingHint[], recent: string[]): UpcomingHint | null {
  const mentioned = upcoming.find((event) => mentions(recent, contentTokens(event.title)));
  return mentioned ?? upcoming[0] ?? null;
}

function mentions(texts: string[], tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const haystack = texts.join(" ").toLowerCase();
  return tokens.some((token) => haystack.includes(token));
}

function emotionIn(text: string): string | null {
  const match = text.match(/\b(nervous|anxious|worried|excited|scared|stressed)\b/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function cleanName(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function memory(
  type: ContinuityExtraction["memories"][number]["type"],
  key: string,
  value: string,
  confidence: number,
  importance: number,
): ContinuityExtraction["memories"][number] {
  return { type, key, value, confidence, importance, replacesKey: null };
}

function mergeMemories(
  primary: ContinuityExtraction["memories"],
  secondary: ContinuityExtraction["memories"],
): ContinuityExtraction["memories"] {
  const byKey = new Map<string, ContinuityExtraction["memories"][number]>();
  for (const item of [...secondary, ...primary]) {
    const key = item.key === "dog" || item.key === "cat" || item.key === "pet_name" ? "pet" : item.key;
    const normalized = key === item.key ? item : { ...item, key };
    const previous = byKey.get(normalized.key);
    if (!previous || normalized.confidence >= previous.confidence) byKey.set(normalized.key, normalized);
  }
  return [...byKey.values()];
}
