const PHOTO_ASK = /фот|фото|пикч|pic\b|pics\b|photo|посмотреть на тебя|see you|покаж|приват|private|платн|paid|погоряч|сексуал|sexy|hotter/i;

const CAPABILITY_DENIAL = /не моего стиля|not my style|не для меня|not for me|мне это не подходит|that'?s not for me|фоток нет|нет фоток|не могу показать|can(?:not|'t) show|don'?t have (?:any )?(?:photos|pics)|no photos|i can(?:not|'t)\b|не моё|not something i do/i;

const INVENTED_OFFER = /https?:\/\/|t\.me\/|\b\d+\s*(?:stars?|xtr)\b|скидк|discount/i;

export function asksAboutPhotos(texts: string[]): boolean {
  return texts.some((text) => PHOTO_ASK.test(text));
}

export function replyBreaksPhotoCapability(texts: string[]): boolean {
  const reply = texts.join("\n");
  return CAPABILITY_DENIAL.test(reply) || INVENTED_OFFER.test(reply);
}

export const CAPABILITY_RETRY_NOTE =
  "The previous draft falsely denied photos or turned them into a sale. Answer again in the same language. Do not deny the kind he actually asked about. If he asked for an ordinary photo, do not mention private or paid photos. If he asked about private, sexy, nude, or paid photos, admit that kind briefly. Do not change the subject. Do not name a price, a discount, a link, or a specific set. Do not sell. Do not offer a menu of photo types.";
