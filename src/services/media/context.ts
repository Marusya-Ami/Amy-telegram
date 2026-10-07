import { isValidTimeZone, zonedParts } from "@/services/continuity/time";

export type MediaContextMessage = {
  sender: "USER" | "AMY";
  text: string;
};

export type MediaContextInput = {
  currentMessage: string;
  history?: MediaContextMessage[];
  userTimezone?: string | null;
  now?: Date;
};

export type MediaContextResult = {
  desiredContexts: string[];
  wantsLuna: boolean;
  hasSpecificTopic: boolean;
  source: "luna" | "explicit_topic" | "conversation_topic" | "other_person" | "user_pet" | "time_fallback" | "generic_fallback";
};

/**
 * How far back Amy scene statements may influence a follow-up photo request.
 * Independent of tip context (10 minutes). Stale gym/coffee talk is not reused
 * hours later. Callers must filter history to this window before passing it in.
 */
export const MEDIA_CONTEXT_WINDOW_MS = 30 * 60 * 1000;
export const MEDIA_CONTEXT_HISTORY_LIMIT = 6;

const GENERIC_MEDIA_CONTEXTS = new Set([
  "casual_selfie",
  "at_home",
  "selfie",
  "casual",
  "cute",
  "flirty",
  "home",
  "other",
  "morning",
  "evening",
  "night",
  "good_night",
]);

export function isSpecificMediaTopic(context: string): boolean {
  return !GENERIC_MEDIA_CONTEXTS.has(context.toLowerCase().trim());
}

export function hasSpecificMediaContext(desiredContexts: string[]): boolean {
  return desiredContexts.some(isSpecificMediaTopic);
}

export function boundMediaContextHistory(
  messages: Array<MediaContextMessage & { createdAt: Date }>,
  now: Date,
): MediaContextMessage[] {
  const cutoff = now.getTime() - MEDIA_CONTEXT_WINDOW_MS;
  return messages
    .filter((message) => message.createdAt.getTime() >= cutoff)
    .slice(-MEDIA_CONTEXT_HISTORY_LIMIT)
    .map((message) => ({ sender: message.sender, text: message.text }));
}

/** Clock helper for tests only. extractMediaContext does not inject time-of-day. */
export function getTimeOfDayContexts(now: Date, timeZone?: string | null): string[] {
  if (!timeZone || !isValidTimeZone(timeZone)) return [];
  const parts = zonedParts(now, timeZone);
  const totalMinutes = parts.hour * 60 + parts.minute;

  if (totalMinutes >= 300 && totalMinutes <= 689) return ["morning"];
  if (totalMinutes >= 690 && totalMinutes <= 1079) return [];
  if (totalMinutes >= 1080 && totalMinutes <= 1319) return ["evening"];
  return ["good_night", "night"];
}

