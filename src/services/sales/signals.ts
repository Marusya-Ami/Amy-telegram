import { capOrdinaryFlirt, emptySalesSignal, type SalesSignal } from "@/services/sales/schema";
import { extractMediaContext, type MediaContextMessage } from "@/services/media/context";

const DISTRESS = /\b(kill myself|killing myself|suicide|suicidal|want to die|wanna die|end my life|self[-\s]?harm|hurt myself|can'?t go on|in crisis|personal crisis|overdose)\b|хочу умереть|мне очень плохо/i;
const DECLINE = /\b(not buying|no thanks|don'?t want to (buy|pay)|do not want to (buy|pay)|not interested in (buying|paying))\b|не надо платить|не буду покупать/i;
const PURCHASE = /\b(how much|what does it cost|how much does it cost|price|how (?:do i|to) unlock)\b/i;
const PURCHASE_DE =
  /\b(?:was\s+kostet|wie\s*viel\s+kostet|wieviel|kostet\s+das|kann\s+ich\s+das\s+kaufen|freischalten|preis|kaufen|bezahlen)\b/i;
const PREMIUM =
  /\b(private|exclusive|premium)\s+(pic|pics|photo|photos|picture|pictures|content)\b|\b(private pics|premium content|anything hotter|something hotter|more private|something (?:a little )?more private|anything more private|do you sell (?:pics|photos|pictures))\b|\bgot anything hotter\b|\bsend nudes?\b|\bnudes?\s*(?:please)?\s*[.!?]*$/i;
const PREMIUM_RU =
  /(?:приватн\w*|эксклюзив\w*|премиум\w*).{0,32}(?:фото|фотк\w*|фоточк\w*)|(?:фото|фотк\w*|фоточк\w*).{0,32}(?:приватн\w*|эксклюзив\w*|премиум\w*)|погоряч|приватн\w*|скинь нюдс\w*|нюдс\w*/i;
const PREMIUM_ES =
  /m[aá]s privad|mas privad|m[aá]s caliente|foto(?:s)? privada(?:s)?|contenido privad|algo m[aá]s privad|vendes fotos/i;
const PREMIUM_DE =
  /\b(?:nackt|nacktbild\w*|nacktfoto\w*|porno\w*|wichs\w*|masturbier\w*)\b|\b(?:hei[ßs]+es|hei[ßs]+eres|privat(?:es|e)?|exklusiv(?:es|e)?)\s+(?:bild|bilder|foto|fotos)\b|\b(?:etwas|was)\s+(?:hei[ßs]+eres|privateres)\b|\bhast du (?:auch )?(?:hei[ßs]+ere|private|exklusive) (?:fotos|bilder)\b/i;
const PREMIUM_GARMENT =
  /\b(underwear|lingerie|h[oö]schen|unterw[aä]sche|dessous)\b|бель[её]|ropa interior/i;
const PREMIUM_GARMENT_ASK =
  /\b(?:send|show|see|gimme|give|hast du|zeig\w*|schick\w*|sende)\b|mu[eé]str|m[aá]nd|покаж|скинь|пришли|\b(?:pic|pics|photo|photos|picture|pictures|fotos?|bilder?|bild)\b/i;
const USER_OFFERING_MEDIA =
  /\b(?:do you want to see|want to see|can i (?:send|show)(?: you)?|let me show you|wanna see)\b.{0,30}\b(?:(?:picture|pic|photo) of me|me\b|my picture|my pic|my photo)\b|\b(?:i(?:'ll| will| can) send you|shall i send you)\b.{0,20}\b(?:a\s+)?(?:pic|photo|picture)\b|\blet me show you\b.{0,20}\b(?:a\s+)?(?:pic|photo|picture)\b|(?:willst du|m[oö]chtest du|kann ich dir|darf ich dir|lass mich dir|soll ich dir)\b.{0,30}\b(?:(?:ein\s+)?(?:bild|foto)\s+von\s+mir|mich\s+sehen|mein\s+(?:bild|foto)|meine\s+fotos)\b|хочешь (?:покажу|посмотреть|увидеть).{0,25}(?:себя|меня|мо[её] фото|мою фотку)|(?:quieres ver|te mando|puedo mandarte)\b.{0,30}\b(?:una foto m[ií]a|mi foto)/i;
const LUNA_PET = /\b(luna|dog|doggy|dogs|puppy|puppies|hund|hunde|h[uü]ndchen|welpe|welpen|пес|пёс|собака|собачка|щенок|perro|perrito)\b/i;
const EXPLICIT_MEDIA =
  /\b(send|show|gimme|give)\s+(me\s+)?(a\s+|another\s+|more\s+|some\s+|that\s+|your\s+)?(?:\w+\s+){0,3}(pic|pics|photo|photos|picture|pictures|selfie|selfies)\b|\b(?:can|could)\s+i\s+(?:see|get|have)\s+(?:a\s+|another\s+|more\s+|some\s+|your\s+)?(?:\w+\s+){0,3}(?:pic|pics|photo|photos|picture|pictures|selfie|selfies)\b|\b(?:can|could)\s+i\s+(?:see|get)\s+you\b|\b(?:show|let\s+me\s+see|can\s+i\s+see|could\s+i\s+see)\s+(?:me\s+)?(?:you|luna|your\s+dog|what\s+(?:you(?:'re|\s+are)\s+wearing|r\s+u\s+wearing)|(?:a\s+|the\s+|your\s+)?(?:coffee|breakfast|cosplay|outfit|gym|workout|beach|pool|car))\b|\b(another|more)\s+(pic|pics|photo|photos|picture|pictures)\b|(?:^|\b(?:please|hey|hi|hello|good\s+morning|good\s+night)\s*,?\s*)(?:show\s+me|let\s+me\s+see|can\s+i\s+see|lemme\s+see)(?:\s+(?:it|this|that|too|then|please))?\s*[.!?~]*$/i;
const VIDEO_ONLY =
  /\b(video|videos|clip|clips|reel|reels)\b|\bвидео\b|\bвидос\w*\b/i;
const PHOTO_NOUN =
  /\b(pic|pics|photo|photos|picture|pictures|selfie|selfies|foto|fotos|bild|bilder)\b|фотк|селфи/i;
const EXPLICIT_MEDIA_RU =
  /(?:покаж\w*|скинь|пришли|отправь).{0,24}(?:фотк\w*|фото|селфи|себя)|покаж\w*\s+себя|^\s*(?:покажи|дай посмотреть|скинь)\s*[.!?~]*$/i;
const EXPLICIT_MEDIA_ES =
  /m[aá]ndame una foto|env[ií]ame una foto|una foto tuya|puedo verte|^\s*(?:mu[eé]strame|a ver|d[eé]jame ver)\s*[.!?~]*$/i;
const EXPLICIT_MEDIA_DE =
  /\b(?:schick|schicke|sende|zeig|zeige)\s+(?:mir\s+)?(?:mal\s+)?(?:ein\s+|noch\s+ein\s+|ein\s+neues\s+)?(?:\w+\s+){0,2}(?:foto|fotos|bild|bilder|selfie)\b|\b(?:kann|k[oö]nnte)\s+ich\s+(?:mal\s+)?(?:ein\s+|noch\s+ein\s+)?(?:foto|fotos|bild|bilder|selfie)\b.{0,20}\bsehen\b|\b(?:kann|k[oö]nnte)\s+ich\s+(?:dich|luna|deinen\s+hund)\s+sehen\b|\bhast du ein (?:foto|bild)\b|^\s*(?:zeig(?:\s+mal)?|lass\s+sehen)\s*[.!?~]*$/i;
const WEARING = /\bwhat (?:are you|r u|you) wearing\b|\bwhatcha wearing\b/i;
const REACTION = /\b(love|loved|cute|nice)\b.{0,24}\b(pic|photo|picture)\b|\b(pic|photo|picture)\b.{0,24}\b(love|loved|cute|nice)\b/i;
const MILD_COMPLIMENT = /\b(you look beautiful|nice pic|^cute$|qué linda|que linda|te ves bonita|ты такая красив\w*|милая фотк\w*)\b/i;
const FLIRT = /\b(you(?:'| a)?re|you are)\s+(?:so\s+)?(pretty|beautiful|cute|hot|gorgeous)\b|\bi (?:like|love) you\b|\byou look (?:so )?(?:beautiful|hot)\b/i;
const STRONG_INTEREST =
  /^(?:damn|wow|more\??)$|\b(?:you look so hot|you(?:'| a)?re so hot|show me more|can i see more|something better|have something better)\b|damn\s*😍|wow\s*😍/i;
const STRONG_INTEREST_RU = /покажи ещё|покажи еще|есть ещё|есть еще|какая ты горяч|черт.{0,16}горяч/i;
const TIP =
  /\b(?:tip|donate|donation)\b|support you|send you (?:money|something)|leave you a tip|let me spoil you|чаев\w*|поддержать|задонатить|донат|propina|donaci[oó]n|apoyarte|enviarte dinero|mandarte dinero/i;
const FLIRT_BRIDGE = /flirt|hot|private|приват|погоряч|😏|🔥|😍|sexy|nude/i;

const NO_MONEY =
  /\b(?:no money|have no money|don'?t have (?:any )?(?:money|cash)|can'?t (?:pay|afford)|cannot (?:pay|afford)|i'?m broke|am broke|no cash|too expensive|out of money|low on cash)\b|нет денег|денег нет|не могу заплатить|нечем платить|я на мели|kein geld|hab kein geld|kann nicht zahlen|zu teuer|no tengo dinero|sin dinero|no puedo pagar/i;

const AMY_TIP_CONTEXT =
  /\b(?:you(?:'| a)?re (?:so |really )?(?:amazing|wonderful|stunning|incredible|the best|an angel|perfection)|sweetest girl|best girl|i (?:really )?adore you|you make me (?:so )?happy|you deserve the (?:world|best)|how can i (?:make you smile|make you happy|spoil you)|what can i do (?:for you|to make you (?:happy|smile))|what makes you happy|wanna make you smile|i (?:want|wanna) (?:to )?(?:make you happy|spoil you))\b|ты (?:такая |просто )?(?:прекрасная|невероятная|чудесная|замечательная|лучшая|ангел|красотка)|обожаю тебя|ты делаешь меня счастливым|как тебя (?:порадовать|осчастливить|побаловать)|что (?:я могу )?сделать для тебя|хочу тебя (?:порадовать|побаловать)|хочу сделать тебе приятное|eres (?:tan |la )?(?:increíble|maravillosa|hermosa|la mejor|un ángel)|te adoro|me haces (?:muy )?feliz|c[oó]mo puedo (?:hacerte sonre[ií]r|consentirte|mimarte)|qu[eé] puedo hacer por ti|quiero (?:hacerte feliz|consentirte|mimarte)|du bist (?:so |die )?(?:wunderbar|unglaublich|toll|die beste|ein engel)|ich bete dich an|du machst mich gl[uü]cklich|wie kann ich dich (?:zum l[aä]cheln bringen|verw[oö]hnen)|(?:ich )?(?:m[oö]chte|will) dich verw[oö]hnen|was kann ich f[uü]r dich tun/i;

export type SalesContextMessage = MediaContextMessage;

export type SalesContext = {
  recentFreePhoto?: boolean;
  recentTexts?: string[];
  history?: SalesContextMessage[];
  userTimezone?: string | null;
  now?: Date;
};

export function salesBridge(context: SalesContext = {}): boolean {
  if (context.recentFreePhoto) return true;
  return (context.recentTexts ?? []).some((line) => FLIRT_BRIDGE.test(line));
}

export type SignalReading = SalesSignal & {
  declinedNow: boolean;
  noMoney?: boolean;
  tipCandidate?: boolean;
};

export function readSalesSignal(userLines: string[], context: SalesContext = {}): SignalReading {
  const text = userLines.map((line) => line.trim()).filter(Boolean).join("\n");
  const base = emptySalesSignal();
  if (!text) return { ...base, confidence: 0.9, declinedNow: false };

  const distressed = DISTRESS.test(text);
  const declinedNow = DECLINE.test(text);
  const noMoney = NO_MONEY.test(text);
  const tipCandidate =
    !distressed &&
    !declinedNow &&
    !noMoney &&
    AMY_TIP_CONTEXT.test(text) &&
    !EXPLICIT_MEDIA.test(text) &&
    !EXPLICIT_MEDIA_DE.test(text);

  if (distressed) base.emotionalState = "DISTRESSED";

  if (USER_OFFERING_MEDIA.test(text)) {
    return finish(
      base,
      {
        mediaInterest: false,
        explicitMediaRequest: false,
        intent: "NONE",
        flirtLevel: 1,
        commercialReadiness: "LOW",
        confidence: 0.95,
        evidence: ["user offered their own photo"],
      },
      declinedNow,
    );
  }

  const bridge = salesBridge(context);
  const explicitPremium =
    PREMIUM.test(text) ||
    PREMIUM_RU.test(text) ||
    PREMIUM_ES.test(text) ||
    PREMIUM_DE.test(text) ||
    (PREMIUM_GARMENT.test(text) && PREMIUM_GARMENT_ASK.test(text));
  const contextualPremium =
    bridge &&
    (STRONG_INTEREST.test(text) ||
      STRONG_INTEREST_RU.test(text) ||
      /\bwhat else do you have\b/i.test(text) ||
      /\bsomething better\b/i.test(text));

  const purchaseMatch = PURCHASE.test(text) || PURCHASE_DE.test(text);
  if (
    purchaseMatch &&
    (explicitPremium || /\b(pic|pics|photo|photos|bild|bilder|foto|fotos|content|private|privat|freischalten|pack|set|das|es)\b/i.test(text) || bridge)
  ) {
    return finish(base, {
      mediaInterest: true,
      premiumInterest: true,
      intent: "PURCHASE_DISCUSSION",
      flirtLevel: 2,
      desiredContexts: ["private_photos", "flirty"],
      commercialReadiness: "HIGH",
      confidence: 0.93,
      evidence: ["asked what content costs"],
    }, declinedNow);
  }

  if (explicitPremium || contextualPremium) {
    return finish(base, {
      mediaInterest: true,
      premiumInterest: true,
      intent: "PREMIUM_MEDIA_REQUEST",
      flirtLevel: 3,
      desiredContexts: ["flirty", "private_photos", "shower"],
      commercialReadiness: "HIGH",
      confidence: explicitPremium ? 0.92 : 0.86,
      evidence: [explicitPremium ? "asked for private or premium photos" : "wanted more after a flirty photo"],
    }, declinedNow);
  }

  if (TIP.test(text)) {
    return finish(base, {
      intent: "TIP_DISCUSSION",
      flirtLevel: 1,
      commercialReadiness: "LOW",
      confidence: 0.93,
      evidence: ["asked how to tip or support"],
    }, declinedNow, { noMoney, tipCandidate: false });
  }

  if (AMY_TIP_CONTEXT.test(text) && !EXPLICIT_MEDIA.test(text) && !EXPLICIT_MEDIA_DE.test(text)) {
    return finish(
      base,
      {
        intent: "FLIRT",
        flirtLevel: 2,
        desiredContexts: ["flirty", "affectionate"],
        commercialReadiness: "LOW",
        confidence: 0.9,
        evidence: ["strong affection or compliment"],
      },
      declinedNow,
      { noMoney, tipCandidate },
    );
  }

  if (MILD_COMPLIMENT.test(text) && !EXPLICIT_MEDIA.test(text) && !EXPLICIT_MEDIA_DE.test(text)) {
    return finish(base, {
      intent: "FLIRT",
      flirtLevel: 1,
      commercialReadiness: "LOW",
      confidence: 0.9,
      evidence: ["ordinary compliment"],
    }, declinedNow, { noMoney, tipCandidate: false });
  }

  const wantsLuna = LUNA_PET.test(text);
  const videoOnly = VIDEO_ONLY.test(text) && !PHOTO_NOUN.test(text);
  if (
    !videoOnly &&
    (EXPLICIT_MEDIA.test(text) ||
      EXPLICIT_MEDIA_RU.test(text) ||
      EXPLICIT_MEDIA_ES.test(text) ||
      EXPLICIT_MEDIA_DE.test(text) ||
      /\b(?:show me more|can i see more)\b/i.test(text) ||
      (/\b(?:show|see|zeig|schick)\b/i.test(text) && wantsLuna))
  ) {
    const mediaContext = extractMediaContext({
      currentMessage: text,
      history: context.history,
      userTimezone: context.userTimezone,
      now: context.now,
    });
    return finish(base, {
      mediaInterest: true,
      explicitMediaRequest: true,
      intent: "MEDIA_REQUEST",
      flirtLevel: 2,
      desiredContexts: mediaContext.desiredContexts,
      commercialReadiness: "LOW",
      confidence: 0.9,
      evidence: [mediaContext.wantsLuna ? "asked for Luna or pet photo" : "asked for a photo"],
    }, declinedNow);
  }

  if (WEARING.test(text)) {
    const mediaContext = extractMediaContext({
      currentMessage: text,
      history: context.history,
      userTimezone: context.userTimezone,
      now: context.now,
    });
    return finish(base, {
      mediaInterest: true,
      intent: "FLIRT",
      flirtLevel: 3,
      desiredContexts: mediaContext.desiredContexts.length > 0 ? mediaContext.desiredContexts : ["getting_ready", "flirty"],
      commercialReadiness: "LOW",
      confidence: 0.88,
      evidence: ["asked what Amy is wearing"],
    }, declinedNow);
  }

  if (REACTION.test(text)) {
    return finish(base, {
      mediaInterest: true,
      intent: "REACTION_TO_MEDIA",
      flirtLevel: 2,
      desiredContexts: ["casual_selfie"],
      commercialReadiness: "LOW",
      confidence: 0.8,
      evidence: ["reacted to a photo"],
    }, declinedNow);
  }

  if (FLIRT.test(text)) {
    return finish(base, {
      intent: "FLIRT",
      flirtLevel: 2,
      desiredContexts: ["flirty"],
      commercialReadiness: "LOW",
      confidence: 0.86,
      evidence: ["ordinary compliment"],
    }, declinedNow);
  }

  if (declinedNow) {
    return finish(
      base,
      {
        confidence: 0.9,
        evidence: ["declined a purchase"],
      },
      true,
      { noMoney, tipCandidate: false },
    );
  }

  if (/^(hey|hi|hello)\b/i.test(text) || /\bhow (?:was|is) (?:work|your day)\b/i.test(text) || /\bhow are you\b/i.test(text)) {
    return finish(base, { confidence: 0.94, evidence: ["ordinary conversation"] }, false, { noMoney, tipCandidate: false });
  }

  return {
    ...base,
    declinedNow,
    noMoney,
    tipCandidate,
  };
}

function finish(
  base: SalesSignal,
  patch: Partial<SalesSignal>,
  declinedNow: boolean,
  extra?: { noMoney?: boolean; tipCandidate?: boolean },
): SignalReading {
  return {
    ...capOrdinaryFlirt({ ...base, ...patch }),
    declinedNow,
    noMoney: Boolean(extra?.noMoney),
    tipCandidate: Boolean(extra?.tipCandidate),
  };
}
