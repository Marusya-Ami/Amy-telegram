const STOP = new Set([
  "a",
  "an",
  "the",
  "my",
  "our",
  "with",
  "to",
  "at",
  "on",
  "in",
  "for",
  "and",
  "of",
  "really",
  "important",
  "very",
  "just",
  "about",
]);

export type EventCategory = "meeting" | "interview" | "exam" | "flight" | "date" | "meal";

export function contentTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((token) => token.length > 1 && !STOP.has(token));
}

export function eventCategory(title: string): EventCategory | null {
  const text = ` ${title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  if (/\sinterview\s/.test(text)) return "interview";
  if (/\s(exam|midterm|final)\s/.test(text)) return "exam";
  if (/\s(flight|fly)\s/.test(text)) return "flight";
  if (/\s(dinner|lunch|brunch)\s/.test(text)) return "meal";
  if (/\sdate\s/.test(text)) return "date";
  if (/\s(meet|meeting|appointment)\s/.test(text)) return "meeting";
  return null;
}

export function preferTitle(current: string, incoming: string): string {
  if (contentTokens(incoming).length > contentTokens(current).length) return incoming.trim();
  return current;
}

export function titlesReferToSameEvent(current: string, incoming: string, currentDate: string | null, incomingDate: string | null): boolean {
  const currentCategory = eventCategory(current);
  const incomingCategory = eventCategory(incoming);
  if (currentCategory && incomingCategory && currentCategory !== incomingCategory) return false;
  if (currentDate && incomingDate && currentDate !== incomingDate) return false;

  const currentCompanion = companion(current);
  const incomingCompanion = companion(incoming);
  if (currentCompanion && incomingCompanion && !sameCompanion(currentCompanion, incomingCompanion)) return false;

  const overlap = contentTokens(current).some((token) => contentTokens(incoming).includes(token));
  const sameCategory = currentCategory != null && currentCategory === incomingCategory;
  return overlap || sameCategory;
}

export function pickMatchingEvent<T extends { title: string; eventDate: string | null }>(
  existing: T[],
  incoming: { title: string; eventDate: string | null },
): T | null {
  return (
    existing.find((event) => titlesReferToSameEvent(event.title, incoming.title, event.eventDate, incoming.eventDate)) ??
    null
  );
}

function companion(title: string): string | null {
  const match = title.toLowerCase().match(/\bwith (?:my )?([a-z]+(?:\s+[a-z]+)?)/);
  return match?.[1] ?? null;
}

function sameCompanion(left: string, right: string): boolean {
  return left === right || left.includes(right) || right.includes(left);
}