const LUNA_NAME = /\bluna\b/i;
const AMY_DOG = /\b(?:your|amy'?s|deinen|deine[nm]?|tu|tu[sy]|тво(?:я|й|его|ю))\s+(?:dog|puppy|hund|hunde|собак\w*|perro)\b/i;
const USER_OWNED_PET =
  /\b(?:my|mine|mein(?:e[rns]?)?|моя|мой|моего|моей|моего|mi)\s+(?:dog|puppy|pet|pets|hund|hunde|собак\w*|perro|perrito)\b/i;
const GENERIC_ANIMAL =
  /\b(?:dog|doggy|dogs|puppy|puppies|pet|pets|hund|hunde|h[uü]ndchen|welpe|welpen|пес|пёс|собака|собачка|щенок|щенка|perro|perrito)\b/i;
const PHOTO_OF_USER_PET =
  /\b(?:pic|pics|photo|photos|picture|pictures|foto|fotos|bild|bilder|фотк\w*|селфи)\b.{0,24}(?:my|mein(?:e[rns]?)?|моя|мой|mi)\s+(?:dog|puppy|pet|hund|собак\w*|perro)|\b(?:my|mein(?:e[rns]?)?|моя|мой|mi)\s+(?:dog|puppy|pet|hund|собак\w*|perro).{0,24}\b(?:pic|pics|photo|photos|picture|foto|bild)\b/i;

const OTHER_PERSON =
  /\b(?:friend|friends|buddy|mom|dad|mother|father|sister|brother|boyfriend|girlfriend|wife|husband|coworker|colleague|roommate|freund(?:in)?|mama|papa|schwester|bruder|freundin|подруг\w*|друг\w*|мама|папа|сестра|брат|amiga?|amigo|mam[aá]|pap[aá])\b/i;

type TopicMatcher = {
  name: string;
  pattern: RegExp;
  contexts: string[];
};

const TOPIC_MATCHERS: TopicMatcher[] = [
  {
    name: "luna",
    pattern: /\bluna\b/i,
    contexts: ["luna"],
  },
  {
    name: "gym",
    pattern:
      /\b(gym|workout|working out|fitness|exercise|exercising|training|weights|treadmill|спортзал|зал|тренировк\w*|фитнес|качалк\w*|fitnessstudio)\b/i,
    contexts: ["gym", "workout"],
  },
  {
    name: "work",
    pattern:
      /\b(at work|working|work(?:ing)?\s+(?:pic|photo|outfit)|from work|to work|my shift|on shift|restaurant|twin peaks|serving|waitress|на работе|на смене|работаю|auf der arbeit|im dienst|en el trabajo)\b/i,
    contexts: ["work", "restaurant", "at_restaurant"],
  },
  {
    name: "coffee_breakfast",
    pattern: /\b(breakfast|pancakes|waffles|завтрак|frühstück|desayuno)\b/i,
    contexts: ["breakfast", "morning", "coffee"],
  },
  {
    name: "coffee",
    pattern: /\b(coffee|latte|cappuccino|espresso|cup of joe|кофе|кофейк\w*|kaffee|café)\b/i,
    contexts: ["coffee"],
  },
  {
    name: "cosplay",
    pattern: /\b(cosplay|costume|anime|bunny|косплей|костюм|kostüm)\b/i,
    contexts: ["cosplay"],
  },
  {
    name: "beach",
    pattern: /\b(beach|sand|ocean|sea|coast|seashore|пляж|море|океан|strand|meer|playa)\b/i,
    contexts: ["beach", "at_beach"],
  },
  {
    name: "pool",
    pattern: /\b(pool|swimming pool|swimming|swim|бассейн|schwimmbad|piscina)\b/i,
    contexts: ["pool"],
  },
  {
    name: "car",
    pattern: /\b(car|driving|traffic|passenger|машина|машине|авто|тачка|auto|coche)\b/i,
    contexts: ["car"],
  },
  {
    name: "cooking",
    pattern:
      /\b(cooking|baking|in the kitchen|i(?:'m| am) making|готовлю|пеку|на кухне|ich koche|ich backe|estoy cocinando)\b/i,
    contexts: ["cooking", "food"],
  },
  {
    name: "bed",
    pattern:
      /\b(in bed|bedroom|sheets|blanket|pillow|sleeping|sleepy|bedtime|кровать|кровати|постел\w*|спать|bett|schlafen|cama|dormir)\b/i,
    contexts: ["bed", "bedroom", "relaxing"],
  },
  {
    name: "wearing",
    pattern:
      /\b(wearing|what (?:are you|r u|you) wearing|whatcha wearing|outfit|clothes|dress|skirt|bikini|pajamas|pj|pjs|corset|getting ready|getting dressed|что на тебе|наряд|одежда|платье|anziehen|kleid|ropa)\b/i,
    contexts: ["getting_ready", "outfit", "casual_selfie"],
  },
  {
    name: "home",
    pattern: /\b(home|at home|back home|finally home|zuhause|en casa)\b|дома|домой/i,
    contexts: ["at_home", "relaxing", "casual_selfie"],
  },
  {
    name: "shopping",
    pattern: /\b(shopping|mall|store|boutique|шоппинг|магазин|einkaufen|tienda|compras)\b/i,
    contexts: ["shopping", "going_out"],
  },
  {
    name: "sofa",
    pattern: /\b(sofa|couch|living room|диван|гостиная|wohnzimmer)\b/i,
    contexts: ["at_home", "relaxing", "sofa"],
  },
  {
    name: "shower",
    pattern: /\b(shower|showering|душ|душе|dusche|ducha)\b/i,
    contexts: ["shower", "flirty"],
  },
  {
    name: "morning_explicit",
    pattern:
      /\b(morning|wake up|woke up|waking up|good morning|morgen|guten morgen|aufgewacht|buenos d[ií]as|me despert[eé])\b|утро|доброе утро|проснулась/i,
    contexts: ["morning"],
  },
  {
    name: "night_explicit",
    pattern:
      /\b(good night|late night|вечер|ночь|спокойной ночи|gute nacht|abend|buenas noches|noche)\b/i,
    contexts: ["good_night", "night"],
  },
];

const AMY_QUESTION_ABOUT_USER =
  /\?|\b(?:what did you|did you|have you|are you (?:eating|having|doing)|was hast du|was essen sie|что ты|что у тебя)\b/i;

const NEGATION_REGEX =
  /\b(?:not|no|haven't|don't|didn't|won't|не|нет|nicht|kein|keine|no estoy)\b/i;

const AMY_CONFIRMATION_REGEX =
  /\b(?:yeah|yep|yes|mhm|sure|working out|sweating|exhausted|just got here|i am|totally|yess|yass)\b/i;

function isTopicNegated(text: string, pattern: RegExp): boolean {
  const match = pattern.exec(text);
  if (!match) return false;
  const before = text.slice(Math.max(0, match.index - 30), match.index);
  return (
    /\b(?:not|never|don'?t|didn'?t|won'?t|haven'?t|nicht|kein|keine|no\s+(?:estoy|está|voy))\s+(?:at\s+|in\s+|to\s+|on\s+|the\s+|zu\s+|im\s+|auf\s+|der\s+|en\s+|el\s+)*$|не\s+(?:в\s+|на\s+)?$/i.test(
      before,
    )
  );
}

function result(
  contexts: string[],
  source: MediaContextResult["source"],
  wantsLuna = false,
): MediaContextResult {
  const desiredContexts = [...new Set(contexts)].slice(0, 8);
  return {
    desiredContexts,
    wantsLuna,
    hasSpecificTopic: desiredContexts.some(isSpecificMediaTopic),
    source,
  };
}

function currentWantsAmyLuna(text: string): boolean {
  if (USER_OWNED_PET.test(text) && !LUNA_NAME.test(text) && !AMY_DOG.test(text)) return false;
  return LUNA_NAME.test(text) || AMY_DOG.test(text);
}

export function extractMediaContext(input: MediaContextInput): MediaContextResult {
  const current = input.currentMessage.trim();

  // Photo of the user's pet is a specific unmatched request, not Amy/Luna.
  if (PHOTO_OF_USER_PET.test(current)) {
    return result(["user_pet"], "user_pet", false);
  }

  // "show me your friend" / pic of another person: specific, no Amy selfie fallback.
  if (OTHER_PERSON.test(current) && !LUNA_NAME.test(current) && !AMY_DOG.test(current)) {
    return result(["other_person"], "other_person", false);
  }

  // Amy's Luna by name or "your dog". Generic "pet"/"my dog" is not Luna.
  if (currentWantsAmyLuna(current)) {
    return result(["luna"], "luna", true);
  }

  // User mentioned their own pet. That activity is not Amy's scene.
  const userPetAside = USER_OWNED_PET.test(current) && !PHOTO_OF_USER_PET.test(current);

  const explicitContexts: string[] = [];
  if (!userPetAside) {
    for (const matcher of TOPIC_MATCHERS) {
      if (matcher.name === "luna") continue;
      if (matcher.pattern.test(current) && !isTopicNegated(current, matcher.pattern)) {
        explicitContexts.push(...matcher.contexts);
      }
    }
  }
  if (explicitContexts.length > 0) {
    return result(explicitContexts, "explicit_topic", false);
  }

  const history = (input.history ?? []).slice(-MEDIA_CONTEXT_HISTORY_LIMIT);
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.sender !== "AMY") continue;
    if (AMY_QUESTION_ABOUT_USER.test(msg.text)) continue;

    if (LUNA_NAME.test(msg.text) && !isTopicNegated(msg.text, LUNA_NAME)) {
      return result(["luna"], "conversation_topic", true);
    }
    if (GENERIC_ANIMAL.test(msg.text) && /\b(?:my|the|our)\s+(?:dog|puppy|pet)\b/i.test(msg.text) && !USER_OWNED_PET.test(msg.text)) {
      return result(["luna"], "conversation_topic", true);
    }

    for (const matcher of TOPIC_MATCHERS) {
      if (matcher.name === "luna") continue;
      if (!matcher.pattern.test(msg.text) || isTopicNegated(msg.text, matcher.pattern)) continue;
      return result(matcher.contexts, "conversation_topic", false);
    }

    const prev = history[i - 1];
    if (prev?.sender === "USER") {
      const userAskedAmy = /\b(are you|r u|bist du|ты|you at|you in)\b/i.test(prev.text);
      const amyConfirmed = AMY_CONFIRMATION_REGEX.test(msg.text) && !NEGATION_REGEX.test(msg.text);
      if (userAskedAmy && amyConfirmed) {
        if (currentWantsAmyLuna(prev.text) || LUNA_NAME.test(prev.text)) {
          return result(["luna"], "conversation_topic", true);
        }
        for (const matcher of TOPIC_MATCHERS) {
          if (matcher.name === "luna") continue;
          if (matcher.pattern.test(prev.text)) {
            return result(matcher.contexts, "conversation_topic", false);
          }
        }
      }
    }
  }

  // No clock fallback. Timezone/now are accepted for callers but ignored here.
  void input.userTimezone;
  void input.now;
  return result(["casual_selfie", "at_home"], "generic_fallback", false);
}
